// 200 ms bounded queue. Silence during underrun, discard stale PCM during
// overload, and re-prime after idle applications resume. No unbounded latency.
export class PcmQueue {
    constructor(capacity = 9600) {
        this.capacity = capacity; this.data = new Float32Array(capacity * 2);
        this.read = 0; this.size = 0; this.primed = false;
    }
    push(bytes) {
        const samples = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const frames = Math.floor(bytes.byteLength / 4);
        for (let frame = 0; frame < frames; frame++) {
            if (this.size === this.capacity) { this.read = (this.read + 1) % this.capacity; this.size--; }
            const write = ((this.read + this.size) % this.capacity) * 2;
            this.data[write] = samples.getInt16(frame * 4, true) / 32768;
            this.data[write + 1] = samples.getInt16(frame * 4 + 2, true) / 32768;
            this.size++;
        }
    }
    pull(left, right) {
        left.fill(0); right.fill(0);
        if (!this.primed && this.size < 1920) return;
        this.primed = true;
        const count = Math.min(left.length, this.size);
        for (let index = 0; index < count; index++) {
            left[index] = this.data[this.read * 2]; right[index] = this.data[this.read * 2 + 1];
            this.read = (this.read + 1) % this.capacity;
        }
        this.size -= count;
        if (count < left.length) this.primed = false;
    }
}
if (typeof registerProcessor === 'function') {
    class NativePcm extends AudioWorkletProcessor {
        constructor() {
            super(); this.queue = new PcmQueue();
            this.port.onmessage = event => this.queue.push(event.data);
        }
        process(_inputs, outputs) {
            this.queue.pull(outputs[0][0], outputs[0][1]);
            return true;
        }
    }
    registerProcessor('native-pcm', NativePcm);
}
