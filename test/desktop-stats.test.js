import test from 'node:test';
import assert from 'node:assert/strict';
import {createDesktopStats} from '../src/lib/desktop-stats.js';

function report(video = {}, extra = []) {
    const entries = [
        {id: 'audio', type: 'outbound-rtp', kind: 'audio', bytesSent: 999999},
        {id: 'repair', type: 'outbound-rtp', kind: 'video', codecId: 'rtx', bytesSent: 999999},
        {id: 'rtx', type: 'codec', mimeType: 'video/rtx'},
        {id: 'codec', type: 'codec', mimeType: 'video/H264'},
        {id: 'video', ssrc: 1, type: 'outbound-rtp', kind: 'video', codecId: 'codec',
            timestamp: 1000, bytesSent: 100000, framesEncoded: 30, totalEncodeTime: 0.15, ...video},
        ...extra,
    ];
    return new Map(entries.map(entry => [entry.id, entry]));
}

test('video bitrate and encoder load use interval deltas, excluding audio and repair streams', () => {
    const stats = createDesktopStats();
    const first = stats.sample(report());
    assert.equal(first.bitrate, null);
    assert.equal(first.encoderLoad, null);
    const second = stats.sample(report({timestamp: 3000, bytesSent: 850000, framesEncoded: 90, totalEncodeTime: 0.75,
        frameWidth: 1920, frameHeight: 1080, encoderImplementation: 'Test encoder', powerEfficientEncoder: false,
        qualityLimitationReason: 'cpu', transportId: 'transport'}, [
        {id: 'transport', type: 'transport', selectedCandidatePairId: 'selected'},
        {id: 'unselected', type: 'candidate-pair', currentRoundTripTime: 9},
        {id: 'selected', type: 'candidate-pair', currentRoundTripTime: 0.02},
    ]));
    assert.equal(second.bitrate, 3_000_000);
    assert.equal(second.encoderLoad, 30);
    assert.equal(second.encodeMs, 10);
    assert.equal(second.fps, 30);
    assert.equal(second.width, 1920);
    assert.equal(second.height, 1080);
    assert.equal(second.codec, 'H264');
    assert.equal(second.encoder, 'Test encoder');
    assert.equal(second.powerEfficient, false);
    assert.equal(second.limitation, 'cpu');
    assert.equal(second.rttMs, 20);
    assert.equal(second.packetLoss, null);
});

test('viewers report receive metrics without inventing encoder statistics', () => {
    const stats = createDesktopStats({outbound: false});
    const video = {type: 'inbound-rtp', bytesReceived: 100, framesDecoded: 10, packetsReceived: 100, packetsLost: 1, framesDropped: 2};
    stats.sample(report(video));
    const next = stats.sample(report({...video, timestamp: 2000, bytesReceived: 125100, framesDecoded: 35,
        packetsReceived: 198, packetsLost: 3, framesDropped: 5, jitter: 0.004}));
    assert.equal(next.bitrate, 1_000_000);
    assert.equal(next.fps, 25);
    assert.equal(next.jitterMs, 4);
    assert.equal(next.packetLoss, 2);
    assert.equal(next.droppedFrames, 3);
    assert.equal(next.encoderLoad, null);
    assert.equal(next.encodeMs, null);
    assert.equal(next.limitation, null);
});

test('missing optional fields stay unavailable while measured zero values remain visible', () => {
    const stats = createDesktopStats();
    const video = {totalEncodeTime: undefined, framesEncoded: undefined, framesPerSecond: 0};
    stats.sample(report(video));
    const next = stats.sample(report({...video, timestamp: 2000}));
    assert.equal(next.bitrate, 0);
    assert.equal(next.fps, 0);
    for (const key of ['encoderLoad', 'encodeMs', 'width', 'height', 'encoder', 'powerEfficient', 'rttMs', 'limitation']) {
        assert.equal(next[key], null, key);
    }
});

for (const change of [{id: 'new'}, {ssrc: 2}, {codecId: 'new'}, {timestamp: 1000}, {timestamp: 500},
    {timestamp: 10000}, {bytesSent: 10}, {framesEncoded: 0}]) {
    test(`changed streams and invalid intervals reset rate baselines: ${JSON.stringify(change)}`, () => {
        const stats = createDesktopStats();
        stats.sample(report());
        const next = stats.sample(report({timestamp: 2000, ...change}));
        assert.equal(next.bitrate, null);
        assert.equal(next.encoderLoad, null);
    });
}

test('missing reports clear the baseline and malformed counters cannot produce invalid metrics', () => {
    const stats = createDesktopStats();
    stats.sample(report());
    assert.equal(stats.sample(null), null);
    assert.equal(stats.sample(report({timestamp: 2000})).bitrate, null);
    const next = stats.sample(report({timestamp: 3000, bytesSent: Infinity, totalEncodeTime: NaN, framesPerSecond: -1}));
    assert.equal(next.bitrate, null);
    assert.equal(next.encoderLoad, null);
    assert.equal(next.encodeMs, null);
    assert.equal(next.fps, 0);
});
