import test from 'node:test';
import assert from 'node:assert/strict';
import {FingerStatic, STATIC_RECOVERY_MS} from '../server/finger-static.js';
import {Reactions} from '../server/reactions.js';

const from = {x: .2, y: .5}, to = {x: .7, y: .5};
const strength = clusters => Math.max(0, ...clusters.map(cluster => cluster.strength));

test('rubbing discharges a swept path and nearby patches, leaving fresh glass charged', () => {
    const surface = new FingerStatic();
    assert.equal(strength(surface.rub(from, to, 0)), 1);
    assert.deepEqual(surface.rub(to, from, 100), [], 'Returning along the trail is quiet.');
    assert.deepEqual(surface.rub({x: .3, y: .52}, {x: .6, y: .52}, 200), [], 'A neighboring trail is also discharged.');
    assert.equal(strength(surface.rub({x: .2, y: .8}, {x: .7, y: .8}, 300)), 1, 'Untouched glass still crackles.');
    assert.deepEqual(surface.rub(to, to, 400), [], 'Holding still does not create static.');
});

test('charge recovers gradually over twenty seconds and continued rubbing postpones recovery', () => {
    function strengthAfter(delay) {
        const surface = new FingerStatic();
        surface.rub(from, to, 0);
        return strength(surface.rub(to, from, delay));
    }
    assert.equal(strengthAfter(1000), 0);
    assert.equal(strengthAfter(10000), .5);
    assert.equal(strengthAfter(STATIC_RECOVERY_MS), 1);
    const surface = new FingerStatic();
    surface.rub(from, to, 0);
    for (let time = 1000; time <= 30000; time += 1000) assert.deepEqual(surface.rub(from, to, time), []);
    assert.equal(strength(surface.rub(from, to, 50000)), 1);
});

test('slow pointer samples still find fresh patches without skipping or replaying a discharge', () => {
    const surface = new FingerStatic();
    let cracks = 0;
    for (let step = 0; step < 100; step++) {
        cracks += surface.rub({x: .2 + step * .005, y: .5}, {x: .205 + step * .005, y: .5}, step * 20).length;
    }
    assert.ok(cracks >= 5 && cracks <= 20, `Expected sparse crackles along fresh glass, got ${cracks}`);
    assert.deepEqual(surface.rub(to, from, 2100), []);
});

test('a fast stroke retains every crossed patch and fresh patches can discharge on consecutive ticks', () => {
    const surface = new FingerStatic();
    const clusters = surface.rub(from, to, 0);
    assert.ok(clusters.length >= 8, 'A fast sweep produces many clusters instead of collapsing to one.');
    assert.ok(clusters.every(cluster => cluster.strength === 1 && cluster.fraction >= 0 && cluster.fraction <= 1));
    assert.deepEqual(clusters.map(cluster => cluster.fraction), clusters.map(cluster => cluster.fraction).toSorted((a, b) => a - b));
    assert.ok(surface.rub({x: .2, y: .8}, {x: .7, y: .8}, 16).length >= 8, 'No global cooldown drops fresh discharges.');
});

test('static is shared between fingers, isolated by room, and survives putting a finger away', () => {
    let now = 0;
    const sent = [];
    const service = new Reactions({now: () => now, broadcast: (roomId, message) => sent.push(message)});
    const point = (room, client, x, y = .5, pressed = true) => {
        now += 100;
        service.pointer(room, client, {x: null, y: null, finger: {x, y, pressed, taps: 0, pivot: {x: -.1, y: .5}}}, client);
    };
    const cracks = () => sent.filter(message => message.kind === 'fingerstatic');
    point('one', 'a', .2); point('one', 'a', .7);
    assert.equal(cracks().length, 1);
    assert.ok(cracks()[0].clusters.length >= 8);
    assert.ok(cracks()[0].clusters.every(cluster => cluster.strength === 1 && cluster.offset >= 0 && cluster.offset <= .04));
    service.pointer('one', 'a', {x: null, y: null});
    assert.equal(service.rooms.has('one'), false);
    point('one', 'b', .6, .52); point('one', 'b', .3, .52);
    assert.equal(cracks().length, 1, 'Another viewer cannot recharge the rubbed area by using a different finger.');
    point('two', 'c', .2); point('two', 'c', .7);
    assert.equal(cracks().length, 2);
    assert.equal(cracks()[1].roomId, 'two');
    point('one', 'b', .2, .8, false); point('one', 'b', .7, .8, false);
    assert.equal(cracks().length, 2, 'Hovering does not discharge static.');
    service.leave('two', 'c', true);
    assert.equal(service.staticSurfaces.has('two'), false);
    now += STATIC_RECOVERY_MS;
    service.tick();
    assert.equal(service.staticSurfaces.size, 0, 'Fully recovered surfaces do not retain room memory.');
});
