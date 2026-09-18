import test from 'node:test';
import assert from 'node:assert/strict';
import {createFingerBuffer, createFingerStaticBuffer, fingerStaticPops, FINGER_SLIDE_LOOP_START} from '../src/lib/finger-audio.js';

function context(sampleRate) {
    return {sampleRate, createBuffer(channels, length, rate) {
        const data = new Float32Array(length);
        return {duration: length / rate, getChannelData: () => data};
    }};
}

test('glass rubbing emphasizes bright resonance without hiss or loop clicks at common sample rates', () => {
    for (const rate of [44100, 48000]) {
        const buffer = createFingerBuffer(context(rate), true);
        const data = buffer.getChannelData(0);
        let energy = 0, difference = 0, peak = 0, low = 0, lowEnergy = 0;
        const lowPass = 1 - Math.exp(-2 * Math.PI * 600 / rate);
        for (let i = 1; i < data.length; i++) {
            assert.ok(Number.isFinite(data[i]));
            energy += data[i] ** 2;
            difference += (data[i] - data[i - 1]) ** 2;
            peak = Math.max(peak, Math.abs(data[i]));
            low += (data[i] - low) * lowPass;
            lowEnergy += low * low;
        }
        const rms = Math.sqrt(energy / data.length);
        assert.ok(rms > .02 && rms < .2, `Audible but restrained friction, RMS ${rms}`);
        assert.ok(peak < .9, 'The generated texture cannot clip.');
        assert.ok(lowEnergy / energy < .12, 'Higher glass resonances dominate the low, wind-like wash.');
        assert.ok(difference / energy > .05 && difference / energy < .45, 'The texture is bright without broadband scratchy hiss.');
        const typicalStep = Math.sqrt(difference / data.length);
        assert.ok(Math.abs(data.at(-1) - data[Math.floor(rate * FINGER_SLIDE_LOOP_START)]) < typicalStep * 4, 'Looping introduces no click.');
    }
});

test('static is a short, quiet transient separate from the tap and rubbing loop', () => {
    const ctx = context(48000);
    const buffer = createFingerStaticBuffer(ctx);
    const data = buffer.getChannelData(0);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    assert.ok(buffer.duration < .07);
    assert.ok(rms > .005 && rms < .06);
    assert.ok(Math.abs(data.at(-1)) < .0001);
    assert.equal(createFingerBuffer(ctx).duration, .105, 'Click taps retain their existing sound.');
});

test('each static patch gets a fast, varied cluster and shared seeds reproduce the same sound', () => {
    const patterns = Array.from({length: 32}, (_, i) => fingerStaticPops(`patch-${i}`));
    assert.ok(new Set(patterns.map(pops => pops.length)).size >= 4, 'Pop counts vary between patches.');
    for (const pops of patterns) {
        assert.ok(pops.length >= 5 && pops.length <= 11);
        const gaps = pops.slice(1).map((pop, i) => pop.at - pops[i].at);
        assert.ok(gaps.every(gap => gap >= .0008 && gap <= .0053), 'Pops form rapid clusters.');
        assert.ok(new Set(gaps.map(gap => gap.toFixed(5))).size > 2, 'Spacing is irregular within each cluster.');
        assert.ok(new Set(pops.map(pop => pop.gain.toFixed(3))).size > 2, 'Each pop has its own volume.');
    }
    const patches = [{strength: 1, offset: 0}, {strength: .5, offset: .016}];
    const ctx = context(48000);
    const a = createFingerStaticBuffer(ctx, 'shared-event', patches);
    const b = createFingerStaticBuffer(ctx, 'shared-event', patches);
    const next = createFingerStaticBuffer(ctx, 'next-event', patches);
    assert.deepEqual(a.getChannelData(0), b.getChannelData(0));
    assert.notDeepEqual(a.getChannelData(0), next.getChannelData(0));
    assert.ok(fingerStaticPops('shared-event', patches).length >= 10, 'Every patch contributes a cluster.');
    const many = createFingerStaticBuffer(ctx, 'fast-sweep', Array.from({length: 24}, (_, i) => ({strength: 1, offset: i / 600})));
    assert.ok(many.getChannelData(0).every(value => Number.isFinite(value) && Math.abs(value) < 1), 'A fast sweep stays below clipping.');
});
