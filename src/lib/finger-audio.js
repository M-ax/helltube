export const FINGER_SLIDE_LOOP_START = .08;

function noiseGenerator(seed) {
    return () => {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        return (seed >>> 0) / 2147483648 - 1;
    };
}

function resonance(rate, frequency, q) {
    const angle = 2 * Math.PI * frequency / rate;
    const alpha = Math.sin(angle) / (2 * q);
    const b = alpha / (1 + alpha);
    const a1 = -2 * Math.cos(angle) / (1 + alpha);
    const a2 = (1 - alpha) / (1 + alpha);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    return x => {
        const y = b * (x - x2) - a1 * y1 - a2 * y2;
        x2 = x1; x1 = x; y2 = y1; y1 = y;
        return y;
    };
}

function createGlassRub(context) {
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(rate * 3), rate);
    const samples = buffer.getChannelData(0);
    const noise = noiseGenerator(761);
    const modes = [resonance(rate, 1870, 22), resonance(rate, 2830, 28), resonance(rate, 4120, 35)];
    const soften = 1 - Math.exp(-2 * Math.PI * 4800 / rate);
    const bassCut = 1 - Math.exp(-2 * Math.PI * 900 / rate);
    let low = 0, soft = 0, bass = 0;
    for (let i = 0; i < samples.length; i++) {
        // Friction excites narrow, bright glass modes; very little raw noise reaches the output.
        low += (noise() - low) * soften;
        soft += (low - soft) * soften;
        bass += (soft - bass) * bassCut;
        const body = soft - bass;
        const glass = modes[0](body) * 2.8 + modes[1](body) * 2 + modes[2](body) * 1.1;
        const t = i / rate;
        const pressure = .92 + .05 * Math.sin(t * 2 * Math.PI * 1.3) + .03 * Math.sin(t * 2 * Math.PI * 2.1);
        samples[i] = (body * .025 + glass * 1.8) * pressure;
    }
    const fade = Math.floor(rate * FINGER_SLIDE_LOOP_START);
    for (let i = 0; i < fade; i++) {
        const mix = i / fade;
        const end = samples.length - fade + i;
        samples[end] = samples[end] * (1 - mix) + samples[i] * mix;
    }
    return buffer;
}

// One shared event seed produces the same irregular clusters on every viewer's device.
export function fingerStaticPops(seed = 'static', clusters = [{strength: 1, offset: 0}]) {
    let hash = 2166136261;
    for (const char of String(seed)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const noise = noiseGenerator(hash);
    const random = () => (noise() + 1) / 2;
    const pops = [];
    const level = .65 / Math.sqrt(Math.max(1, clusters.length));
    for (const {strength, offset} of clusters) {
        const count = 5 + Math.floor(random() * 7);
        let at = offset + random() * .0015;
        for (let i = 0; i < count; i++) {
            pops.push({at, gain: level * strength * (.3 + random() * .7), decay: 1500 + random() * 1400,
                cutoff: 3600 + random() * 2400, seed: Math.floor(random() * 4294967296)});
            // Uneven, tightly packed doublets and short pauses replace the repeated three-tick sample.
            at += .0008 + random() ** 1.5 * .0045;
        }
    }
    return pops;
}

// Each newly discharged patch has its own brief cluster, with the original soft electrical timbre.
export function createFingerStaticBuffer(context, seed, clusters) {
    const rate = context.sampleRate;
    const pops = fingerStaticPops(seed, clusters);
    const duration = Math.max(.01, ...pops.map(pop => pop.at + .01));
    const buffer = context.createBuffer(1, Math.ceil(rate * duration), rate);
    const samples = buffer.getChannelData(0);
    for (const pop of pops) {
        const noise = noiseGenerator(pop.seed);
        const soften = 1 - Math.exp(-2 * Math.PI * pop.cutoff / rate);
        const start = Math.floor(pop.at * rate);
        const end = Math.min(samples.length, start + Math.ceil(rate * .01));
        let soft = 0;
        for (let i = start; i < end; i++) {
            const age = (i - start) / rate;
            const envelope = Math.min(1, age / .0002) * Math.exp(-age * pop.decay);
            soft += (noise() - soft) * soften;
            samples[i] += soft * envelope * pop.gain;
        }
    }
    return buffer;
}

// Short hollow plastic impact with a brighter, quickly damped glass resonance.
// Procedural buffers keep this interaction available without waiting for a download.
export function createFingerBuffer(context, slide = false) {
    if (slide) return createGlassRub(context);
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(rate * .105), rate);
    const samples = buffer.getChannelData(0);
    let seed = 761;
    let smooth = 0;
    for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const noise = (seed >>> 0) / 2147483648 - 1;
        smooth += (noise - smooth) * .14;
        const t = i / rate;
        const attack = Math.min(1, t / .0004);
        samples[i] = attack * ((noise - smooth) * .42 * Math.exp(-t * 650)
            + Math.sin(t * Math.PI * 2 * 780) * .38 * Math.exp(-t * 95)
            + Math.sin(t * Math.PI * 2 * 1830) * .24 * Math.exp(-t * 135)
            + Math.sin(t * Math.PI * 2 * 3460) * .12 * Math.exp(-t * 210));
    }
    return buffer;
}
