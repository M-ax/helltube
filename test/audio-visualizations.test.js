import test from 'node:test';
import assert from 'node:assert/strict';
import {createAudioAnalysis, createVisualization, clonePreset} from '../src/lib/audio-visualizations.js';
import {presetModule} from '../scripts/milkdrop-presets.mjs';
import {securityHeaders} from '../shared/deployment.js';

test('all bundled MilkDrop equations are compiled at build time under the existing strict script policy', async () => {
    const presets = {};
    for (const name of ['base', 'extra', 'extra2', 'md1']) {
        const {default: pack} = await import(`data:text/javascript;base64,${Buffer.from(presetModule(name)).toString('base64')}`);
        Object.assign(presets, pack);
    }
    assert.equal(Object.keys(presets).length, 395);
    for (const preset of Object.values(presets)) {
        assert.equal(typeof preset.init_eqs, 'function');
        assert.equal(typeof preset.frame_eqs, 'function');
        const clone = clonePreset(preset);
        assert.equal(clone.init_eqs, preset.init_eqs);
        assert.notEqual(clone.shapes, preset.shapes);
        assert.notEqual(clone.baseVals, preset.baseVals);
    }
    const policy = securityHeaders('')['Content-Security-Policy'];
    assert.match(policy, /script-src 'self';/);
    assert.match(policy, /frame-src https:\/\/open.spotify.com;/);
    assert.doesNotMatch(policy, /unsafe-eval/);
});

test('analyzer never reroutes playback before an AudioContext is running and reuses the media source', async t => {
    let state = 'suspended';
    let created = 0;
    let connections = 0;
    let closed = false;
    class Context {
        get state() { return state; }
        resume() { return Promise.resolve(); }
        close() { closed = true; return Promise.resolve(); }
        createAnalyser() { return {disconnect() {}}; }
        createMediaElementSource() { created++; return {connect() { connections++; }, disconnect() {}}; }
    }
    const original = globalThis.AudioContext;
    globalThis.AudioContext = Context;
    t.after(() => { if (original) globalThis.AudioContext = original; else delete globalThis.AudioContext; });
    const analysis = createAudioAnalysis();
    const video = {};
    assert.equal(await analysis.sample(video, true), null);
    assert.equal(created, 0);
    state = 'running';
    const analyser = await analysis.sample(video, true);
    assert.equal(await analysis.sample(video), analyser);
    assert.equal(created, 1);
    assert.equal(connections, 2, 'Exactly one audible branch plus the analysis branch.');
    analysis.destroy();
    assert.equal(closed, true);
    assert.equal(await analysis.sample(video, true), null);
});

test('visualizations use real samples, freeze while paused or reduced motion, and turn off', async () => {
    const visualization = createVisualization();
    let samples = 0;
    visualization.setAnalyser({getByteFrequencyData(array) { samples++; array.fill(200); }, getByteTimeDomainData(array) { array.fill(150); }});
    visualization.setPlaying(true);
    const frame = visualization.frame(960, 540, 1000);
    assert.equal(frame.pixels[0], 200);
    assert.equal(frame.pixels[1024], 150);
    visualization.setPlaying(false);
    assert.equal(visualization.frame(960, 540, 2000), frame);
    visualization.setPlaying(true);
    assert.equal(visualization.frame(960, 540, 3000, true), frame);
    assert.equal(samples, 1);
    await visualization.select('off');
    assert.equal(visualization.frame(960, 540, 4000), null);
    visualization.destroy();
});
