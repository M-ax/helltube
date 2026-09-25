import test from 'node:test';
import assert from 'node:assert/strict';
import {carveSeams} from '../src/lib/content-aware.js';
import {sprayGeometry} from '../src/lib/spray.js';
import {keyGreen} from '../src/lib/mlg.js';
import {Whiteboards} from '../server/whiteboard.js';
import {reduceWhiteboard, SPRAY_TIPS, WHITEBOARD_MAX_POINTS} from '../shared/whiteboard.js';

test('content-aware carving preserves a high-energy subject instead of uniformly scaling it', () => {
    const width = 16, height = 8;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4;
        data[i] = x === 8 ? 255 : 0;
        data[i + 3] = 255;
    }
    const result = carveSeams({data, width, height}, 6);
    assert.equal(result.width, 6);
    for (let y = 0; y < height; y++) {
        const row = Array.from(result.data.slice(y * 24, (y + 1) * 24)).filter((_, i) => i % 4 === 0);
        assert.equal(row.filter(value => value === 255).length, 1, 'The sharp stripe survives removing the empty background.');
    }
    assert.equal(data[8 * 4], 255, 'Input pixels remain unchanged.');
});

test('spray caps differ, use deterministic paint, and grow drips in proportion to stationary exposure', () => {
    const shape = {id: 'spray-1', tool: 'spray', tip: 'fat', width: 4, color: '#ffffff', points: Array(30).fill([.5, .3])};
    const first = sprayGeometry(shape);
    assert.deepEqual(first, sprayGeometry(structuredClone(shape)));
    const longer = sprayGeometry({...shape, points: Array(60).fill([.5, .3])});
    assert.ok(longer.drips[0].length > first.drips[0].length * 2);
    assert.equal(sprayGeometry({...shape, points: Array(10).fill([.5, .3])}).drips.length, 0);
    assert.equal(sprayGeometry({...shape, points: Array.from({length: 60}, (_, i) => [i / 60, .3])}).drips.length, 0);
    assert.equal(new Set(SPRAY_TIPS.map(tip => sprayGeometry({...shape, tip: tip.id}).dots)).size, 4);
    assert.ok(sprayGeometry({...shape, points: Array(1000).fill([.5, .99])}).drips[0].length <= 5.41);
});

test('spray samples retain cap and dwell across server events, snapshots, limits and undo', () => {
    const events = [];
    const board = new Whiteboards({broadcast: (_room, event) => events.push(structuredClone(event))});
    const initial = board.snapshot('room');
    const send = (action, extra) => board.command('room', 'client', {id: 'user'},
        {roomId: 'room', epoch: initial.epoch, action, ...extra});
    const mark = {id: 'paint', tool: 'spray', color: '#ffffff', width: 4, point: [.4, .4]};
    assert.throws(() => send('begin', {...mark, tip: 'invalid'}), {status: 400});
    send('begin', {...mark, tip: 'chisel'});
    for (let i = 0; i < 31; i++) send('draw', {id: 'paint', points: Array(32).fill([.4, .4])});
    send('draw', {id: 'paint', points: Array(31).fill([.4, .4])});
    assert.equal(board.snapshot('room').shapes[0].points.length, WHITEBOARD_MAX_POINTS);
    assert.throws(() => send('draw', {id: 'paint', points: [[.4, .4]]}), {status: 400});
    send('end', {id: 'paint'});
    const reduced = events.reduce(reduceWhiteboard, initial);
    assert.deepEqual(reduced.shapes, board.snapshot('room').shapes);
    assert.equal(reduced.shapes[0].tip, 'chisel');
    send('undo');
    assert.equal(board.snapshot('room').shapes.length, 0);
});

test('MLG chroma key removes green and fringes while retaining black rifle pixels', () => {
    const data = new Uint8ClampedArray([0, 210, 0, 255, 4, 4, 4, 255, 130, 150, 130, 255, 240, 90, 20, 255]);
    keyGreen(data);
    assert.equal(data[3], 0);
    assert.equal(data[7], 255);
    assert.ok(data[11] > 0 && data[11] < 255);
    assert.equal(data[15], 255);
});
