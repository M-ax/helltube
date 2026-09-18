import test from 'node:test';
import assert from 'node:assert/strict';
import {fingerStrikePose, fingerProjection, FINGER_TAP_DURATION_MS} from '../src/lib/finger-strike.js';
import {FINGER_TAP_IMPACT_MS} from '../shared/reaction-pointer.js';
import {Reactions} from '../server/reactions.js';

test('a strike lifts, contacts the glass at the sound cue, rebounds and settles even after a quick release', () => {
    assert.equal(fingerStrikePose(Infinity).phase, 'idle');
    assert.ok(fingerStrikePose(20).lift > 35);
    assert.ok(fingerStrikePose(40).lift < fingerStrikePose(20).lift);
    const impact = fingerStrikePose(FINGER_TAP_IMPACT_MS);
    assert.equal(impact.phase, 'impact');
    assert.equal(impact.lift, 0);
    assert.equal(impact.contact, 1);
    assert.ok(fingerStrikePose(110).lift > 0 && fingerStrikePose(110).lift < 10);
    assert.deepEqual(fingerStrikePose(FINGER_TAP_DURATION_MS), {lift: 0, phase: 'idle', contact: 0});
    assert.ok(fingerStrikePose(20, true).lift < fingerStrikePose(20).lift * .2);
    assert.deepEqual(fingerStrikePose(FINGER_TAP_IMPACT_MS, true), impact, 'Reduced motion retains the same contact timing.');
});

test('perspective moves the shaft and hand around a fixed grip, then lands exactly on the cursor', () => {
    for (const [width, height] of [[830, 467], [320, 180], [1920, 1080]]) {
        for (const pivot of [{x: -.08, y: .3}, {x: 1.08, y: .3}, {x: .3, y: -.12}, {x: .3, y: 1.12}]) {
            const finger = {x: .65, y: .4, pivot};
            const flat = fingerProjection(finger, width, height);
            const lifted = fingerProjection(finger, width, height, 1, fingerStrikePose(20).lift);
            const landed = fingerProjection(finger, width, height, 1, fingerStrikePose(FINGER_TAP_IMPACT_MS).lift);
            const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
            assert.ok(distance(lifted.project(0, 0), flat.project(0, 0)) < 1e-8, 'The offscreen grip stays fixed.');
            assert.ok(distance(lifted.project(flat.length / 2, 0), flat.project(flat.length / 2, 0)) > .1, 'The middle of the shaft moves in 3D.');
            const across = geometry => distance(geometry.project(flat.length * .75, -3), geometry.project(flat.length * .75, 3));
            assert.ok(across(lifted) > across(flat), 'The nearer shaft widens in perspective.');
            assert.ok(distance(landed.project(flat.length, 0), {x: finger.x * width, y: finger.y * height}) < 1e-8);
            assert.ok(distance(lifted.project(flat.length, 0), lifted.project(flat.length, 0, true))
                > distance(flat.project(flat.length, 0), flat.project(flat.length, 0, true)), 'The cast shadow separates during the lift.');
        }
    }
});

test('the server anchors each strike once and waits for contact before discharging static', () => {
    let now = 1000;
    const sent = [];
    const service = new Reactions({now: () => now, broadcast: (roomId, message) => sent.push(message)});
    const send = (x, taps, pressed) => service.pointer('room', 'client', {x: null, y: null,
        finger: {x, y: .3, pivot: {x: -.1, y: .3}, taps, pressed, tapTime: 999999}}, 'user');
    send(.2, 0, false);
    send(.2, 1, true);
    assert.equal(service.snapshot('room').fingers[0].tapTime, 1000, 'Client timestamps cannot forge the shared strike clock.');
    now += 30;
    send(.4, 1, true);
    assert.equal(service.snapshot('room').fingers[0].tapTime, 1000, 'Cursor heartbeats do not restart the strike.');
    assert.equal(sent.filter(event => event.kind === 'fingerstatic').length, 0);
    now = 1000 + FINGER_TAP_IMPACT_MS;
    send(.5, 1, true);
    assert.ok(sent.some(event => event.kind === 'fingerstatic'));
    now += 100;
    send(.5, 2, false);
    assert.equal(service.snapshot('room').fingers[0].tapTime, now, 'A quick down/up still retains a complete strike cue.');
});
