import test from 'node:test';
import assert from 'node:assert/strict';
import {PIPE_FALL_MS, PIPE_LIFETIME_MS, pipePose} from '../src/lib/metal-pipe.js';

test('pipe accelerates to the floor and only lands at the shared impact time', () => {
    assert.equal(pipePose(0).drop, 0);
    assert.equal(pipePose(PIPE_FALL_MS / 2).drop, .25);
    assert.equal(pipePose(PIPE_FALL_MS - 1).landed, false);
    assert.deepEqual(pipePose(PIPE_FALL_MS), {drop: 1, rotation: 0, landed: true, opacity: 1});
    assert.equal(pipePose(PIPE_FALL_MS + 500).drop, 1);
    assert.equal(pipePose(PIPE_LIFETIME_MS).opacity, 0);
});

test('reduced motion removes rotation without moving the sound ahead of impact', () => {
    const age = PIPE_FALL_MS * .8;
    assert.equal(pipePose(age, true).rotation, 0);
    assert.equal(pipePose(age, true).drop, pipePose(age).drop);
    assert.equal(pipePose(age, true).landed, false);
    assert.equal(pipePose(-100).drop, 0);
});
