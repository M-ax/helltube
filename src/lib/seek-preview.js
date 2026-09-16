export function containsTime(ranges, time) {
    if (!ranges || !Number.isFinite(time) || time < 0) return false;
    for (let index = 0; index < ranges.length; index++) {
        if (time >= ranges.start(index) && time < ranges.end(index)) return true;
    }
    return false;
}

function fragmentKey(frag) {
    return `${frag.cc}/${frag.level}/${frag.sn}`;
}

export class PreviewSegments {
    constructor(maxBytes = 32 * 1024 * 1024) {
        this.maxBytes = maxBytes;
        this.clear();
    }

    clear() {
        this.entries = new Map();
        this.bytes = 0;
    }

    append({frag, data, offset}) {
        if (!frag || typeof frag.sn !== 'number' || !data?.byteLength) return;
        const key = fragmentKey(frag);
        let entry = this.entries.get(key);
        if (!entry || entry.complete) {
            if (entry) this.remove(key);
            entry = {key, chunks: [], bytes: 0, complete: false};
            this.entries.set(key, entry);
        }
        entry.chunks.push({data: data.slice(), offset: Number.isFinite(offset) ? offset : 0});
        entry.bytes += data.byteLength;
        this.bytes += data.byteLength;
        while (this.bytes > this.maxBytes) this.remove(this.entries.keys().next().value);
    }

    complete(frag) {
        const entry = this.entries.get(fragmentKey(frag));
        if (!entry) return;
        const timing = frag.elementaryStreams?.video;
        entry.start = timing?.startPTS ?? frag.startPTS ?? frag.start;
        entry.end = timing?.endPTS ?? frag.endPTS ?? frag.start + frag.duration;
        entry.complete = true;
    }

    remove(key) {
        this.bytes -= this.entries.get(key)?.bytes || 0;
        this.entries.delete(key);
    }

    prune(ranges, position) {
        for (const [key, entry] of this.entries) {
            if (!entry.complete) continue;
            let overlaps = false;
            for (let index = 0; index < ranges.length; index++) {
                if (entry.end > ranges.start(index) && entry.start < ranges.end(index)) overlaps = true;
            }
            if (!overlaps || entry.end < position - 32 || entry.start > position + 32) this.remove(key);
        }
    }

    find(time, ranges) {
        if (!containsTime(ranges, time)) return null;
        return [...this.entries.values()].find(entry => entry.complete && time >= entry.start && time < entry.end) || null;
    }
}

export function createSeekPreview(hls, events, video, onFrame) {
    const cache = new PreviewSegments();
    let initSegment;
    let initOriginal;
    let mime;
    let target = null;
    let decoder;
    let destroyed = false;
    const image = document.createElement('canvas');
    const context = image.getContext('2d');
    const MediaSourceClass = window.MediaSource || window.ManagedMediaSource;

    function closeDecoder() {
        const previous = decoder;
        decoder = null;
        if (!previous) return;
        clearTimeout(previous.timeout);
        previous.video.removeAttribute('src');
        previous.video.load();
        URL.revokeObjectURL(previous.url);
    }

    function clear() {
        const wasActive = target !== null || decoder;
        target = null;
        if (wasActive) onFrame(null);
        closeDecoder();
    }

    function reset() {
        clear();
        cache.clear();
        initSegment = initOriginal = mime = null;
    }

    function seekDecoder() {
        const current = decoder;
        if (!current?.ready || target === null || !containsTime(current.video.buffered, target)) return;
        try {
            if (current.requested === target) return;
            current.requested = target;
            current.video.currentTime = target;
        } catch { clear(); }
    }

    function request(time) {
        if (destroyed) return;
        if (!Number.isFinite(time) || time < 0 || !initSegment || !context) {
            clear();
            return;
        }
        const entry = cache.find(time, video.buffered);
        if (!entry) {
            clear();
            return;
        }
        if (time !== target) onFrame(null);
        target = time;
        if (decoder?.entry === entry) {
            seekDecoder();
            return;
        }
        closeDecoder();
        try {
            const source = new MediaSourceClass();
            const preview = document.createElement('video');
            preview.muted = true;
            preview.playsInline = true;
            preview.disableRemotePlayback = true;
            preview.preload = 'auto';
            const current = {entry, video: preview, url: URL.createObjectURL(source), ready: false};
            decoder = current;
            const fail = () => { if (decoder === current) clear(); };
            current.timeout = setTimeout(fail, 3000);
            preview.addEventListener('error', fail);
            preview.addEventListener('loadedmetadata', seekDecoder);
            preview.addEventListener('loadeddata', seekDecoder);
            preview.addEventListener('seeked', () => {
                if (decoder !== current || target === null || current.requested !== target || preview.seeking ||
                    preview.readyState < 2 || !containsTime(video.buffered, target) ||
                    Math.abs(preview.currentTime - target) > 0.05) return;
                try {
                    const scale = Math.min(1, 960 / preview.videoWidth, 540 / preview.videoHeight);
                    image.width = Math.max(1, Math.round(preview.videoWidth * scale));
                    image.height = Math.max(1, Math.round(preview.videoHeight * scale));
                    context.drawImage(preview, 0, 0, image.width, image.height);
                    clearTimeout(current.timeout);
                    onFrame(image, target);
                } catch { fail(); }
            });
            source.addEventListener('sourceopen', () => {
                if (decoder !== current) return;
                try {
                    const buffer = source.addSourceBuffer(mime);
                    const chunks = [{data: initSegment, offset: 0}, ...entry.chunks];
                    let index = 0;
                    const append = () => {
                        if (decoder !== current) return;
                        try {
                            if (index < chunks.length) {
                                const chunk = chunks[index++];
                                buffer.timestampOffset = chunk.offset;
                                buffer.appendBuffer(chunk.data);
                            } else {
                                buffer.removeEventListener('updateend', append);
                                current.ready = true;
                                source.endOfStream();
                                seekDecoder();
                            }
                        } catch { fail(); }
                    };
                    buffer.addEventListener('error', fail);
                    buffer.addEventListener('updateend', append);
                    append();
                } catch { fail(); }
            }, {once: true});
            preview.src = current.url;
        } catch { clear(); }
    }

    function codecs(_event, tracks) {
        if (!tracks.video) return;
        reset();
        const track = tracks.video;
        const type = `${track.container}; codecs="${track.codec}"`;
        if (!MediaSourceClass?.isTypeSupported(type) || !track.initSegment?.byteLength) return;
        mime = type;
        initOriginal = track.initSegment;
        initSegment = initOriginal.slice();
    }

    function appending(_event, data) {
        if (mime && data.type === 'video' && data.data !== initOriginal) cache.append(data);
    }

    function prune() {
        cache.prune(video.buffered, video.currentTime);
        if (target !== null && !cache.find(target, video.buffered)) clear();
    }

    function buffered(_event, {frag}) {
        cache.complete(frag);
        prune();
    }

    const listeners = [[events.BUFFER_CODECS, codecs], [events.BUFFER_APPENDING, appending],
        [events.FRAG_BUFFERED, buffered], [events.BUFFER_FLUSHED, prune], [events.BUFFER_RESET, reset],
        [events.MEDIA_DETACHING, reset]];
    for (const [event, callback] of listeners) hls.on(event, callback);
    video.addEventListener('timeupdate', prune);
    return {
        request,
        clear,
        destroy() {
            destroyed = true;
            for (const [event, callback] of listeners) hls.off(event, callback);
            video.removeEventListener('timeupdate', prune);
            reset();
        },
    };
}