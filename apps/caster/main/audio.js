import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';
import {access} from 'node:fs/promises';
import {release} from 'node:os';

const run = promisify(execFile);
const execOptions = {windowsHide: true, timeout: 8000, maxBuffer: 2 * 1024 * 1024};
export function pulseSources(inputs, sinks) {
    const outputs = new Map(sinks.map(sink => [sink.index, sink]));
    return [
        ...inputs.filter(input => outputs.has(input.sink)).map(input => ({
            id: `pulse:${input.index}`, kind: 'application', label: input.properties?.['application.name'] || input.name || `Audio stream ${input.index}`,
            detail: input.properties?.['media.name'] || '', pid: input.properties?.['application.process.id'],
            index: input.index, device: outputs.get(input.sink).monitor_source || `${outputs.get(input.sink).name}.monitor`,
        })),
        ...sinks.map(sink => ({id: `output:${sink.index}`, kind: 'system', label: sink.description || sink.name,
            device: sink.monitor_source || `${sink.name}.monitor`})),
    ];
}

export class NativeAudio {
    constructor({helper, emit, platform = process.platform, ownPid = process.pid}) {
        Object.assign(this, {helper, emit, platform, ownPid});
        this.captures = new Map(); this.epoch = 0;
    }
    async list() {
        try {
            if (this.platform === 'win32') {
                if (Number(release().split('.')[2]) < 20348) throw new Error('Application audio requires Windows build 20348 or later (Windows 11 recommended).');
                await access(this.helper).catch(() => { throw new Error('Native audio helper is missing. Run npm run caster:build-native.'); });
                const {stdout} = await run(this.helper, ['list'], execOptions);
                return {sources: [...JSON.parse(stdout).filter(source => source.pid !== this.ownPid && !/^(electron|helltube caster)\.exe$/i.test(source.label)),
                    {id: 'system', kind: 'system', label: 'All desktop audio', detail: 'Excludes Helltube Caster'}], backend: 'Windows WASAPI', error: ''};
            }
            if (this.platform === 'linux') {
                const [inputs, sinks] = await Promise.all(['sink-inputs', 'sinks'].map(type => run('pactl', ['--format=json', 'list', type], execOptions)));
                await run('parec', ['--version'], execOptions);
                return {sources: pulseSources(JSON.parse(inputs.stdout), JSON.parse(sinks.stdout)), backend: 'PulseAudio / PipeWire', error: ''};
            }
            throw new Error('Native audio is supported on Windows and Linux.');
        } catch (error) {
            return {sources: [], backend: this.platform, error: this.platform === 'linux'
                ? 'Application audio needs pactl and parec (pulseaudio-utils), plus PulseAudio or pipewire-pulse. Check that your audio service is running.'
                : error.message};
        }
    }
    async start(id) {
        if (this.captures.has(id)) throw new Error('This audio source is already captured.');
        if (this.captures.size >= 16) throw new Error('Select at most 16 native audio sources.');
        const epoch = this.epoch;
        const {sources, error} = await this.list();
        if (epoch !== this.epoch) throw new Error('Audio capture was cancelled.');
        // Concurrent IPC requests may have completed enumeration in the meantime.
        if (this.captures.has(id)) throw new Error('This audio source is already captured.');
        if (this.captures.size >= 16) throw new Error('Select at most 16 native audio sources.');
        const source = sources.find(source => source.id === id);
        if (!source) throw new Error(error || 'That application has stopped playing or closed. Refresh audio sources.');
        // Do not silently widen an application selection into system audio.
        if ([...this.captures.values()].some(capture => capture.kind === 'system' || source.kind === 'system')) {
            throw new Error('Use either individual applications or one desktop output to avoid duplicate audio.');
        }
        const args = this.platform === 'win32'
            ? ['capture', String(source.pid || this.ownPid), source.kind === 'system' ? 'exclude' : 'include']
            : ['--raw', '--format=s16le', '--rate=48000', '--channels=2', '--latency-msec=20',
                `--device=${source.device}`, ...(source.kind === 'application' ? [`--monitor-stream=${source.index}`] : [])];
        const child = spawn(this.platform === 'win32' ? this.helper : 'parec', args, {
            windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
            env: {...process.env, PULSE_PROP: 'application.name=Helltube-Caster'},
        });
        const capture = {child, kind: source.kind, sequence: 0, pending: new Set(), tail: Buffer.alloc(0)};
        this.captures.set(id, capture);
        return new Promise((resolve, reject) => {
            let settled = false;
            const ready = () => { if (!settled) { settled = true; clearTimeout(timer); resolve({id}); } };
            const failed = message => {
                clearTimeout(timer);
                if (!settled) { settled = true; reject(new Error(message)); }
                if (this.captures.get(id) === capture) {
                    this.stop(id); this.emit({type: 'audio-ended', id, message});
                }
            };
            const timer = setTimeout(() => failed('Audio capture did not start. Check the selected application and output device.'), 12000);
            child.on('error', () => failed('The native audio capture helper could not start.'));
            child.on('exit', () => failed('This audio source ended. Refresh sources and start a new preview to reconnect it.'));
            child.stderr.on('data', data => {
                if (data.toString().includes('READY')) ready();
                // Native diagnostic text stays out of the renderer. Failure gets a bounded message.
            });
            if (this.platform === 'linux') child.once('spawn', () => setTimeout(() => {
                if (this.captures.get(id) === capture) ready();
            }, 300));
            child.stdout.on('data', data => {
                if (this.captures.get(id) !== capture) return;
                ready();
                let bytes = Buffer.concat([capture.tail, data]);
                const packetBytes = 3840; // 20 ms, stereo s16le at 48 kHz.
                for (let offset = 0; offset + packetBytes <= bytes.length; offset += packetBytes) {
                    // Bound IPC latency/memory when the UI is suspended or overloaded.
                    if (capture.pending.size >= 4) continue;
                    const sequence = ++capture.sequence;
                    capture.pending.add(sequence);
                    this.emit({type: 'audio-data', id, sequence, samples: bytes.subarray(offset, offset + packetBytes)});
                }
                capture.tail = Buffer.from(bytes.subarray(bytes.length - bytes.length % packetBytes));
            });
            capture.cancel = () => { clearTimeout(timer); if (!settled) { settled = true; reject(new Error('Audio capture was cancelled.')); } };
        });
    }
    acknowledge(id, sequence) { this.captures.get(id)?.pending.delete(sequence); }
    stop(id) {
        const capture = this.captures.get(id);
        if (!capture) return;
        this.captures.delete(id); capture.cancel?.();
        capture.child.stdin.end(); capture.child.kill();
    }
    stopAll() { this.epoch++; for (const id of this.captures.keys()) this.stop(id); }
}
