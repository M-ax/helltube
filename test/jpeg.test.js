import test from 'node:test';
import assert from 'node:assert/strict';
import {jpegSettings, JPEG_SOUND_MS, JPEG_AUDIO_MS, JPEG_LIFETIME_MS} from '../src/lib/jpeg.js';

test('JPEG damage follows the sound, stays bounded, and restores the picture at the end', () => {
    assert.equal(jpegSettings(JPEG_SOUND_MS - 1, 1920, 1080), null);
    assert.equal(jpegSettings(JPEG_LIFETIME_MS, 1920, 1080), null);
    assert.equal(jpegSettings(JPEG_SOUND_MS, 0, 0), null);
    for (const [width, height] of [[1920, 1080], [320, 180], [600, 1200], [7680, 2160]]) {
        let previous;
        for (let age = JPEG_SOUND_MS; age < JPEG_LIFETIME_MS; age += 100) {
            const frame = jpegSettings(age, width, height);
            assert.ok(frame.width >= 1 && frame.height >= 1 && Math.max(frame.width, frame.height) <= 960);
            assert.ok(Math.abs(frame.height - frame.width * height / width) <= 1);
            assert.ok(frame.quality >= .0099 && frame.quality <= .85);
            if (previous) {
                assert.ok(frame.width <= previous.width && frame.height <= previous.height);
                assert.ok(frame.quality <= previous.quality);
            }
            previous = frame;
        }
        assert.equal(Math.max(previous.width, previous.height), 48);
        assert.equal(previous.progress, 1);
    }
    assert.equal(JPEG_LIFETIME_MS - JPEG_SOUND_MS, JPEG_AUDIO_MS);
});
