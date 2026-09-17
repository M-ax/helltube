import test from 'node:test';
import assert from 'node:assert/strict';
import {Reactions} from '../server/reactions.js';
import {start, until} from './helpers.js';

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
