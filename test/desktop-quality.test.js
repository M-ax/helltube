import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDesktopQuality} from '../shared/desktop-quality.js';

test('desktop quality bounds capture settings without imposing bitrate ceilings', () => {
    const quality = normalizeDesktopQuality({width: 8000, height: 4000, frameRate: 240, videoBitrate: 90_000_000,
        audioBitrate: 900_000, codec: 'av1', degradationPreference: 'invalid', contentHint: 'invalid'});
    assert.deepEqual([quality.width, quality.height, quality.frameRate, quality.videoBitrate, quality.audioBitrate], [1920, 1080, 60, 90_000_000, 900_000]);
    assert.equal(quality.codec, 'auto');
    assert.equal(quality.degradationPreference, 'balanced');
    assert.equal(quality.contentHint, 'motion');
    const low = normalizeDesktopQuality({width: -2, height: 0, frameRate: -1, videoBitrate: -1, audioBitrate: -1});
    assert.deepEqual([low.width, low.height, low.frameRate, low.videoBitrate, low.audioBitrate], [320, 180, 10, 0, 0]);
    assert.deepEqual([normalizeDesktopQuality({videoBitrate: 1}).videoBitrate,
        normalizeDesktopQuality({audioBitrate: 1}).audioBitrate], [300_000, 32_000]);
    for (const value of [undefined, null, 0, NaN, Infinity, '12000000']) {
        const quality = normalizeDesktopQuality({videoBitrate: value, audioBitrate: value});
        assert.deepEqual([quality.videoBitrate, quality.audioBitrate], [0, 0], 'Default to automatic bitrate');
    }
});
