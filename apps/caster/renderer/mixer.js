import workletUrl from './pcm-worklet.js?url';

const dbGain = db => 10 ** (Math.max(-60, Math.min(12, Number(db) || 0)) / 20);

export class AudioMixer {
    constructor(bridge, onEnded = () => {}) {
        this.bridge = bridge; this.onEnded = onEnded; this.channels = new Map(); this.closed = false;
    }
    async start(sources, {master = 0, compressor = true, microphone = {}} = {}) {
        this.context = new AudioContext({sampleRate: 48000, latencyHint: 'interactive'});
        try {
            if (this.context.sampleRate !== 48000) throw new Error('The audio engine could not use the required 48 kHz sample rate.');
            await this.context.audioWorklet.addModule(workletUrl);
            if (this.closed) throw new Error('Capture cancelled.');
            this.output = this.context.createMediaStreamDestination();
            this.master = this.context.createGain();
            this.protection = this.context.createDynamicsCompressor();
            this.protection.threshold.value = -3; this.protection.knee.value = 0;
            this.protection.ratio.value = 20; this.protection.attack.value = 0.003; this.protection.release.value = 0.15;
            this.meter = this.context.createAnalyser(); this.meter.fftSize = 512;
            this.master.connect(this.protection); this.protection.connect(this.meter); this.meter.connect(this.output);
            this.setMaster(master, compressor);
            this.unsubscribe = this.bridge.onEvent(message => {
                const channel = this.channels.get(message.id);
                if (message.type === 'audio-data' && channel && !this.closed) channel.source.port.postMessage(message.samples);
                if (message.type === 'audio-ended' && channel && !this.closed) this.onEnded(message.id, message.message);
            });
            for (const selected of sources) {
                if (this.closed) throw new Error('Capture cancelled.');
                let source, stream;
                if (selected.kind === 'microphone') {
                    stream = await navigator.mediaDevices.getUserMedia({video: false, audio: {
                        deviceId: {exact: selected.deviceId}, channelCount: 2, sampleRate: 48000,
                        echoCancellation: microphone.echoCancellation !== false,
                        noiseSuppression: microphone.noiseSuppression !== false,
                        autoGainControl: microphone.autoGainControl === true,
                    }});
                    if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error('Capture cancelled.'); }
                    source = this.context.createMediaStreamSource(stream);
                    stream.getAudioTracks()[0].addEventListener('ended', () => {
                        if (!this.closed) this.onEnded(selected.id, 'This microphone was disconnected.');
                    });
                } else source = new AudioWorkletNode(this.context, 'native-pcm', {numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2]});
                const gain = this.context.createGain(), pan = this.context.createStereoPanner(), delay = this.context.createDelay(0.5);
                const meter = this.context.createAnalyser(); meter.fftSize = 512;
                source.connect(gain); gain.connect(pan); pan.connect(delay); delay.connect(meter); meter.connect(this.master);
                this.channels.set(selected.id, {source, stream, gain, pan, delay, meter, kind: selected.kind});
                if (selected.kind !== 'microphone') await this.bridge.startAudio(selected.id);
            }
            this.update(sources);
            await this.context.resume();
            if (this.closed) throw new Error('Capture cancelled.');
            return this.output.stream.getAudioTracks()[0];
        } catch (error) { this.stop(); throw error; }
    }
    update(sources) {
        const solo = sources.some(source => source.solo);
        for (const settings of sources) {
            const channel = this.channels.get(settings.id);
            if (!channel || this.closed) continue;
            const now = this.context.currentTime;
            channel.gain.gain.setTargetAtTime(settings.muted || (solo && !settings.solo) ? 0 : dbGain(settings.gain), now, 0.01);
            channel.pan.pan.setTargetAtTime(Math.max(-1, Math.min(1, Number(settings.pan) || 0)), now, 0.01);
            channel.delay.delayTime.setTargetAtTime(Math.max(0, Math.min(500, Number(settings.delay) || 0)) / 1000, now, 0.01);
        }
    }
    setMaster(gain, compressor) {
        if (!this.master || this.closed) return;
        this.master.gain.setTargetAtTime(dbGain(gain), this.context.currentTime, 0.01);
        this.protection.ratio.value = compressor ? 20 : 1;
    }
    levels() {
        const level = meter => {
            const samples = new Float32Array(meter.fftSize); meter.getFloatTimeDomainData(samples);
            const peak = samples.reduce((max, sample) => Math.max(max, Math.abs(sample)), 0);
            return Math.max(-60, 20 * Math.log10(peak || 0.001));
        };
        return Object.fromEntries([...this.channels].map(([id, channel]) => [id, level(channel.meter)])
            .concat(this.meter ? [['master', level(this.meter)]] : []));
    }
    stop() {
        if (this.closed) return;
        this.closed = true; this.unsubscribe?.();
        for (const [id, channel] of this.channels) {
            channel.stream?.getTracks().forEach(track => track.stop());
            if (channel.kind !== 'microphone') void this.bridge.stopAudio(id);
            channel.source.disconnect(); channel.source.port?.close();
        }
        this.channels.clear();
        this.output?.stream.getTracks().forEach(track => track.stop());
        void this.context?.close();
    }
}
