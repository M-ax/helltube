// Only grant the next frame after the generator accepts this one. There is no
// canvas copy and no unbounded IPC or VideoFrame queue.
export class NativeVideoTrack {
    constructor(bridge, onEnded) {
        this.bridge = bridge; this.onEnded = onEnded;
        this.id = crypto.randomUUID(); this.closed = false;
    }
    async start(options) {
        if (typeof MediaStreamTrackGenerator !== 'function' || typeof VideoFrame !== 'function') {
            throw new Error('This runtime cannot accept native video frames. Select Chromium compatibility.');
        }
        this.track = new MediaStreamTrackGenerator({kind: 'video'});
        this.writer = this.track.writable.getWriter();
        this.unsubscribeFrames = this.bridge.onVideoFrame(async frame => {
            if (this.closed || frame.id !== this.id) return;
            let video;
            try {
                video = new VideoFrame(frame.pixels, {format: 'BGRX', codedWidth: frame.width, codedHeight: frame.height,
                    timestamp: frame.timestamp, colorSpace: {primaries: 'bt709', transfer: 'iec61966-2-1', matrix: 'rgb', fullRange: true}});
                await this.writer.write(video);
            } catch (error) {
                if (!this.closed) { this.stop(); this.onEnded('Native video delivery failed: ' + error.message); }
            } finally { video?.close(); }
        });
        this.unsubscribeEvents = this.bridge.onEvent(event => {
            if (!this.closed && event.type === 'video-ended' && event.id === this.id) {
                this.stop(); this.onEnded(event.message);
            }
        });
        try {
            const result = await this.bridge.startVideo({...options, sessionId: this.id});
            if (this.closed) throw new Error('Capture cancelled.');
            this.backend = result.backend;
            return new MediaStream([this.track]);
        } catch (error) { this.stop(); throw error; }
    }
    stop() {
        if (this.closed) return;
        this.closed = true;
        this.unsubscribeFrames?.(); this.unsubscribeEvents?.();
        this.track?.stop();
        void this.writer?.abort().catch(() => {});
        void this.bridge.stopVideo(this.id);
    }
}
