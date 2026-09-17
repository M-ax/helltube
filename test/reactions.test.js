import test from 'node:test';
import assert from 'node:assert/strict';
import {Reactions} from '../server/reactions.js';
import {start, until} from './helpers.js';
import {fingerPivot, POINTER_TICK_MS} from '../shared/reaction-pointer.js';
import {setTimeout as sleep} from 'node:timers/promises';

test('finger pivots select the closest physical edge and stay outside the player', () => {
    for (const [x, y, edge] of [[.01, .4, 'left'], [.99, .4, 'right'], [.6, .01, 'top'], [.6, .99, 'bottom']]) {
        const pivot = fingerPivot(x, y, 1000, 600);
        assert.ok(edge === 'left' ? pivot.x < 0 : edge === 'right' ? pivot.x > 1 : edge === 'top' ? pivot.y < 0 : pivot.y > 1);
    }
    assert.ok(fingerPivot(.15, .2, 1000, 400).y < 0, 'Edge selection accounts for the player aspect ratio.');
});

test('fingers validate state, lock the entry pivot, preserve other props, and expire cleanly', () => {
    let now = 1000;
    const sent = [];
    const service = new Reactions({now: () => now, broadcast: (roomId, message) => sent.push(message)});
    const finger = {x: .6, y: .4, pivot: {x: -.1, y: .3}, pressed: false, taps: 0};
    for (const invalid of [{...finger, x: NaN}, {...finger, pivot: {x: .5, y: .5}},
        {...finger, pivot: {x: -5, y: 0}}, {...finger, pressed: 1}, {...finger, taps: -1}]) {
        assert.throws(() => service.pointer('one', 'a', {x: null, y: null, finger: invalid}), {status: 400});
    }
    assert.equal(service.rooms.size, 0);
    service.pointer('one', 'a', {x: null, y: null, finger}, 'user-a');
    service.pointer('one', 'b', {x: null, y: null, finger}, 'user-b');
    service.pointer('one', 'a', {x: null, y: null, finger: {...finger, x: .8, pivot: {x: 1.1, y: .3}, pressed: true, taps: 1}}, 'user-a');
    const a = service.snapshot('one').fingers.find(value => value.clientId === 'a');
    assert.deepEqual(a.pivot, finger.pivot);
    assert.equal(a.x, .8);
    assert.equal(a.userId, 'user-a');
    const tap = sent.find(value => value.kind === 'fingertap');
    assert.equal(tap.clientId, 'a');
    service.pointer('one', 'a', {x: null, y: null, finger: {...finger, taps: 1}}, 'user-a');
    assert.equal(sent.filter(value => value.kind === 'fingertap').length, 1, 'Repeated state never repeats a tap.');
    service.react('one', 'user-a', {kind: 'beachball', enabled: true});
    service.react('one', 'user-a', {kind: 'beachball', enabled: false});
    assert.equal(service.snapshot('one').fingers.length, 2);
    service.leave('one', 'a');
    assert.equal(sent.at(-1).fingers.length, 1);
    now += 1501;
    service.tick();
    assert.equal(sent.at(-1).fingers.length, 0);
    assert.equal(service.rooms.size, 0);
});

