export function createReactionAudio() {
    let context;
    let buffer;
    let loading;
    let destroyed = false;
    const sources = new Set();

    function unlock() {
        if (destroyed) return;
        try {
            const AudioContext = window.AudioContext || window.webkitAudioContext;
            if (!AudioContext) return;
            context ||= new AudioContext();
            if (context.state === 'suspended') void context.resume().catch(() => {});
            loading ||= fetch('/sounds/mw2-hitmarker.mp3').then(response => {
                if (!response.ok) throw new Error('Reaction sound unavailable');
                return response.arrayBuffer();
            }).then(bytes => context.decodeAudioData(bytes)).then(decoded => { buffer = decoded; }).catch(() => { loading = null; });
        } catch { /* A blocked audio device must never interrupt the player. */ }
    }

    return {
        unlock,
        play(volume) {
            if (destroyed || !buffer || context?.state !== 'running' || volume <= 0 || sources.size >= 8) return;
            const source = context.createBufferSource();
            const gain = context.createGain();
            gain.gain.value = Math.min(1, volume) * 0.65;
            source.buffer = buffer;
            source.connect(gain).connect(context.destination);
            sources.add(source);
            source.onended = () => { sources.delete(source); source.disconnect(); gain.disconnect(); };
            source.start();
        },
        destroy() {
            destroyed = true;
            for (const source of sources) source.stop();
            sources.clear();
            void context?.close().catch(() => {});
        },
    };
}
