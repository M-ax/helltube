import test from 'node:test';
import assert from 'node:assert/strict';
import {Whiteboards} from '../server/whiteboard.js';
import {emptyWhiteboard, reduceWhiteboard, WHITEBOARD_MAX_SHAPES, WHITEBOARD_ROOM_POINTS} from '../shared/whiteboard.js';
import {whiteboardPath} from '../src/lib/whiteboard.js';
import {start, until} from './helpers.js';

function fixture() {
    const events = [];
    const service = new Whiteboards({broadcast: (roomId, message) => events.push(structuredClone(message))});
    const initial = service.snapshot('room');
    const send = (action, extra = {}, clientId = 'a', userId = 'alice') => service.command('room', clientId,
        {id: userId, displayName: userId}, {roomId: 'room', epoch: service.snapshot('room').epoch, action, ...extra});
    const begin = (id, extra = {}, clientId, userId) => send('begin',
        {id, tool: 'pen', color: '#ff975e', width: 4, point: [.2, .3], ...extra}, clientId, userId);
    return {service, events, initial, send, begin};
}

test('drawing input is bounded and attributed by the server; only its socket can extend a mark', () => {
    const h = fixture();
    for (const extra of [{id: '<svg>'}, {tool: 'script'}, {color: 'url(https://example.com)'}, {width: 400},
        {point: [NaN, .2]}, {point: [.1, 2]}, {point: [0, 1, 2]}]) {
        assert.throws(() => h.begin('mark', extra), {status: 400});
    }
    h.begin('mark', {clientId: 'forged', userId: 'forged', author: 'forged'});
    assert.equal(h.service.snapshot('room').shapes[0].userId, 'alice');
    assert.throws(() => h.send('draw', {id: 'mark', points: [[.3, .4]]}, 'b'), {status: 403});
    assert.throws(() => h.begin('second'), {status: 409});
    for (const points of [[], Array(33).fill([.2, .3]), [[Infinity, 0]], [[.1, '1']]]) {
        assert.throws(() => h.send('draw', {id: 'mark', points}), {status: 400});
    }
    assert.throws(() => h.send('erase', {ids: [null]}), {status: 400});
    h.send('draw', {id: 'mark', points: [[.4, .5], [.6, .7]]});
    h.send('end', {id: 'mark'});
    assert.equal(h.events.reduce(reduceWhiteboard, h.initial).shapes[0].points.length, 3);
    assert.deepEqual(h.events.reduce(reduceWhiteboard, h.initial).shapes, h.service.snapshot('room').shapes);
});

test('simultaneous shapes, personal undo, erasing, and clear converge without resurrecting in-flight strokes', () => {
    const h = fixture();
    h.begin('pen');
    h.begin('arrow', {tool: 'arrow'}, 'b', 'bob');
    h.send('draw', {id: 'pen', points: [[.4, .5]]});
    h.send('draw', {id: 'arrow', points: [[.5, .6], [.7, .8]]}, 'b', 'bob');
    h.send('end', {id: 'arrow'}, 'b', 'bob');
    h.send('end', {id: 'pen'});
    h.send('undo');
    assert.deepEqual(h.service.snapshot('room').shapes.map(shape => shape.id), ['arrow']);
    h.begin('new');
    h.send('erase', {ids: ['new']}, 'b', 'bob');
    assert.equal(h.send('draw', {id: 'new', points: [[.9, .9]]}), false);
    const oldEpoch = h.service.snapshot('room').epoch;
    h.send('clear');
    h.service.command('room', 'a', {id: 'alice'}, {roomId: 'room', epoch: oldEpoch, action: 'clear'});
    h.begin('fresh');
    assert.equal(h.service.command('room', 'a', {id: 'alice'},
        {roomId: 'room', epoch: oldEpoch, action: 'erase', ids: ['fresh']}), false);
    assert.equal(h.service.snapshot('room').shapes.length, 1);
    assert.deepEqual(h.events.reduce(reduceWhiteboard, h.initial).shapes, h.service.snapshot('room').shapes);
    h.service.leave('room', 'a');
    assert.equal(h.service.snapshot('room').shapes[0].complete, true);
    h.service.leave('room', 'b', true);
    assert.equal(h.service.rooms.size, 0);
});

