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

test('received-stream analysis has no audible output, reuses its source and leaves playback tracks alive', async t => {
    let created = 0, disconnected = 0;
    const connections = [];
    const analyser = {disconnect() {}};
    class Context {
        state = 'running';
        destination = {};
        createAnalyser() { return analyser; }
        createMediaStreamSource() {
            created++;
            return {connect(target) { connections.push(target); }, disconnect() { disconnected++; }};
        }
        close() { return Promise.resolve(); }
    }
    const original = globalThis.AudioContext;
    globalThis.AudioContext = Context;
    t.after(() => { if (original) globalThis.AudioContext = original; else delete globalThis.AudioContext; });
    let stopped = false;
    const track = {stop() { stopped = true; }};
    const stream = {getAudioTracks: () => [track]};
    const analysis = createAudioAnalysis();
    assert.equal(await analysis.sampleStream({getAudioTracks: () => []}, true), null);
    assert.equal(await analysis.sampleStream(stream, true), analyser);
    assert.equal(await analysis.sampleStream(stream), analyser);
    assert.equal(created, 1);
    assert.deepEqual(connections, [analyser], 'Analysis must not double-play the received audio');
    analysis.releaseStream(stream);
    assert.equal(disconnected, 1);
    assert.equal(stopped, false);
    analysis.destroy();
    assert.equal(await analysis.sampleStream(stream, true), null);
});

async function milkdropFixture(t) {
    const original = globalThis.document;
    globalThis.document = {createElement: () => ({width: 0, height: 0, addEventListener() {},
        getContext: () => ({getExtension: () => null})})};
    t.after(() => { if (original) globalThis.document = original; else delete globalThis.document; });
    const elapsed = [];
    const visualization = createVisualization(message => assert.equal(message, ''), {loadLibrary: async () => ({
        presets: {test: {}}, engine: {createVisualizer: () => ({loadPreset() {}, setRendererSize() {},
            render(options) { elapsed.push(options.elapsedTime); }})},
    })});
    t.after(() => visualization.destroy());
    await visualization.select('milkdrop:test');
    visualization.setPlaying(true);
    return {visualization, elapsed};
}

test('MilkDrop keeps real-time speed and a bounded frame rate despite fast reaction redraws', async t => {
    const durations = [];
    const {visualization, elapsed} = await milkdropFixture(t);
    for (const refreshRate of [30, 60, 144]) {
        await visualization.select('milkdrop:test');
        elapsed.length = 0;
        const redraws = Array.from({length: refreshRate * 2 + 1}, (_, index) => index * 1000 / refreshRate);
        // Ball snapshots and repeated state/resize updates redraw between RAFs.
        if (refreshRate > 30) for (let time = 0; time <= 2000; time += 5) redraws.push(time, time, time);
        for (const time of redraws.sort((a, b) => a - b)) visualization.frame(960, 540, time);
        assert.ok(elapsed.length >= 35 && elapsed.length <= 61, `${refreshRate} Hz does not accelerate preset frame equations`);
        const duration = elapsed.reduce((sum, value) => sum + value, 0);
        assert.ok(Math.abs(duration - 2) < 0.05, `${refreshRate} Hz redraws advance about two seconds, got ${duration}`);
        durations.push(duration);
    }
    assert.ok(Math.max(...durations) - Math.min(...durations) < 0.05);
});

test('paused, reduced-motion and suspended visualizations do not accumulate time to catch up later', async t => {
    const {visualization, elapsed} = await milkdropFixture(t);
    const first = visualization.frame(960, 540, 1000);
    assert.equal(visualization.frame(960, 540, 1001), first, 'Immediate redraw uses the existing frame');
    visualization.setPlaying(false);
    visualization.frame(960, 540, 20000);
    assert.equal(elapsed.length, 1);
    visualization.setPlaying(true);
    visualization.frame(960, 540, 20001);
    assert.equal(elapsed.at(-1), 1 / 30);
    visualization.frame(960, 540, 30000, true);
    visualization.frame(960, 540, 40000);
    assert.equal(elapsed.at(-1), 1 / 30);
    visualization.resetClock(); // Tab hidden or WebGL context interrupted.
    visualization.frame(960, 540, 60000);
    assert.equal(elapsed.at(-1), 1 / 30);
    visualization.frame(960, 540, 60080);
    assert.equal(elapsed.at(-1), 0.08, 'Use measured time when a frame arrives late');
});
