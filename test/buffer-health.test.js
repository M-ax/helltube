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

test('startup buffering and early draining recover without a quality downgrade', () => {
    const m = monitor();
    for (let at = 0; at <= 30000; at += 1000) {
        const seconds = at < 8000 ? 0 : at < 12000 ? 3 : at < 16000 ? 21 - at / 1000 : 20;
        assert.equal(m.sample(at, {ranges: ranges([0, seconds]), buffering: seconds === 0,
            alternativeAhead: 30}).qualityFallbackReason, null, `Startup at ${at}ms`);
    }
});

test('sustained draining needs six seconds and less than four seconds buffered after startup', () => {
    const m = monitor();
    m.observe(0, 15000, {ranges: ranges([0, 10]), alternativeAhead: 30});
    for (let at = 16000; at < 22000; at += 1000) {
        assert.equal(m.sample(at, {ranges: ranges([0, 25 - at / 1000]), alternativeAhead: 30}).qualityFallbackReason, null);
    }
    const report = m.sample(22000, {ranges: ranges([0, 3]), alternativeAhead: 30});
    assert.equal(report.qualityFallbackReason, 'Buffer is running low');
    assert.equal(report.fallbackReason, null, 'Quality can drop before route fallback is warranted.');
});

test('startup observations do not count toward sustained stalls or source starvation', () => {
    for (const [options, fallbackAt, reason] of [
        [{ranges: ranges(), buffering: true}, 21000, 'Playback stalled'],
        [{serverAhead: 2}, 27000, 'Buffer stayed low'],
    ]) {
        const m = monitor();
        assert.equal(m.observe(0, fallbackAt - 1000, {...options, alternativeAhead: 10}).qualityFallbackReason, null);
        assert.equal(m.sample(fallbackAt, {...options, alternativeAhead: 10}).qualityFallbackReason, reason);
    }
});

test('quality fallback requires a prepared Standard stream, including completed short alternatives', () => {
    const pending = monitor();
    assert.equal(pending.observe(0, 30000, {alternativeAhead: 2}).qualityFallbackReason, null);
    assert.equal(pending.sample(31000, {alternativeAhead: 10}).qualityFallbackReason, 'Buffer stayed low');
    const complete = monitor();
    assert.equal(complete.observe(0, 27000, {alternativeAhead: 2, alternativeComplete: true}).qualityFallbackReason, 'Buffer stayed low');
});

test('pauses, seeks, autoplay blocks, disconnection and complete tails grant fresh quality startup time', () => {
    for (const options of [{paused: true}, {blocked: true}, {active: false}, {seeking: true}, {complete: true, remaining: 0}]) {
        const m = monitor();
        const empty = {ranges: ranges(), buffering: true, alternativeAhead: 30};
        m.observe(0, 20000, empty);
        assert.equal(m.observe(21000, 40000, {...empty, ...options}).qualityFallbackReason, null);
        assert.equal(m.observe(41000, 61000, empty).qualityFallbackReason, null, JSON.stringify(options));
        assert.equal(m.sample(62000, empty).qualityFallbackReason, 'Playback stalled');
    }
});

test('room revisions and suspended tabs discard quality observations and restart the grace period', () => {
    const m = monitor();
    const empty = {ranges: ranges(), buffering: true, alternativeAhead: 30};
    m.observe(0, 20000, empty);
    const sought = {...empty, playbackRevision: 2};
    assert.equal(m.observe(21000, 41000, sought).qualityFallbackReason, null);
    assert.equal(m.sample(42000, sought).qualityFallbackReason, 'Playback stalled');
    assert.equal(m.observe(60000, 80000, sought).qualityFallbackReason, null);
    assert.equal(m.sample(81000, sought).qualityFallbackReason, 'Playback stalled');
});

test('a modest steady buffer and brief dips preserve quality; recovery resets low-buffer observations', () => {
    const m = monitor();
    const ready = {alternativeAhead: 30};
    assert.equal(m.observe(0, 30000, {...ready, ranges: ranges([0, 5])}).qualityFallbackReason, null);
    for (let at = 31000; at <= 33000; at += 1000) {
        assert.equal(m.sample(at, {...ready, ranges: ranges([0, 35 - at / 1000])}).qualityFallbackReason, null);
    }
    assert.equal(m.sample(34000, {...ready, ranges: ranges([0, 4])}).qualityFallbackReason, null);
    assert.equal(m.observe(35000, 46000, ready).qualityFallbackReason, null);
    assert.equal(m.sample(47000, ready).qualityFallbackReason, 'Buffer stayed low');
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
