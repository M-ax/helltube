import test from 'node:test';
import assert from 'node:assert/strict';
import {setImmediate as tick} from 'node:timers/promises';
import {createReactionAudio} from '../src/lib/reaction-audio.js';

function fixture(t) {
    const requests = [];
    const started = [];
    let buffers = 0;
    let decoded = 0;
    const context = {
        state: 'running', sampleRate: 8000, currentTime: 0,
        close: async () => {},
        decodeAudioData: async () => { decoded++; return {duration: 1}; },
        createBuffer(_channels, length, rate) {
            buffers++;
            return {duration: length / rate, getChannelData: () => new Float32Array(length)};
        },
        createGain: () => ({gain: {setTargetAtTime() {}}, connect() {}, disconnect() {}}),
        createBufferSource() {
            return {playbackRate: {setTargetAtTime() {}}, connect: gain => gain,
                start() { started.push(this); }, stop() { this.onended?.(); }, disconnect() {}};
        },
    };
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    Object.defineProperty(globalThis, 'window', {configurable: true, value: {AudioContext: function () { return context; }}});
    t.after(() => {
        if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow);
        else delete globalThis.window;
    });
    t.mock.method(globalThis, 'fetch', (url, {signal}) => {
        const pending = Promise.withResolvers();
        requests.push({url, signal, ...pending});
        return pending.promise;
    });
    const audio = createReactionAudio();
    t.after(() => audio.destroy());
    return {audio, requests, started, context, buffers: () => buffers, decoded: () => decoded,
        resolve(index = 0) { requests[index].resolve({ok: true, arrayBuffer: async () => new ArrayBuffer(1)}); }};
}

test('unlocking does no asset work; preparing a sound shares its fetch and decoded buffer', async t => {
    const f = fixture(t);
    f.audio.unlock();
    f.audio.unlock();
    assert.equal(f.requests.length, 0);
    assert.equal(f.buffers(), 0);
    const first = f.audio.prepare('metalpipe');
    assert.equal(f.audio.prepare('metalpipe'), first);
    assert.deepEqual(f.requests.map(r => r.url), ['/sounds/metal-pipe.mp3']);
    f.resolve();
    await first;
    await f.audio.prepare('metalpipe');
    f.audio.play(.5, 'metalpipe');
    assert.equal(f.requests.length, 1);
    assert.equal(f.decoded(), 1);
    assert.equal(f.started.length, 1);
});

test('the first sound plays after loading, and synthesis waits until the finger is used', async t => {
    const f = fixture(t);
    f.audio.unlock();
    f.audio.play(.5);
    assert.equal(f.started.length, 0);
    f.resolve();
    await tick();
    assert.equal(f.started.length, 1);
    f.audio.play(.5, 'fingertap');
    f.audio.play(.5, 'fingertap');
    assert.equal(f.buffers(), 1);
    f.audio.slide('finger', .5, .8);
    f.audio.slide('finger', .5, .8);
    assert.equal(f.buffers(), 2);
    assert.equal(f.requests.length, 1);
});

test('muting, cancellation, teardown, and slow downloads cannot replay queued sounds', async t => {
    for (const action of ['stop', 'cancel', 'destroy', 'late']) {
        await t.test(action, async t => {
            const f = fixture(t);
            let now = 0;
            t.mock.method(Date, 'now', () => now);
            f.audio.unlock();
            const cancel = f.audio.play(.5);
            if (action === 'cancel') cancel();
            else if (action === 'late') now = 1000;
            else f.audio[action]();
            f.resolve();
            await tick();
            assert.equal(f.started.length, 0);
            if (action === 'destroy') {
                assert.equal(f.requests[0].signal.aborted, true);
                assert.equal(f.decoded(), 0);
            } else {
                f.audio.play(.5);
                assert.equal(f.started.length, 1, 'A fresh reaction can reuse the completed download.');
                assert.equal(f.requests.length, 1);
            }
        });
    }
});

test('failed downloads can retry and muted or locked playback does not fetch', async t => {
    const f = fixture(t);
    f.audio.play(.5);
    assert.equal(f.requests.length, 0);
    f.audio.unlock();
    f.audio.play(0);
    assert.equal(f.requests.length, 0);
    const first = f.audio.prepare('flashbangRing');
    f.requests[0].resolve({ok: false});
    await first;
    const second = f.audio.prepare('flashbangRing');
    f.resolve(1);
    await second;
    assert.equal(f.requests.length, 2);
    assert.equal(f.decoded(), 1);
});
