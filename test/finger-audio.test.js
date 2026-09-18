import test from 'node:test';
import assert from 'node:assert/strict';
import {createFingerBuffer, createFingerStaticBuffer, FINGER_SLIDE_LOOP_START} from '../src/lib/finger-audio.js';

function context(sampleRate) {
    return {sampleRate, createBuffer(channels, length, rate) {
        const data = new Float32Array(length);
        return {duration: length / rate, getChannelData: () => data};
    }};
}

test('glass rubbing is soft, has no sharp loop seam, and works at common device sample rates', () => {
    for (const rate of [44100, 48000]) {
        const buffer = createFingerBuffer(context(rate), true);
        const data = buffer.getChannelData(0);
        let energy = 0, difference = 0, peak = 0;
        for (let i = 1; i < data.length; i++) {
            assert.ok(Number.isFinite(data[i]));
            energy += data[i] ** 2;
            difference += (data[i] - data[i - 1]) ** 2;
            peak = Math.max(peak, Math.abs(data[i]));
        }
        const rms = Math.sqrt(energy / data.length);
        assert.ok(rms > .02 && rms < .2, `Audible but restrained friction, RMS ${rms}`);
        assert.ok(peak < .9, 'The generated texture cannot clip.');
        assert.ok(difference / energy < .06, 'Friction energy is concentrated below the harsh, scratchy frequencies.');
        assert.ok(Math.abs(data.at(-1) - data[Math.floor(rate * FINGER_SLIDE_LOOP_START)]) < .04, 'Looping introduces no click.');
    }
});

test('static is a short, quiet transient separate from the tap and rubbing loop', () => {
    const ctx = context(48000);
    const buffer = createFingerStaticBuffer(ctx);
    const data = buffer.getChannelData(0);
    const rms = Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
    assert.ok(buffer.duration < .05);
    assert.ok(rms > .005 && rms < .06);
    assert.ok(Math.abs(data.at(-1)) < .0001);
    assert.equal(createFingerBuffer(ctx).duration, .105, 'Click taps retain their existing sound.');
});
