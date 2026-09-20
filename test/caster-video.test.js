import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {randomUUID} from 'node:crypto';
import {NativeFrameDecoder, NativeVideo, nativeCaptureOptions} from '../apps/caster/main/video.js';
import {casterPresets} from '../shared/desktop-quality.js';

function packet({width = 4, height = 2, sequence = 1, timestamp = 100} = {}) {
    const bytes = Buffer.alloc(32 + width * height * 4);
    [0x31564348, width, height, width * height * 4, sequence, 0].forEach((v, i) => bytes.writeUInt32LE(v, i * 4));
    bytes.writeBigUInt64LE(BigInt(timestamp), 24);
    bytes.fill(127, 32);
    return bytes;
}
test('native frame decoder handles fragmented headers/pixels and consecutive frames without losing boundaries', () => {
    const frames = [], decoder = new NativeFrameDecoder(frame => frames.push(frame));
    const bytes = Buffer.concat([packet(), packet({sequence: 2, width: 2, height: 4, timestamp: 200})]);
    for (let position = 0; position < bytes.length; position += 3) decoder.push(bytes.subarray(position, position + 3));
    assert.deepEqual(frames.map(({width, height, sequence, timestamp}) => ({width, height, sequence, timestamp})),
        [{width: 4, height: 2, sequence: 1, timestamp: 100}, {width: 2, height: 4, sequence: 2, timestamp: 200}]);
    assert.ok(frames.every(frame => frame.pixels.length === 32 && frame.pixels.every(value => value === 127)));
    assert.equal(decoder.payload, null);
});
test('native frame decoder rejects oversized allocations, malformed sizes and stale timestamps or sequences', () => {
    for (const modify of [
        bytes => bytes.writeUInt32LE(0, 0), bytes => bytes.writeUInt32LE(100000, 4),
        bytes => bytes.writeUInt32LE(100000, 8), bytes => bytes.writeUInt32LE(0xffffffff, 12),
        bytes => bytes.writeBigUInt64LE(2n ** 63n, 24),
    ]) {
        const bytes = packet(); modify(bytes);
        const decoder = new NativeFrameDecoder(() => assert.fail('An invalid frame cannot escape the decoder.'));
        assert.throws(() => decoder.push(bytes), /Invalid frame/);
        assert.equal(decoder.payload, null);
    }
    const decoder = new NativeFrameDecoder(() => {});
    decoder.push(packet({timestamp: 200}));
    assert.throws(() => decoder.push(packet({sequence: 2, timestamp: 100})), /Invalid frame/);
    const repeated = new NativeFrameDecoder(() => {});
    repeated.push(packet()); assert.throws(() => repeated.push(packet()), /Invalid frame/);
    assert.throws(() => new NativeFrameDecoder(() => {}, {width: 2, height: 2}).push(packet()), /Invalid frame/);
});
test('native capture bounds match every quality preset and clamp hostile or incomplete requests', () => {
    for (const quality of Object.values(casterPresets)) {
        const options = nativeCaptureOptions({quality});
        assert.deepEqual([options.width, options.height, options.frameRate], [quality.width, quality.height, quality.frameRate]);
    }
    const options = nativeCaptureOptions({quality: {width: 99999, height: -1, frameRate: 1000},
        region: {x: 7, y: NaN, width: -1, height: Infinity}, showCursor: false});
    assert.deepEqual(options, {width: 1920, height: 180, frameRate: 60, region: {x: .99, y: 0, width: .01, height: 1}, showCursor: false});
    assert.equal(nativeCaptureOptions({quality: null}).width, 1280);
});
function harness() {
    const source = {id: 'native:window:123:456', kind: 'window', handle: '123', pid: 456};
    const children = [], events = [], starts = [];
    const video = new NativeVideo({helper: 'test-helper', emit: event => events.push(event),
        runProcess: async () => ({stdout: JSON.stringify([source])}),
        spawnProcess: (executable, args, options) => {
            starts.push({executable, args, options});
            const child = new EventEmitter();
            child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
            child.input = ''; child.killed = false;
            child.stdin.on('data', bytes => { child.input += bytes.toString(); });
            child.kill = () => { child.killed = true; };
            children.push(child); return child;
        }});
    return {video, source, children, events, starts};
}
test('native capture pins the selected window and allows one outstanding frame; stale acknowledgements cannot resume another session', async () => {
    const {video, source, children, starts, events} = harness();
    await video.list('window');
    const id = randomUUID(), ready = video.start({sourceId: source.id, sessionId: id, showCursor: false});
    const child = children[0];
    assert.equal(child.input, 'n');
    assert.deepEqual(starts[0].args.slice(0, 4), ['capture', 'window', '123', '456']);
    assert.equal(starts[0].args.at(-1), '0');
    assert.equal(starts[0].options.windowsHide, true);
    child.stdout.write(packet()); await ready;
    assert.equal(events[0].id, id); assert.equal(events[0].type, 'video-frame');
    assert.equal(child.input, 'n', 'No next frame until the renderer consumes this one');
    video.acknowledge(randomUUID(), 1); video.acknowledge(id, 2);
    assert.equal(child.input, 'n');
    video.acknowledge(id, 1); video.acknowledge(id, 1);
    assert.equal(child.input, 'nn', 'Duplicate acknowledgements cannot increase the queue allowance');
    video.stop(id); assert.equal(child.killed, true);
    const nextId = randomUUID(), next = video.start({sourceId: source.id, sessionId: nextId});
    children[1].stdout.write(packet()); await next;
    video.acknowledge(id, 1); video.stop(id); child.emit('exit', 1);
    assert.equal(children[1].killed, false); assert.equal(children[1].input, 'n');
    assert.equal(video.capture.id, nextId);
    video.stop();
});
test('native capture rejects unknown sources and overlapping starts instead of falling back to desktop capture', async () => {
    const {video, source, children} = harness();
    await video.list('window');
    assert.throws(() => video.start({sourceId: 'unknown', sessionId: randomUUID()}), /available native capture/);
    assert.equal(children.length, 0);
    const ready = video.start({sourceId: source.id, sessionId: randomUUID()});
    const rejected = assert.rejects(ready, /stopped before the first frame/);
    assert.throws(() => video.start({sourceId: source.id, sessionId: randomUUID()}), /Stop the current/);
    video.stop(); await rejected;
    assert.equal(children[0].killed, true);
});
test('a helper that ignores frame credit is stopped and an active helper failure ends capture', async () => {
    const {video, source, children, events} = harness();
    await video.list('window');
    const ready = video.start({sourceId: source.id, sessionId: randomUUID()});
    children[0].stdout.write(packet()); await ready;
    children[0].stdout.write(packet({sequence: 2}));
    assert.equal(video.capture, null); assert.equal(children[0].killed, true);
    assert.match(events.at(-1).message, /frame allowance/);
    const next = video.start({sourceId: source.id, sessionId: randomUUID()});
    children[1].stdout.write(packet()); await next;
    children[1].stderr.write('The selected window closed.'); children[1].emit('exit', 1);
    assert.equal(video.capture, null); assert.equal(events.at(-1).type, 'video-ended');
    assert.equal(events.at(-1).message, 'The selected window closed.');
});
