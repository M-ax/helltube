export const MEDIA_REACTION_LIFETIME_MS = 5000;
export const BASS_BOOST_OUTPUT_GAIN = .14;

// The distortion happens before attenuation. Even a fully clipped sample is
// capped at 14% of full scale, then reduced again by the viewer's volume.
export function createBassBoost(context, source, destination = context.destination) {
    const dry = context.createGain();
    const bass = context.createBiquadFilter();
    const distortion = context.createWaveShaper();
    const output = context.createGain();
    bass.type = 'lowshelf';
    bass.frequency.value = 180;
    bass.gain.value = 18;
    // Overdrive the entire signal, then hard-clip and crush its amplitude steps.
    // The shelf makes bass hit the clipper harder without sparing mids or highs.
    distortion.curve = Float32Array.from({length: 4097}, (_, index) => {
        const driven = (index / 2048 - 1) * 64;
        const clipped = Math.max(-1, Math.min(1, driven));
        return Math.round(clipped * 16) / 16;
    });
    output.gain.value = 0;
    dry.connect(destination);
    bass.connect(distortion).connect(output).connect(destination);
    source.connect(dry);
    source.connect(bass);
    source.disconnect(destination);
    let active = false;
    let level = 0;
    return {
        set(enabled, volume) {
            const next = enabled ? BASS_BOOST_OUTPUT_GAIN * Math.min(1, Math.max(0, volume)) : 0;
            if (active === enabled && level === next) return;
            active = enabled;
            level = next;
            // Short fades avoid clicks when an effect starts, ends, or is muted.
            dry.gain.setTargetAtTime(enabled ? 0 : 1, context.currentTime, .012);
            output.gain.setTargetAtTime(next, context.currentTime, .012);
        },
        destroy() {
            source.disconnect(dry);
            source.disconnect(bass);
            for (const node of [dry, bass, distortion, output]) node.disconnect();
        },
    };
}

// Share the player's existing media source with visualizations. Retrying after
// a gesture supports browsers that initially block Web Audio.
export function processBassBoost(node, initial) {
    let options = initial;
    function apply(gesture = false) {
        void options.analysis?.bassBoost(node, options.enabled && !document.hidden, gesture).catch(() => {});
    }
    const gesture = () => apply(true);
    const volume = () => apply();
    node.addEventListener('volumechange', volume);
    document.addEventListener('pointerdown', gesture);
    document.addEventListener('keydown', gesture);
    document.addEventListener('visibilitychange', volume);
    apply();
    return {
        update(next) { options = next; apply(); },
        destroy() {
            node.removeEventListener('volumechange', volume);
            document.removeEventListener('pointerdown', gesture);
            document.removeEventListener('keydown', gesture);
            document.removeEventListener('visibilitychange', volume);
            options.analysis?.release(node);
        },
    };
}
