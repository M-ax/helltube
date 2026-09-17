import test from 'node:test';
import assert from 'node:assert/strict';
import {createMarshmallowVisits, marshmallowPose} from '../src/lib/crt-marshmallow.js';

const visit = (burns = false, side = 1, time = 0) => ({burns, side, time, reach: 0.26, duration: burns ? 13 : 14});
const pose = (event, time, width = 1120, height = 630, controls = 71) =>
    marshmallowPose({...event, time}, width, height, controls);

test('visits wait between appearances, choose either outcome and side, and reset when the CRT leaves', () => {
    for (const random of [0, 0.99]) {
        const scene = createMarshmallowVisits(() => random);
        const delay = 12 + random * 10;
        assert.equal(scene.advance(delay - 0.1), null);
        const event = scene.advance(0.2);
        assert.equal(event.burns, random < 0.45);
        assert.equal(event.side, random < 0.5 ? 1 : -1);
        scene.advance(event.duration);
        assert.equal(scene.current(), null);
        assert.equal(scene.advance(20), null, 'There is a quiet interval between visits.');
        assert.ok(scene.advance(2 + random * 24));
        scene.reset();
        assert.equal(scene.current(), null);
        assert.equal(scene.advance(11), null);
    }
});

test('toasting stays steady, gradually browns, and slides completely off the entry side', () => {
    for (const side of [1, -1]) {
        const event = visit(false, side);
        const raw = pose(event, 2.2);
        const toasted = pose(event, 10.5);
        assert.equal(raw.x, toasted.x);
        assert.equal(raw.y, toasted.y);
        assert.equal(raw.angle, toasted.angle);
        assert.ok(raw.toast < 0.01 && toasted.toast > 0.99);
        assert.equal(toasted.fire + toasted.char + toasted.smoke, 0);
        const exit = pose(event, 13.95);
        assert.ok(side > 0 ? exit.x < -exit.size : exit.x > 1120 + exit.size);
        assert.equal(pose(event, 14), null);
    }
});

test('an accident dips into the flame, ignites, lifts and shakes, then extinguishes with smoke and char', () => {
    const event = visit(true);
    const safe = pose(event, 2.3);
    const dipped = pose(event, 4.9);
    assert.ok(dipped.y > safe.y + safe.size * 0.8);
    assert.equal(dipped.fire, 1);
    const shaking = pose(event, 6.5);
    assert.ok(shaking.y < safe.y, 'The marshmallow lifts away from the flame.');
    assert.notEqual(shaking.angle, pose(event, 6.55).angle);
    assert.ok(shaking.fire > 0 && shaking.blow > 0);
    const rescued = pose(event, 9);
    assert.equal(rescued.fire, 0);
    assert.equal(rescued.char, 1);
    assert.ok(rescued.smoke > 0.9);
    assert.ok(pose(event, 12.95).x < -safe.size);
});

test('side mirroring and resizing preserve the scene relative to the controls', () => {
    for (const [width, height, controls] of [[1120, 630, 71], [375, 211, 71], [320, 180, 104]]) {
        for (const time of [2.3, 4.9, 6.5, 9]) {
            const left = pose(visit(true, 1), time, width, height, controls);
            const right = pose(visit(true, -1), time, width, height, controls);
            assert.ok(Math.abs(left.x + right.x - width) < 0.001);
            assert.equal(left.y, right.y);
            assert.ok(left.y - left.size * 0.5 > 0 && left.y + left.size * 0.5 < height);
            assert.ok(Object.values(left).every(Number.isFinite));
        }
    }
});

test('shaking pivots at a steady offscreen grip and moves the marshmallow tip on either side', () => {
    for (const side of [1, -1]) {
        const samples = Array.from({length: 24}, (_, index) => pose(visit(true, side), 6.1 + index / 60));
        const grips = samples.map(sample => ({
            x: sample.x - side * sample.shaft * Math.cos(sample.angle),
            y: sample.y - side * sample.shaft * Math.sin(sample.angle),
        }));
        assert.ok(grips.every(grip => Math.hypot(grip.x - grips[0].x, grip.y - grips[0].y) < 0.001),
            'The handle must not wobble around the marshmallow.');
        assert.ok(side > 0 ? grips[0].x < 0 : grips[0].x > 1120);
        assert.ok(Math.max(...samples.map(sample => sample.y)) - Math.min(...samples.map(sample => sample.y)) > samples[0].size,
            'The marshmallow is the end with the pronounced shaking.');
    }
});

test('breath follows a static downward path from offscreen while the marshmallow shakes', () => {
    for (const [width, height, controls] of [[1120, 630, 71], [320, 180, 104]]) {
        for (const side of [1, -1]) {
            const samples = [6.1, 6.3, 6.5, 6.8, 7.2].map(time => pose(visit(true, side), time, width, height, controls));
            const path = sample => [sample.breathOriginX, sample.breathOriginY, sample.breathTargetX, sample.breathTargetY];
            for (const sample of samples) assert.deepEqual(path(sample), path(samples[0]));
            assert.ok(samples.some(sample => sample.y !== samples[0].y));
            assert.ok(side > 0 ? samples[0].breathOriginX < 0 : samples[0].breathOriginX > width);
            assert.ok(samples[0].breathOriginY < samples[0].breathTargetY - samples[0].size);
        }
    }
});
