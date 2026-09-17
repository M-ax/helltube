// Short hollow plastic impact with a brighter, quickly damped glass resonance.
// Procedural buffers keep this interaction available without waiting for a download.
export function createFingerBuffer(context, slide = false) {
    const rate = context.sampleRate;
    const buffer = context.createBuffer(1, Math.ceil(rate * (slide ? 1 : .105)), rate);
    const samples = buffer.getChannelData(0);
    let seed = 761;
    let smooth = 0;
    for (let i = 0; i < samples.length; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) | 0;
        const noise = (seed >>> 0) / 2147483648 - 1;
        smooth += (noise - smooth) * .14;
        const t = i / rate;
        if (slide) {
            const texture = .65 + .2 * Math.sin(t * Math.PI * 2 * 37) + .15 * Math.sin(t * Math.PI * 2 * 83);
            samples[i] = ((noise - smooth) * .15 + smooth * .7) * texture
                + Math.sin(t * Math.PI * 2 * 1730 + smooth * 3) * .025;
        } else {
            const attack = Math.min(1, t / .0004);
            samples[i] = attack * ((noise - smooth) * .42 * Math.exp(-t * 650)
                + Math.sin(t * Math.PI * 2 * 780) * .38 * Math.exp(-t * 95)
                + Math.sin(t * Math.PI * 2 * 1830) * .24 * Math.exp(-t * 135)
                + Math.sin(t * Math.PI * 2 * 3460) * .12 * Math.exp(-t * 210));
        }
    }
    if (slide) {
        const fade = Math.floor(rate * .015);
        for (let i = 0; i < fade; i++) {
            const mix = i / fade;
            const end = samples.length - fade + i;
            samples[end] = samples[end] * (1 - mix) + samples[i] * mix;
        }
    }
    return buffer;
}
