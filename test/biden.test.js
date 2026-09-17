import test from 'node:test';
import assert from 'node:assert/strict';
import {BIDEN_LIFETIME_MS, bidenPose, bidenSound, bidenVariant} from '../src/lib/biden.js';

test('Biden wanders inside the player before his exit, changes direction, pauses, bobs and expires', () => {
    for (const variant of [0, 1]) {
        for (const start of [0, .5, 1]) {
            const poses = Array.from({length: 121}, (_, index) => bidenPose(index * 100, start, variant));
            assert.ok(poses.slice(0, 105).every(pose => pose.x >= .15 && pose.x <= .85));
            assert.ok(poses.some(pose => pose.direction === -1 && pose.walking));
            assert.ok(poses.some(pose => pose.direction === 1 && pose.walking));
            assert.ok(poses.some(pose => pose.bob > 0));
            assert.ok(poses.some(pose => !pose.walking && pose.bob === 0));
            assert.equal(poses.at(-1).opacity, 0);
        }
    }
    assert.equal(bidenPose(1900).x, bidenPose(2300).x, 'A pause holds the same floor position.');
    assert.deepEqual(bidenPose(-100), bidenPose(0));
    assert.deepEqual(bidenPose(BIDEN_LIFETIME_MS + 60000), bidenPose(BIDEN_LIFETIME_MS));
});

test('Biden walks past the edge on his final leg without fading out', () => {
    for (const variant of [0, 1]) {
        let previous = bidenPose(10400, .5, variant);
        for (let age = 10500; age < BIDEN_LIFETIME_MS; age += 100) {
            const pose = bidenPose(age, .5, variant);
            assert.equal(pose.walking, true);
            assert.equal(pose.direction, variant ? 1 : -1);
            assert.ok(variant ? pose.x >= previous.x : pose.x <= previous.x);
            assert.equal(pose.opacity, 1);
            previous = pose;
        }
        assert.ok(variant ? previous.x > 1.15 : previous.x < -.15,
            'The cutout clears the player edge before the reaction expires.');
        assert.equal(bidenPose(BIDEN_LIFETIME_MS, .5, variant).opacity, 0);
    }
});

test('a shared event chooses a stable sound and reduced motion keeps the cutout still', () => {
    const sounds = new Set();
    for (const id of ['shared-event-a', 'shared-event-b']) {
        sounds.add(bidenSound(id));
        for (const age of [0, 500, 2000, 4000, 8000, 11900]) {
            const pose = bidenPose(age, .4, bidenVariant(id), true);
            assert.equal(pose.x, .4);
            assert.equal(pose.direction, 1);
            assert.equal(pose.bob, 0);
            assert.equal(pose.rotation, 0);
            assert.equal(pose.stretch, 1);
            assert.equal(pose.walking, false);
        }
    }
    assert.deepEqual([...sounds].sort(), ['bidenThing', 'bidenWord']);
    assert.equal(bidenPose(BIDEN_LIFETIME_MS - 250, .4, 0, true).opacity, .5);
    assert.equal(bidenPose(BIDEN_LIFETIME_MS, .4, 0, true).opacity, 0);
});
