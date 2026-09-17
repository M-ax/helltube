import test from 'node:test';
import assert from 'node:assert/strict';
import {bufferAhead, createBufferHealth, isProxyLoadFailure} from '../src/lib/buffer-health.js';

const ranges = (...values) => ({length: values.length, start: i => values[i][0], end: i => values[i][1]});
function monitor() {
    let time = 0;
    const health = createBufferHealth({now: () => time});
    const sample = (at, options = {}) => {
        time = at;
        return health.sample({ranges: ranges([0, 3]), currentTime: 0, target: 0,
            serverAhead: 30, playbackRevision: 1, ...options});
    };
    const observe = (from, to, options) => {
        let report;
        for (let at = from; at <= to; at += 1000) report = sample(at, options);
        return report;
    };
    return {health, sample, observe};
}

test('buffer health counts only actual contiguous media at both local and room playheads', () => {
    const buffered = ranges([2, 8], [10, 30]);
    for (const position of [-1, 0, 8, 9, 30, NaN, Infinity]) assert.equal(bufferAhead(buffered, position), 0);
    assert.equal(bufferAhead(buffered, 4), 4);
    assert.equal(bufferAhead(buffered, 11), 19);
    assert.equal(monitor().sample(0, {ranges: buffered, currentTime: 4, target: 11}).seconds, 4);
    assert.equal(monitor().sample(0, {ranges: buffered, currentTime: 4, target: 9}).seconds, 0);
});

test('sustained low buffer triggers fallback after six seconds; recovery resets the timer', () => {
    const m = monitor();
    assert.equal(m.observe(0, 5000).fallbackReason, null);
    assert.equal(m.sample(6000).fallbackReason, 'Buffer stayed low');
    assert.equal(m.sample(7000, {ranges: ranges([0, 20])}).status, 'Healthy buffer');
    assert.equal(m.observe(8000, 13000).fallbackReason, null);
    assert.equal(m.sample(14000).fallbackReason, 'Buffer stayed low');
});

test('empty startup and playback stalls recover without waiting for an HLS timeout', () => {
    const m = monitor();
    const empty = {ranges: ranges(), buffering: true};
    assert.equal(m.observe(0, 3000, empty).fallbackReason, null, 'Initial load gets four seconds of grace.');
    assert.equal(m.sample(4000, empty).fallbackReason, 'Playback stalled');
    m.sample(5000, {ranges: ranges([0, 20])});
    assert.equal(m.observe(6000, 8000, empty).fallbackReason, null);
    assert.equal(m.sample(9000, empty).fallbackReason, 'Playback stalled');
});

test('pauses, blocked autoplay, disconnection, user seeks, source starvation, and complete tails do not switch', () => {
    for (const options of [{paused: true}, {blocked: true}, {active: false}, {seeking: true},
        {serverAhead: 2}, {complete: true, remaining: 3}, {complete: true, remaining: 0, ranges: ranges()}]) {
        const m = monitor();
        assert.equal(m.observe(0, 12000, options).fallbackReason, null, JSON.stringify(options));
        assert.equal(m.observe(13000, 18000).fallbackReason, null, 'Resuming starts a fresh low-buffer timer.');
    }
});

test('room revisions and suspended tabs reset stale observations', () => {
    const m = monitor();
    m.observe(0, 5000);
    assert.equal(m.sample(6000, {playbackRevision: 2}).fallbackReason, null);
    m.observe(7000, 11000, {playbackRevision: 2});
    assert.equal(m.sample(12000, {playbackRevision: 2}).fallbackReason, 'Buffer stayed low');
    assert.equal(m.sample(60000, {playbackRevision: 2}).fallbackReason, null);
});

test('a prepared short video can still fail over when its remaining bytes have not arrived', () => {
    const m = monitor();
    assert.equal(m.observe(0, 4000, {ranges: ranges(), buffering: true, serverAhead: 2,
        remaining: 2, complete: true}).fallbackReason, 'Playback stalled');
});

test('source availability alone is not reported as downloaded buffer', () => {
    const m = monitor();
    const report = m.sample(0, {ranges: ranges(), serverAhead: 120, buffering: true});
    assert.equal(report.seconds, 0);
    assert.equal(report.serverAhead, 120);
    assert.equal(report.status, 'Buffering');
    assert.equal(m.sample(1000, {serverAhead: 3}).status, 'Waiting for source');
});

test('recent download reports include latency and expire while idle; native playback needs no transfer metrics', () => {
    const m = monitor();
    assert.equal(m.sample(0).mbps, null);
    m.health.fragmentLoaded({duration: 2, stats: {loaded: 250000, loading: {start: 100, end: 1100}}});
    const report = m.sample(1000);
    assert.equal(report.mbps, 2);
    assert.equal(report.downloadRate, 2);
    m.health.fragmentLoaded({duration: 2, stats: {loaded: 250000, loading: {start: 0, end: 0}}});
    assert.equal(m.sample(2000).mbps, 2);
    assert.equal(m.sample(15000).mbps, null);
});

test('only proxy transport failures qualify, excluding authorization, key, decode and other-job failures', () => {
    const source = 'https://watch.example/media/job/index.m3u8';
    for (const details of ['manifestLoadError', 'levelLoadTimeOut', 'fragLoadError']) {
        assert.equal(isProxyLoadFailure({details, url: source, response: {code: 502}}, source), true);
        assert.equal(isProxyLoadFailure({details, context: {url: source}}, source), true);
        for (const code of [401, 403, 404]) {
            assert.equal(isProxyLoadFailure({details, url: source, response: {code}}, source), false);
        }
    }
    for (const data of [{details: 'keyLoadError', url: source}, {details: 'bufferStalledError', url: source},
        {details: 'fragLoadError', frag: {url: 'https://metal.example/direct/media/job/segment-000001.ts'}},
        {details: 'fragLoadError', url: source.replace('/job/', '/other/')}, {details: 'fragLoadError'}]) {
        assert.equal(isProxyLoadFailure(data, source), false);
    }
});
