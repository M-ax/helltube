export function createReactionAudio() {
    let context;
    const sounds = {
        hitmarker: {url: '/sounds/mw2-hitmarker.mp3', gain: 0.65},
        metalpipe: {url: '/sounds/metal-pipe.mp3', gain: 1},
    };
    let destroyed = false;
    const sources = new Set();

    function unlock() {
        if (destroyed) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            context ||= new AudioContext();
            if (context.state === 'suspended') void context.resume().catch(() => {});
            for (const sound of Object.values(sounds)) {
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
    }

    return {
        unlock,
        stop,
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
        },
        destroy() {
            destroyed = true;
            stop();
            void context?.close().catch(() => {});
        },
    };
}