test('room snapshots retain bounded recent history and reject oversized active strokes', () => {
    const h = fixture();
    for (let index = 0; index <= WHITEBOARD_MAX_SHAPES; index++) {
        h.begin(`mark-${index}`);
        h.send('end', {id: `mark-${index}`});
    }
    assert.equal(h.service.snapshot('room').shapes.length, WHITEBOARD_MAX_SHAPES);
    assert.equal(h.service.snapshot('room').shapes[0].id, 'mark-1');
    h.send('clear');
    for (let index = 0; index < 20; index++) {
        const id = `long-${index}`;
        h.begin(id);
        for (let batch = 0; batch < 31; batch++) h.send('draw', {id, points: Array(32).fill([.5, .6])});
        h.send('draw', {id, points: Array(31).fill([.5, .6])});
        assert.throws(() => h.send('draw', {id, points: [[.6, .7]]}), {status: 400});
        h.send('end', {id});
    }
    const snapshot = h.service.snapshot('room');
    assert.ok(snapshot.shapes.reduce((sum, shape) => sum + shape.points.length, 0) <= WHITEBOARD_ROOM_POINTS);
    assert.ok(JSON.stringify(snapshot).length < 1024 * 1024);
    assert.deepEqual(h.events.reduce(reduceWhiteboard, h.initial).shapes, snapshot.shapes);
});

test('SVG geometry scales normalized marks without script, NaN, or degenerate ellipse arcs', () => {
    for (const tool of ['pen', 'line', 'arrow', 'rectangle', 'ellipse']) {
        const shape = {tool, width: 4, points: [[.2, .3], [.8, .7]]};
        for (const [width, height] of [[960, 540], [390, 700]]) {
            const path = whiteboardPath(shape, width, height);
            assert.ok(!/NaN|Infinity|undefined/.test(path));
            assert.match(path, /^M/);
        }
    }
    assert.equal(whiteboardPath({tool: 'ellipse', width: 4, points: [[.2, .3], [.2, .7]]}, 100, 100), 'M20 30L20 70');
});

test('WebSockets stream before release, isolate rooms, recover snapshots, and preserve playback', async t => {
    const {instance, connect} = await start(t, {maxTranscoders: 0});
    const other = instance.rooms.create('Other board');
    const a = await connect(), b = await connect(), outsider = await connect();
    const send = (ws, message) => ws.send(JSON.stringify(message));
    send(a, {type: 'whiteboard', action: 'clear'});
    await until(() => a.messages.some(message => message.type === 'whiteboard:error'));
    for (const [ws, roomId] of [[a, 'lobby'], [b, 'lobby'], [outsider, other.id]]) send(ws, {type: 'join', roomId});
    await until(() => [a, b, outsider].every(ws => ws.messages.some(message => message.type === 'whiteboard:state')));
    const epoch = a.messages.find(message => message.type === 'whiteboard:state').epoch;
    const message = {type: 'whiteboard', roomId: 'lobby', epoch};
    const revision = instance.rooms.get('lobby').playback.revision;
    send(a, {...message, action: 'begin', id: 'live', tool: 'pen', color: '#ffffff', width: 4, point: [.1, .1], userId: 'forged'});
    for (let index = 0; index < 55; index++) send(a, {...message, action: 'draw', id: 'live', points: [[.2 + index / 100, .5]]});
    await until(() => b.messages.filter(value => value.type === 'whiteboard:event').length === 56);
    assert.equal(instance.whiteboards.snapshot('lobby').shapes[0].complete, false, 'Other viewers see the still-held stroke.');
    assert.ok(!a.messages.some(value => value.type === 'whiteboard:error' && value.id === 'live'), 'Drawing has its own streaming rate limit.');
    assert.ok(!outsider.messages.some(value => value.type === 'whiteboard:event'));
    send(a, {...message, action: 'clear', roomId: other.id});
    await until(() => a.messages.some(value => value.message === 'The whiteboard room changed.'));
    assert.equal(instance.whiteboards.snapshot('lobby').shapes.length, 1);
    a.close();
    await until(() => instance.whiteboards.snapshot('lobby').shapes[0].complete);
    const late = await connect();
    send(late, {type: 'join', roomId: 'lobby'});
    await until(() => late.messages.some(value => value.type === 'whiteboard:state'));
    const snapshot = late.messages.find(value => value.type === 'whiteboard:state');
    assert.equal(snapshot.shapes[0].points.length, 56);
    assert.notEqual(snapshot.shapes[0].userId, 'forged');
    send(b, {...message, action: 'clear'});
    await until(() => late.messages.some(value => value.type === 'whiteboard:state' && !value.shapes.length));
    assert.equal(instance.rooms.get('lobby').playback.revision, revision);
    instance.rooms.remove('lobby', instance.accounts.users[0]);
    assert.equal(instance.whiteboards.rooms.has('lobby'), false);
});
