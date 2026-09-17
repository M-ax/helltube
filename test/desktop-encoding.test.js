import test from 'node:test';
import assert from 'node:assert/strict';
import {desktopVideoCodecs} from '../src/lib/desktop-encoding.js';

const vp8 = {mimeType: 'video/VP8', parameters: {}};
const h264 = {mimeType: 'video/H264', parameters: {'packetization-mode': 1, 'profile-level-id': '42e01f'}};
const codecs = [vp8, h264];
const track = {getSettings: () => ({width: 1280, height: 720, frameRate: 60})};

test('prefers the power-efficient negotiated profile and probes actual capture settings', async () => {
    const queries = [];
    const ordered = await desktopVideoCodecs(codecs, track, {mediaCapabilities: {async encodingInfo(query) {
        queries.push(query);
        return {supported: true, powerEfficient: query.video.contentType.startsWith('video/H264')};
    }}});
    assert.deepEqual(ordered, [h264, vp8]);
    assert.deepEqual(queries[1], {type: 'webrtc', video: {
        contentType: 'video/H264;packetization-mode=1;profile-level-id=42e01f',
        width: 1280, height: 720, framerate: 30, bitrate: 6_000_000,
    }});
    assert.deepEqual(codecs, [vp8, h264], 'Shared capabilities are not reordered');
});

for (const powerEfficient of [true, false]) {
    test(`keeps VP8 when it is ${powerEfficient ? 'the hardware choice' : 'equally supported in software'}`, async () => {
        const result = await desktopVideoCodecs(codecs, track, {mediaCapabilities: {async encodingInfo(query) {
            return {supported: true, powerEfficient: powerEfficient && query.video.contentType === 'video/VP8'};
        }}});
        assert.deepEqual(result, [vp8, h264]);
    });
}

for (const [name, mediaCapabilities] of [
    ['missing', null], ['older', {}], ['rejecting', {async encodingInfo() { throw new TypeError('webrtc is not supported'); }}],
    ['hanging', {encodingInfo: () => new Promise(() => {})}],
]) {
    test(`falls back to H264 then VP8 with a ${name} capability API`, async () => {
        assert.deepEqual(await desktopVideoCodecs(codecs, track, {mediaCapabilities, timeout: 10}), [h264, vp8]);
    });
}

test('retains negotiated codecs as fallbacks when capability reports disagree', async () => {
    const result = await desktopVideoCodecs(codecs, track, {mediaCapabilities: {async encodingInfo(query) {
        return {supported: query.video.contentType === 'video/VP8', powerEfficient: true};
    }}});
    assert.deepEqual(result, [vp8, h264]);
});

test('only considers negotiated video codecs, excluding audio and repair codecs', async () => {
    const mediaCapabilities = {encodingInfo() { assert.fail('No probe needed for a single codec'); }};
    assert.deepEqual(await desktopVideoCodecs([vp8, {mimeType: 'audio/opus'}, {mimeType: 'video/rtx'}], track,
        {mediaCapabilities}), [vp8]);
    assert.deepEqual(await desktopVideoCodecs([], track, {mediaCapabilities}), []);
});