test('the existing cursor channel sustains 60Hz, shares fingers, isolates rooms and restores live state', async t => {
    const {instance, connect} = await start(t, {maxTranscoders: 0});
    const quiet = instance.rooms.create('Quiet finger room');
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    for (const [ws, roomId] of [[a, 'lobby'], [b, 'lobby'], [outsider, quiet.id]]) ws.send(JSON.stringify({type: 'join', roomId}));
    await until(() => a.messages.some(value => value.type === 'reactions:state'));
    const clientId = a.messages.find(value => value.type === 'reactions:state').clientId;
    const revision = instance.rooms.get('lobby').playback.revision;
    const begin = performance.now();
    for (let tick = 0; tick < 120; tick++) {
        a.send(JSON.stringify({type: 'reaction:pointer', x: null, y: null,
            finger: {x: tick / 120, y: .3, pivot: {x: -.1, y: .3}, pressed: tick >= 60, taps: tick >= 60 ? 1 : 0},
            clientId: 'forged', userId: 'forged', roomId: quiet.id}));
        await sleep(Math.max(0, begin + (tick + 1) * POINTER_TICK_MS - performance.now()));
    }
    assert.deepEqual(a.messages.filter(value => value.type === 'error'), [], '60Hz bypasses the ordinary 40-command ceiling.');
    const states = b.messages.filter(value => value.type === 'reactions:state' && value.fingers?.length);
    assert.ok(states.length >= 95, `Expected roughly 120 shared ticks, got ${states.length}`);
    assert.equal(states.at(-1).fingers[0].clientId, clientId);
    assert.equal(states.at(-1).fingers[0].userId, instance.accounts.users[0].id);
    assert.ok(!outsider.messages.some(value => value.fingers?.length || value.kind === 'fingertap'));
    const late = await connect();
    late.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => late.messages.some(value => value.fingers?.length));
    assert.ok(!late.messages.some(value => value.kind === 'fingertap'), 'Joining does not replay a tap.');
    a.send(JSON.stringify({type: 'reaction:pointer', x: null, y: null}));
    await until(() => !instance.reactions.rooms.has('lobby'));
    assert.equal(instance.rooms.get('lobby').playback.revision, revision);
});

test('reaction service validates inputs, expires pointers and cleans up empty rooms', () => {
    let now = 1000;
    const sent = [];
    const reactions = new Reactions({now: () => now, broadcast: (roomId, message) => sent.push(message)});
    for (const message of [{kind: 'unknown'}, {kind: 'beachball', enabled: 1},
        {kind: 'hitmarker', x: NaN, y: 0}, {kind: 'heart', x: -0.1, y: 1}]) {
        assert.throws(() => reactions.react('one', 'user', message), {status: 400});
    }
    reactions.react('one', 'user', {kind: 'beachball', enabled: true});
    const before = reactions.snapshot('one').ball;
    reactions.react('one', 'user', {kind: 'beachball', enabled: true});
    assert.equal(reactions.snapshot('one').ball, before, 'Enabling twice does not reset the ball.');
    assert.throws(() => reactions.pointer('one', 'client', {x: Infinity, y: 0}), {status: 400});
    reactions.pointer('one', 'client', {x: .5, y: .5});
    now += 50;
    reactions.tick();
    assert.notDeepEqual(reactions.snapshot('one').ball, before);
    assert.equal(sent.at(-1).serverTime, now);
    now += 1600;
    reactions.tick();
    assert.equal(reactions.rooms.get('one').pointers.size, 0);
    reactions.leave('one', 'client', true);
    assert.equal(reactions.snapshot('one').ball, null);
});

