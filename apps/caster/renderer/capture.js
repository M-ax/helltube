import {cropRectangle, normalizeDesktopQuality} from '../../../shared/desktop-quality.js';
import {AudioMixer} from './mixer.js';
import {NativeVideoTrack} from './native-video.js';

export class Capture {
    constructor(bridge, onEnded, onAudioEnded) {
        Object.assign(this, {bridge, onEnded, onAudioEnded}); this.closed = false;
    }
    async start({sourceId, region, quality, audioSources, audioSettings, captureBackend = 'native', showCursor = true}) {
        const settings = normalizeDesktopQuality(quality);
        try {
            if (this.bridge.platform === 'win32' && captureBackend === 'native') {
                this.native = new NativeVideoTrack(this.bridge, message => { this.stop(); this.onEnded(message); });
                this.stream = await this.native.start({sourceId, region, quality: settings, showCursor});
                this.backend = this.native.backend;
            } else {
                await this.startChromium(sourceId, region, settings);
                this.backend = 'Chromium capture';
            }
            if (this.closed) throw new Error('Capture cancelled.');
            this.stream.getVideoTracks()[0].contentHint = settings.contentHint;
            if (audioSources.length) {
                this.mixer = new AudioMixer(this.bridge, this.onAudioEnded);
                const track = await this.mixer.start(audioSources, audioSettings);
                this.stream.addTrack(track);
            }
            if (this.closed) throw new Error('Capture cancelled.');
            return this.stream;
        } catch (error) { this.stop(); throw error; }
    }
    async startChromium(sourceId, region, settings) {
        await this.bridge.armCapture(sourceId);
        if (this.closed) throw new Error('Capture cancelled.');
        // Bound frames before they reach the renderer. A region needs enough
        // source pixels for its output, but max-only bounds never upscale it.
        const area = cropRectangle(region, 10000, 10000);
        this.raw = await navigator.mediaDevices.getDisplayMedia({video: {
            width: {max: Math.ceil(settings.width * 10000 / area.width)},
            height: {max: Math.ceil(settings.height * 10000 / area.height)},
            frameRate: {ideal: settings.frameRate, max: settings.frameRate},
        }, audio: false});
        if (this.closed) { this.raw.getTracks().forEach(track => track.stop()); throw new Error('Capture cancelled.'); }
        const original = this.raw.getVideoTracks()[0];
        original.addEventListener('ended', () => { this.stop(); this.onEnded(); }, {once: true});
        // Monitor/window sharing uses the native track directly: no second
        // video element, GPU readback/canvas copy, or repeating draw timer.
        this.stream = new MediaStream([original]);
        if (region) {
            this.video = document.createElement('video');
            this.video.muted = true; this.video.playsInline = true; this.video.srcObject = this.raw;
            await this.video.play();
            if (this.closed) throw new Error('Capture cancelled.');
            this.canvas = document.createElement('canvas');
            const context = this.canvas.getContext('2d', {alpha: false});
            if (!context) throw new Error('Could not create the region preview.');
            this.stream = this.canvas.captureStream(0);
            const output = this.stream.getVideoTracks()[0];
            const draw = () => {
                if (this.closed) return;
                const crop = cropRectangle(region, this.video.videoWidth, this.video.videoHeight);
                const scale = Math.min(1, settings.width / crop.width, settings.height / crop.height);
                const width = Math.max(2, Math.floor(crop.width * scale / 2) * 2);
                const height = Math.max(2, Math.floor(crop.height * scale / 2) * 2);
                if (this.canvas.width !== width) this.canvas.width = width;
                if (this.canvas.height !== height) this.canvas.height = height;
                context.drawImage(this.video, crop.x, crop.y, crop.width, crop.height, 0, 0, width, height);
                output.requestFrame();
                // Redraw only when capture delivers a new frame. Static
                // desktops no longer incur unconditional canvas redraws.
                this.frameCallback = this.video.requestVideoFrameCallback(draw);
            };
            draw();
        }
    }
    stop() {
        if (this.closed) return;
        this.closed = true;
        if (this.frameCallback !== undefined) this.video.cancelVideoFrameCallback(this.frameCallback);
        this.mixer?.stop();
        this.native?.stop();
        this.raw?.getTracks().forEach(track => track.stop());
        this.stream?.getTracks().forEach(track => track.stop());
        if (this.video) { this.video.pause(); this.video.srcObject = null; }
        void this.bridge.stopCapture();
    }
}
