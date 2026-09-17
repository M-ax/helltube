import {createFingerBuffer} from './finger-audio.js';

export function createReactionAudio() {
    let context;
    const sounds = {
        hitmarker: {url: '/sounds/mw2-hitmarker.mp3', gain: 0.65},
        metalpipe: {url: '/sounds/metal-pipe.mp3', gain: 1},
        flashbangBounce: {url: '/sounds/csgo-flashbang-bounce.mp3', gain: .7},
        flashbangRing: {url: '/sounds/csgo-flashbang-ring.mp3', gain: .5},
        bidenThing: {url: '/sounds/biden-you-know-the-thing.mp3', gain: .8},
        bidenWord: {url: '/sounds/biden-one-word.mp3', gain: .8},
    };
    let destroyed = false;
    const sources = new Set();
    const slides = new Map();
    let slideBuffer;

    function unlock() {
        if (destroyed) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            context ||= new AudioContext();
            sounds.fingertap ||= {buffer: createFingerBuffer(context), gain: .8};
            slideBuffer ||= createFingerBuffer(context, true);
            if (context.state === 'suspended') void context.resume().catch(() => {});
            for (const sound of Object.values(sounds)) {
                if (!sound.url) continue;
                sound.loading ||= fetch(sound.url).then(response => {
                    if (!response.ok) throw new Error('Reaction sound unavailable');
                    return response.arrayBuffer();
                }).then(bytes => context.decodeAudioData(bytes)).then(decoded => { sound.buffer = decoded; })
                    .catch(() => { sound.loading = null; });
            }
        } catch { /* A blocked audio device must never interrupt the player. */ }
    }

    function stop() {
        for (const source of sources) source.stop();
        sources.clear();
        slides.clear();
    }

    return {
        unlock,
        stop,
        slide(id, volume, speed) {
            let slide = slides.get(id);
            const level = Math.min(1, Math.max(0, speed)) * Math.min(1, Math.max(0, volume)) * .42;
            if (!level || destroyed || context?.state !== 'running') {
                if (slide) {
                    slide.gain.gain.setTargetAtTime(0, context.currentTime, .008);
                    slide.source.stop(context.currentTime + .035);
                    slides.delete(id);
                }
                return;
            }
            if (!slide) {
                if (!slideBuffer || sources.size >= 8) return;
                const source = context.createBufferSource();
                const gain = context.createGain();
                source.buffer = slideBuffer;
                source.loop = true;
                source.loopStart = .015;
                gain.gain.value = 0;
                source.connect(gain).connect(context.destination);
                sources.add(source);
                slide = {source, gain};
                slides.set(id, slide);
                source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
                source.start();
            }
            slide.gain.gain.setTargetAtTime(level, context.currentTime, .012);
            slide.source.playbackRate.setTargetAtTime(.8 + speed * .4, context.currentTime, .025);
        },
        play(volume, kind = 'hitmarker') {
            const sound = sounds[kind];
            if (destroyed || !sound?.buffer || context?.state !== 'running' || volume <= 0 || sources.size >= 8) return;
            const source = context.createBufferSource();
            const gain = context.createGain();
            gain.gain.value = Math.min(1, volume) * sound.gain;
            source.buffer = sound.buffer;
            source.connect(gain).connect(context.destination);
            sources.add(source);
            source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
            source.start();
            return () => { if (sources.has(source)) source.stop(); };
        },
        destroy() {
            destroyed = true;
            stop();
            void context?.close().catch(() => {});
        },
    };
}
