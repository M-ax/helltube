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
    const modes = [resonance(rate, 540, 2.5), resonance(rate, 970, 3), resonance(rate, 1640, 4)];
    const soften = 1 - Math.exp(-2 * Math.PI * 1050 / rate);
    const bassCut = 1 - Math.exp(-2 * Math.PI * 90 / rate);
    let low = 0, soft = 0, bass = 0;
    for (let i = 0; i < samples.length; i++) {
        // Rounded friction and broad glass resonances, without a sharp hiss or a periodic rasp.
        low += (noise() - low) * soften;
        soft += (low - soft) * soften;
        bass += (soft - bass) * bassCut;
        const body = soft - bass;
        const glass = modes[0](body) * .8 + modes[1](body) * .5 + modes[2](body) * .25;
        const t = i / rate;
        const pressure = .92 + .05 * Math.sin(t * 2 * Math.PI * 1.3) + .03 * Math.sin(t * 2 * Math.PI * 2.1);
        samples[i] = (body * .8 + glass * 1.8) * pressure;
    }
    const fade = Math.floor(rate * FINGER_SLIDE_LOOP_START);
    for (let i = 0; i < fade; i++) {
        const mix = i / fade;
        const end = samples.length - fade + i;
        samples[end] = samples[end] * (1 - mix) + samples[i] * mix;
    }
    return buffer;
}

// A tiny cluster of electrical ticks, kept separate from the smooth rubbing texture.
export function createFingerStaticBuffer(context) {
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(rate * .045), rate);
    const samples = buffer.getChannelData(0);
    const noise = noiseGenerator(307);
    let soft = 0;
    for (let i = 0; i < samples.length; i++) {
        const t = i / rate;
        const envelope = [[0, 1], [.007, .4], [.019, .18]].reduce((sum, [at, gain]) => {
            const age = t - at;
            return sum + (age >= 0 ? gain * Math.min(1, age / .0002) * Math.exp(-age * 1900) : 0);
        }, 0);
        soft += (noise() - soft) * (1 - Math.exp(-2 * Math.PI * 4800 / rate));
        samples[i] = soft * envelope * .65;
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
