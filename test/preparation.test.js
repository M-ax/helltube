import test from 'node:test';
import assert from 'node:assert/strict';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';

test('metadata status reaches room viewers before items exist and concurrent requests clean up independently', async t => {
    const {instance, api, connect} = await start(t, {maxTranscoders: 0});
    instance.capabilities.ffmpeg = true;
    const room = instance.rooms.get('lobby');
    const ws = await connect();
    ws.send(JSON.stringify({type: 'join', roomId: room.id}));
    await until(() => room.members.size === 1);
    const gates = [Promise.withResolvers(), Promise.withResolvers()];
    t.after(() => gates.forEach(gate => gate.resolve()));
    let calls = 0;
    t.mock.method(instance.remote, 'items', async () => {
        const index = calls++;
        await gates[index].promise;
        if (index === 0) throw new Error('Metadata lookup failed');
        return [makeItem({kind: 'http', url: 'https://example.com/video.mp4'}, {title: 'A video'})];
    });
    const submit = () => api('/api/rooms/lobby/media', {method: 'POST', body: {url: 'https://example.com/video.mp4'}});
    const first = submit();
    await until(() => calls === 1);
    const second = submit();
    await until(() => calls === 2);
    await until(() => ws.messages.some(message => message.room?.preparation?.stage === 'metadata' && !message.room.current));
    const status = instance.rooms.snapshot(room).preparation;
    assert.deepEqual(Object.keys(status).sort(), ['id', 'kind', 'stage']);
    gates[0].resolve();
    assert.equal((await first).status, 500);
    assert.notEqual(instance.rooms.snapshot(room).preparation.id, status.id);
    gates[1].resolve();
    assert.equal((await second).status, 201);
    assert.equal(instance.rooms.snapshot(room).preparation, null);
    assert.equal(room.current.title, 'A video');
});

test('upload byte progress is visible to the room and restored after restart', async t => {
    const {instance} = await start(t, {maxTranscoders: 0});
    const room = instance.rooms.get('lobby');
    const user = {id: 'fixture', displayName: 'Uploader'};
    const result = await instance.uploads.create(room, user, {name: 'clip.mp4', size: 8});
    const upload = instance.uploads.get(result.uploadId);
    assert.deepEqual(instance.rooms.snapshot(room).current.uploadProgress, {received: 0, total: 8, complete: false});
    await instance.uploads.append(upload, 0, Buffer.from('1234'), 10);
    assert.deepEqual(instance.rooms.snapshot(room).current.uploadProgress, {received: 4, total: 8, complete: false});
    const {Rooms} = await import('../server/rooms.js');
    const {Uploads} = await import('../server/uploads.js');
    const rooms = new Rooms({store: instance.store});
    const uploads = new Uploads(instance.uploads.config, rooms, instance.store);
    await uploads.init();
    assert.deepEqual(rooms.snapshot(rooms.get('lobby')).current.uploadProgress, {received: 4, total: 8, complete: false});
});
