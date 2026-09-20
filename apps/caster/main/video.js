import {execFile, spawn} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const bound = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : fallback));
export function nativeCaptureOptions({quality = {}, region, showCursor = true} = {}) {
    return {
        width: Math.round(bound(quality?.width, 1280, 320, 1920)) & ~1,
        height: Math.round(bound(quality?.height, 720, 180, 1080)) & ~1,
        frameRate: Math.round(bound(quality?.frameRate, 30, 10, 60)),
        region: {x: bound(region?.x, 0, 0, .99), y: bound(region?.y, 0, 0, .99),
            width: bound(region?.width, 1, .01, 1), height: bound(region?.height, 1, .01, 1)},
        showCursor: showCursor !== false,
    };
}

// Fill a fixed header and one bounded BGRX image once, avoiding repeated copies
// of a multi-megabyte frame as chunks arrive from the helper's stdout pipe.
export class NativeFrameDecoder {
    constructor(onFrame, {width = 1920, height = 1080} = {}) {
        Object.assign(this, {onFrame, width, height});
        this.header = Buffer.alloc(32); this.offset = 0; this.payload = null;
        this.sequence = 0; this.timestamp = -1;
    }
    push(bytes) {
        let position = 0;
        while (position < bytes.length) {
            const target = this.payload || this.header;
            const count = Math.min(target.length - this.offset, bytes.length - position);
            bytes.copy(target, this.offset, position, position + count);
            position += count; this.offset += count;
            if (this.offset !== target.length) continue;
            this.offset = 0;
            if (!this.payload) {
                const width = this.header.readUInt32LE(4), height = this.header.readUInt32LE(8);
                const size = this.header.readUInt32LE(12), sequence = this.header.readUInt32LE(16);
                const timestamp = Number(this.header.readBigUInt64LE(24));
                if (this.header.readUInt32LE(0) !== 0x31564348 || width < 2 || height < 2 ||
                    width > this.width || height > this.height || size !== width * height * 4 ||
                    sequence <= this.sequence || timestamp < this.timestamp || !Number.isSafeInteger(timestamp)) {
                    throw new Error('Invalid frame from the native capture helper.');
                }
                this.frame = {width, height, sequence, timestamp};
                this.sequence = sequence; this.timestamp = timestamp;
                this.payload = Buffer.allocUnsafe(size);
            } else {
                const frame = {...this.frame, pixels: this.payload};
                this.payload = null; this.frame = null;
                this.onFrame(frame);
            }
        }
    }
}

export class NativeVideo {
    constructor({helper, emit, spawnProcess = spawn, runProcess = run}) {
        Object.assign(this, {helper, emit, spawnProcess, runProcess});
        this.sources = new Map(); this.capture = null; this.generation = 0;
    }
    async list(kind) {
        const generation = ++this.generation;
        const {stdout} = await this.runProcess(this.helper, ['list', kind === 'window' ? 'window' : 'screen'],
            {windowsHide: true, timeout: 8000, maxBuffer: 8 * 1024 * 1024});
        const sources = JSON.parse(stdout);
        if (!Array.isArray(sources)) throw new Error('Could not enumerate native capture sources.');
        if (generation === this.generation) this.sources = new Map(sources.map(source => [source.id, source]));
        return sources;
    }
    start(value = {}) {
        if (this.capture) throw new Error('Stop the current capture before starting another.');
        const source = this.sources.get(value.sourceId);
        if (!source) throw new Error('Refresh and select an available native capture source.');
        if (typeof value.sessionId !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.sessionId)) throw new Error('Invalid capture session.');
        const options = nativeCaptureOptions(value), region = options.region;
        const args = ['capture', source.kind, source.kind === 'window' ? source.handle : source.device,
            String(source.pid || 0), String(options.width), String(options.height), String(options.frameRate),
            ...[region.x, region.y, region.width, region.height].map(String), options.showCursor ? '1' : '0'];
        const child = this.spawnProcess(this.helper, args, {windowsHide: true, stdio: ['pipe', 'pipe', 'pipe']});
        const capture = {child, id: value.sessionId, pending: null, diagnostic: ''};
        this.capture = capture;
        return new Promise((resolve, reject) => {
            let settled = false;
            const fail = message => {
                if (this.capture !== capture) return;
                capture.diagnostic = message;
                this.stop();
                this.emit({type: 'video-ended', id: capture.id, message});
            };
            const timer = setTimeout(() => fail('Native capture did not deliver a frame. Restore the selected window and retry preview.'), 12000);
            capture.cancel = () => {
                clearTimeout(timer);
                if (!settled) { settled = true; reject(new Error(capture.diagnostic || 'Native capture stopped before the first frame.')); }
            };
            const decoder = new NativeFrameDecoder(frame => {
                if (this.capture !== capture) return;
                if (capture.pending !== null) throw new Error('The native helper exceeded its frame allowance.');
                capture.pending = frame.sequence;
                this.emit({type: 'video-frame', id: capture.id, ...frame});
                if (!settled) {
                    settled = true; clearTimeout(timer);
                    resolve({id: capture.id, backend: source.kind === 'window' ? 'Native WGC · independent cursor' : 'Native DXGI',
                        width: frame.width, height: frame.height});
                }
            }, options);
            child.stdout.on('data', bytes => {
                if (this.capture !== capture) return;
                try { decoder.push(bytes); }
                catch (error) { fail(error.message); }
            });
            child.stderr.on('data', bytes => { capture.diagnostic = (capture.diagnostic + bytes.toString()).slice(0, 600).trim(); });
            child.on('error', () => fail('The native video helper could not start. Reinstall Helltube Caster.'));
            child.on('exit', () => fail(capture.diagnostic || 'The selected capture source closed or became unavailable. Restart preview.'));
            child.stdin.on('error', () => fail('The native video helper disconnected.'));
            child.stdin.write('n');
        });
    }
    acknowledge(id, sequence) {
        const capture = this.capture;
        if (!capture || capture.id !== id || capture.pending !== sequence || capture.pending === null) return;
        capture.pending = null;
        capture.child.stdin.write('n');
    }
    stop(id) {
        const capture = this.capture;
        if (!capture || (id && capture.id !== id)) return;
        this.capture = null;
        capture.cancel?.();
        capture.child.stdin.end(); capture.child.kill();
    }
}
