import test from 'node:test';
import assert from 'node:assert/strict';
import {FLASH_BOUNCE_TIMES, FLASH_DETONATE_MS, FLASH_HOLD_MS, FLASH_FADE_MS,
    FLASH_LIFETIME_MS, flashbangPose} from '../src/lib/flashbang.js';

test('flashbang flies in from either side, makes diminishing bounces and settles before detonation', () => {
    for (const landingX of [.25, .75]) {
        const start = flashbangPose(0, landingX);
        assert.ok(landingX < .5 ? start.x < 0 : start.x > 1);
        assert.ok(start.height > 0);
        let previousHeight = 1;
        for (const [index, time] of FLASH_BOUNCE_TIMES.entries()) {
            const contact = flashbangPose(time, landingX);
            assert.equal(contact.height, 0);
            assert.equal(contact.impacts, index + 1);
            assert.equal(contact.detonated, false);
            if (index) {
                const peak = flashbangPose((FLASH_BOUNCE_TIMES[index - 1] + time) / 2, landingX).height;
                assert.ok(peak > 0 && peak < previousHeight);
                previousHeight = peak;
            }
        }
        const settled = flashbangPose(FLASH_DETONATE_MS - 1, landingX);
        assert.equal(settled.height, 0);
        assert.equal(settled.x, landingX);
        assert.equal(settled.whiteout, 0);
    }
});

test('whiteout starts at detonation, holds briefly, then steadily fades all the way out', () => {
    assert.equal(flashbangPose(FLASH_DETONATE_MS - 1).whiteout, 0);
    assert.equal(flashbangPose(FLASH_DETONATE_MS).detonated, true);
    assert.equal(flashbangPose(FLASH_DETONATE_MS).whiteout, 1);
    const fadeStart = FLASH_DETONATE_MS + FLASH_HOLD_MS;
    assert.equal(flashbangPose(fadeStart).whiteout, 1);
    assert.equal(flashbangPose(fadeStart + FLASH_FADE_MS / 2).whiteout, .5);
    assert.equal(flashbangPose(FLASH_LIFETIME_MS).whiteout, 0);
    assert.equal(flashbangPose(FLASH_LIFETIME_MS + 60000).whiteout, 0);
});

test('reduced motion avoids spinning while keeping shared collision and flash times', () => {
    for (const age of [0, 400, ...FLASH_BOUNCE_TIMES, FLASH_DETONATE_MS, FLASH_LIFETIME_MS]) {
        const pose = flashbangPose(age, .5, true);
        assert.equal(pose.rotation, 90);
        assert.deepEqual({...pose, rotation: 0}, {...flashbangPose(age), rotation: 0});
    }
    assert.deepEqual(flashbangPose(-100), flashbangPose(0));
});
