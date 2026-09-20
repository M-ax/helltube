import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDesktopQuality} from '../shared/desktop-quality.js';

test('desktop quality clamps invalid and excessive settings to the relay budget', () => {
    const quality = normalizeDesktopQuality({width: 8000, height: 4000, frameRate: 240, videoBitrate: 90_000_000,
        audioBitrate: 900_000, codec: 'av1', degradationPreference: 'invalid', contentHint: 'invalid'});
    assert.deepEqual([quality.width, quality.height, quality.frameRate, quality.videoBitrate, quality.audioBitrate], [1920, 1080, 60, 12_000_000, 192_000]);
    assert.equal(quality.codec, 'auto');
    assert.equal(quality.degradationPreference, 'balanced');
    assert.equal(quality.contentHint, 'motion');
    const low = normalizeDesktopQuality({width: -2, height: 0, frameRate: -1, videoBitrate: -1, audioBitrate: -1});
    assert.deepEqual([low.width, low.height, low.frameRate, low.videoBitrate, low.audioBitrate], [320, 180, 10, 300_000, 32_000]);
    assert.equal(normalizeDesktopQuality({videoBitrate: NaN}).videoBitrate, 12_000_000);
});