test('real WebSockets share reactions, isolate rooms, restore ball on join and reject invalid commands', async t => {
    const {instance, connect} = await start(t, {maxTranscoders: 0});
    const other = instance.rooms.create('Quiet room');
    const a = await connect();
    const b = await connect();
    const outsider = await connect();
    const send = (ws, message) => ws.send(JSON.stringify(message));
    send(a, {type: 'reaction', kind: 'heart', x: .2, y: .3});
    await until(() => a.messages.some(message => message.type === 'error' && message.message.includes('Join')));
    for (const ws of [a, b]) send(ws, {type: 'join', roomId: 'lobby'});
    send(outsider, {type: 'join', roomId: other.id});
    await until(() => instance.rooms.get('lobby').members.size === 2 && instance.rooms.get(other.id).members.size === 1);
    const revision = instance.rooms.get('lobby').playback.revision;
    send(a, {type: 'reaction', kind: 'hitmarker', x: .25, y: .7, userId: 'forged', roomId: other.id});
    await until(() => b.messages.some(message => message.type === 'reaction'));
    const hit = b.messages.find(message => message.type === 'reaction');
    assert.equal(hit.kind, 'hitmarker');
    assert.equal(hit.x, .25);
    assert.equal(hit.y, .7);
    assert.equal(hit.userId, instance.accounts.users[0].id);
    assert.equal(hit.roomId, 'lobby');
    assert.deepEqual(a.messages.find(message => message.type === 'reaction'), hit);
    assert.ok(!outsider.messages.some(message => message.type === 'reaction'));
    send(a, {type: 'reaction', kind: 'metalpipe', x: .6, y: 0});
    await until(() => b.messages.some(message => message.type === 'reaction' && message.kind === 'metalpipe'));
    const pipe = b.messages.find(message => message.type === 'reaction' && message.kind === 'metalpipe');
    assert.deepEqual(a.messages.find(message => message.id === pipe.id), pipe);
    assert.ok(Number.isFinite(pipe.serverTime), 'Both clients anchor impact to the same server timestamp.');
    assert.ok(!outsider.messages.some(message => message.kind === 'metalpipe'));
    send(a, {type: 'reaction', kind: 'flashbang', x: .4, y: .65});
    await until(() => b.messages.some(message => message.type === 'reaction' && message.kind === 'flashbang'));
    const flash = b.messages.find(message => message.kind === 'flashbang');
    assert.deepEqual(a.messages.find(message => message.id === flash.id), flash);
    assert.ok(Number.isFinite(flash.serverTime));
    assert.ok(!outsider.messages.some(message => message.kind === 'flashbang'));
    send(a, {type: 'reaction', kind: 'biden', x: .4, y: .65});
    await until(() => b.messages.some(message => message.type === 'reaction' && message.kind === 'biden'));
    const biden = b.messages.find(message => message.kind === 'biden');
    assert.deepEqual(a.messages.find(message => message.id === biden.id), biden);
    assert.ok(Number.isFinite(biden.serverTime));
    assert.ok(!outsider.messages.some(message => message.kind === 'biden'));
    send(a, {type: 'reaction', kind: 'beachball', enabled: true});
    await until(() => b.messages.some(message => message.type === 'reactions:state' && message.ball));
    const first = b.messages.find(message => message.type === 'reactions:state' && message.ball);
    await until(() => b.messages.some(message => message.type === 'reactions:state' && message.ball && message.ball.x !== first.ball.x));
    assert.ok(!outsider.messages.some(message => message.type === 'reactions:state' && message.ball));
    const late = await connect();
    send(late, {type: 'join', roomId: 'lobby'});
    await until(() => late.messages.some(message => message.type === 'reactions:state' && message.ball));
    assert.ok(!late.messages.some(message => message.type === 'reaction'), 'Joining never replays old sounds.');
    send(b, {type: 'reaction:pointer', x: .4, y: .6});
    await until(() => instance.reactions.rooms.get('lobby').pointers.size === 1);
    send(b, {type: 'join', roomId: other.id});
    await until(() => instance.reactions.rooms.get('lobby').pointers.size === 0);
    send(a, {type: 'reaction', kind: 'hitmarker', x: 2, y: .5});
    await until(() => a.messages.some(message => message.type === 'error' && message.message.includes('position')));
    const beforeSpam = a.messages.filter(message => message.type === 'reaction').length;
    for (let index = 0; index < 12; index++) send(a, {type: 'reaction', kind: 'heart', x: .5, y: .5});
    await until(() => a.messages.some(message => message.type === 'error' && /many|limit|slow/i.test(message.message)));
    assert.ok(a.messages.filter(message => message.type === 'reaction').length - beforeSpam < 12);
    send(late, {type: 'reaction', kind: 'beachball', enabled: false});
    await until(() => !instance.reactions.rooms.has('lobby'));
    assert.equal(instance.rooms.get('lobby').playback.revision, revision);
});
