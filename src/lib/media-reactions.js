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
    let wacko;
    let active = false;
    let level = 0;
    return {
        set(enabled, volume) {
            const mode = enabled === 'wacko';
            if (mode) wacko ||= createWacko(context, source, destination);
            wacko?.set(mode, volume);
            const next = enabled && !mode ? BASS_BOOST_OUTPUT_GAIN * Math.min(1, Math.max(0, volume)) : 0;
            if (active === enabled && level === next) return;
            active = enabled;
            level = next;
            // Short fades avoid clicks when an effect starts, ends, or is muted.
            dry.gain.setTargetAtTime(enabled ? 0 : 1, context.currentTime, .012);
            output.gain.setTargetAtTime(next, context.currentTime, .012);
        },
        destroy() {
            wacko?.destroy();
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
        void options.analysis?.bassBoost(node, options.enabled && !document.hidden, gesture, options.wacko && !document.hidden).catch(() => {});
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

// A modulated delay bends pitch continuously, with ring modulation and soft
// saturation for the familiar rubbery content-aware meme sound.
export function createWacko(context, source, destination = context.destination) {
    const delay = context.createDelay(.1);
    const lfo = context.createOscillator();
    const depth = context.createGain();
    const ring = context.createGain();
    const carrier = context.createOscillator();
    const ringDepth = context.createGain();
    const shaper = context.createWaveShaper();
    const output = context.createGain();
    delay.delayTime.value = .03;
    lfo.frequency.value = 5.3;
    depth.gain.value = .023;
    ring.gain.value = .65;
    carrier.frequency.value = 31;
    ringDepth.gain.value = .35;
    shaper.curve = Float32Array.from({length: 2049}, (_, i) => Math.tanh((i / 1024 - 1) * 2));
    output.gain.value = 0;
    lfo.connect(depth).connect(delay.delayTime);
    carrier.connect(ringDepth).connect(ring.gain);
    source.connect(delay).connect(ring).connect(shaper).connect(output).connect(destination);
    lfo.start(); carrier.start();
    return {
        set(enabled, volume) { output.gain.setTargetAtTime(enabled ? .55 * Math.min(1, Math.max(0, volume)) : 0, context.currentTime, .015); },
        destroy() {
            lfo.stop(); carrier.stop(); source.disconnect(delay);
            for (const node of [delay, lfo, depth, ring, carrier, ringDepth, shaper, output]) node.disconnect();
        },
    };
}
