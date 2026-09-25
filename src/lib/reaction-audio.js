import {createFingerBuffer, createFingerStaticBuffer, FINGER_SLIDE_LOOP_START} from './finger-audio.js';
import {BIDEN_SOUNDS} from './biden.js';

export function createReactionAudio() {
    let context;
    const sounds = {
        hitmarker: {url: '/sounds/mw2-hitmarker.mp3', gain: 0.65},
        metalpipe: {url: '/sounds/metal-pipe.mp3', gain: 1},
        mlg: {url: '/sounds/intervention.mp3', gain: .8},
        jpeg: {url: '/sounds/hank-jpeg.mp3', gain: 1.6},
        flashbangBounce: {url: '/sounds/csgo-flashbang-bounce.mp3', gain: .7},
        flashbangRing: {url: '/sounds/csgo-flashbang-ring.mp3', gain: .5},
        ...Object.fromEntries(Object.entries(BIDEN_SOUNDS).map(([kind, url]) => [kind, {url, gain: .8}])),
        fingertap: {gain: .8},
        fingerstatic: {gain: .4},
    };
    let destroyed = false;
    const sources = new Set();
    const slides = new Map();
    let slideBuffer;
    let sprayBuffer;
    let sprayLoop;
    let generation = 0;
    const controller = new AbortController();

    function unlock() {
        if (destroyed) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            context ||= new AudioContext();
            if (context.state === 'suspended') void context.resume().catch(() => {});
        } catch { /* A blocked audio device must never interrupt the player. */ }
    }

    function prepare(kind) {
        const sound = sounds[kind];
        if (destroyed || !context || !sound?.url || sound.buffer) return Promise.resolve();
        // Unlocking audio is cheap; downloading and decoding waits for this reaction.
        sound.loading ||= fetch(sound.url, {signal: controller.signal}).then(response => {
            if (!response.ok) throw new Error('Reaction sound unavailable');
            return response.arrayBuffer();
        }).then(bytes => destroyed ? null : context.decodeAudioData(bytes)).then(decoded => {
            if (!destroyed) sound.buffer = decoded;
        }).catch(() => { sound.loading = null; });
        return sound.loading;
    }

    function stop() {
        generation++;
        for (const source of sources) source.stop();
        sources.clear();
        slides.clear();
        sprayLoop = null;
    }

    return {
        unlock,
        prepare,
        stop,
        spray(volume) {
            const level = Math.min(1, Math.max(0, volume)) * .22;
            if (!level || destroyed || context?.state !== 'running') {
                if (sprayLoop) { sprayLoop.source.stop(); sprayLoop = null; }
                return;
            }
            if (!sprayLoop) {
                if (sources.size >= 8) return;
                if (!sprayBuffer) {
                    sprayBuffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
                    const data = sprayBuffer.getChannelData(0);
                    let previous = 0;
                    for (let i = 0; i < data.length; i++) {
                        const noise = Math.random() * 2 - 1;
                        data[i] = (noise - previous) * .4;
                        previous = noise;
                    }
                }
                const source = context.createBufferSource(), gain = context.createGain();
                source.buffer = sprayBuffer; source.loop = true; gain.gain.value = 0;
                source.connect(gain).connect(context.destination);
                sources.add(source);
                source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
                source.start();
                sprayLoop = {source, gain};
            }
            sprayLoop.gain.gain.setTargetAtTime(level, context.currentTime, .02);
        },
        slide(id, volume, speed) {
            let slide = slides.get(id);
            const level = Math.sqrt(Math.min(1, Math.max(0, speed))) * Math.min(1, Math.max(0, volume)) * .36;
            if (!level || destroyed || context?.state !== 'running') {
                if (slide) {
                    slide.gain.gain.setTargetAtTime(0, context.currentTime, .02);
                    slide.source.stop(context.currentTime + .1);
                    slides.delete(id);
                }
                return;
            }
            if (!slide) {
                if (sources.size >= 8) return;
                slideBuffer ||= createFingerBuffer(context, true);
                const source = context.createBufferSource();
                const gain = context.createGain();
                source.buffer = slideBuffer;
                source.loop = true;
                source.loopStart = FINGER_SLIDE_LOOP_START;
                gain.gain.value = 0;
                source.connect(gain).connect(context.destination);
                sources.add(source);
                slide = {source, gain};
                slides.set(id, slide);
                source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
                source.start();
            }
            slide.gain.gain.setTargetAtTime(level, context.currentTime, .04);
            slide.source.playbackRate.setTargetAtTime(.96 + speed * .08, context.currentTime, .08);
        },
        play(volume, kind = 'hitmarker', options = {}) {
            const sound = sounds[kind];
            if (destroyed || !sound || context?.state !== 'running' || volume <= 0 || sources.size >= 8) return;
            let source;
            let cancelled = false;
            const started = Date.now();
            const playbackGeneration = generation;
            const start = () => {
                if (cancelled || destroyed || playbackGeneration !== generation || globalThis.document?.hidden
                    || context.state !== 'running' || sources.size >= 8 || Date.now() - started > 150) return;
                if (kind === 'fingertap') sound.buffer ||= createFingerBuffer(context);
                const buffer = kind === 'fingerstatic'
                    ? createFingerStaticBuffer(context, options.seed, options.clusters) : sound.buffer;
                if (!buffer) return;
                source = context.createBufferSource();
                const gain = context.createGain();
                gain.gain.value = Math.min(1, volume) * sound.gain;
                source.buffer = buffer;
                source.connect(gain).connect(context.destination);
                sources.add(source);
                source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
                source.start(0, Math.max(0, Math.min(buffer.duration - .01, options.offset || 0)));
            };
            if (sound.url && !sound.buffer) void prepare(kind).then(start);
            else start();
            // Callers can cancel even while the first sound is still loading.
            return () => { cancelled = true; if (sources.has(source)) source.stop(); };
        },
        destroy() {
            destroyed = true;
            controller.abort();
            stop();
            void context?.close().catch(() => {});
        },
    };
}
