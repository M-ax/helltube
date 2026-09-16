import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, stat } from 'node:fs/promises';
import { inferPlaylistTitle } from '../server/upload-playlist.js';
import { createApp } from '../server/app.js';
import { start, until } from './helpers.js';

test('upload playlist names use common words anywhere in every filename, not extensions or partial words', () => {
  assert.equal(inferPlaylistTitle(['Night Walk - 01.mp4', 'Night Walk - 02.mkv']), 'Night Walk');
  assert.equal(inferPlaylistTitle(['01 - Night Walk.MP4', '02 - Night Walk.webm']), 'Night Walk');
  assert.equal(inferPlaylistTitle(['Clip01.mp4', 'Clip02.mp4', 'Clip03.mkv']), 'Clip');
  assert.equal(inferPlaylistTitle(['Summer Road Trip 01.mp4', 'Summer Road Trip 02.mp4', 'Winter Road Trip 03.mov']), 'Road Trip');
  assert.equal(inferPlaylistTitle(['cat.mp4', 'catch.mp4']), 'Uploaded videos');
  assert.equal(inferPlaylistTitle(['Sunset.mp4', 'Mountain.mp4']), 'Uploaded videos');
  assert.equal(inferPlaylistTitle(['001.mp4', '002.mp4']), 'Uploaded videos');
  assert.equal(inferPlaylistTitle([]), 'Uploaded videos');
});

test('upload playlist names tolerate casing, punctuation, unicode and identical basenames', () => {
  assert.equal(inferPlaylistTitle(['My_Show.E01.mp4', 'my-show E02.mkv']), 'My Show');
  assert.equal(inferPlaylistTitle(['Été à Paris - 01.mp4', 'ÉTÉ_À_PARIS - 02.webm']), 'Été à Paris');
  assert.equal(inferPlaylistTitle(["John's Trip - A.mp4", "John's Trip - B.mov"]), "John's Trip");
  assert.equal(inferPlaylistTitle(['[Studio] Our Show 01.mp4', '[Studio] Our Show 02.mp4']), 'Studio Our Show');
  assert.equal(inferPlaylistTitle(['Same title.mp4', 'Same title.mkv']), 'Same title');
  assert.equal(inferPlaylistTitle(['旅行 01.mp4', '旅行 02.mp4']), '旅行');
});

const files = ['Night Walk - 01.mp4', 'Night Walk - 02.mkv', 'Night Walk - 03.webm']
  .map((name, index) => ({ name, size: 4, duration: 60, lastModified: index + 123 }));

test('batch upload API shares an ordered playlist, paces current/next files and removes only its own queued group', async t => {
  const { instance, api, connect } = await start(t, { maxTranscoders: 0 });
  const submit = (body, options = {}) => api('/api/rooms/lobby/uploads/batch', { method: 'POST', body, ...options });
  assert.equal((await submit({ files }, { auth: '' })).status, 401);
  assert.equal((await submit({ files })).status, 403);
  const a = await connect();
  const b = await connect();
  for (const ws of [a, b]) ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const created = await submit({ files });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const { playlistId, playlistTitle, uploads } = created.data;
  assert.ok(playlistId);
  assert.equal(playlistTitle, 'Night Walk');
  assert.equal(uploads.length, 3);
  const items = [room.current, ...room.queue];
  assert.deepEqual(items.map(item => item.title), files.map(file => file.name));
  assert.deepEqual(items.map(item => [item.playlistId, item.playlistTitle]), files.map(() => [playlistId, playlistTitle]));
  assert.deepEqual(items.map(item => item.source.uploadId), uploads.map(upload => upload.uploadId));
  assert.deepEqual(uploads.map(upload => instance.uploads.status(instance.uploads.get(upload.uploadId)).active), [true, true, false]);
  await until(() => b.messages.some(m => m.type === 'state' && m.room.queue.length === 2 && m.room.queue[1].playlistId === playlistId));
  const first = instance.uploads.get(uploads[0].uploadId);
  const put = await api(`/api/uploads/${first.id}?offset=0`, {
    method: 'PUT', body: Buffer.from('data'), headers: { 'Content-Type': 'application/octet-stream' },
  });
  assert.equal(put.status, 200);
  assert.equal(put.data.complete, true);
  assert.equal(await readFile(first.file, 'utf8'), 'data');
  const another = await submit({ files: files.slice(0, 2), insertAt: 1 });
  assert.equal(another.status, 201);
  assert.notEqual(another.data.playlistId, playlistId, 'Identically named submissions are distinct playlists.');
  assert.deepEqual(room.queue.map(item => item.source.uploadId), [uploads[1].uploadId,
    ...another.data.uploads.map(upload => upload.uploadId), uploads[2].uploadId]);
  a.send(JSON.stringify({ type: 'queue:move', itemId: items[2].id, toIndex: 0 }));
  await until(() => room.queue[0].id === items[2].id);
  a.send(JSON.stringify({ type: 'queue:remove-playlist', playlistId }));
  await until(() => room.queue.length === 2);
  await instance.cleanup();
  assert.equal(room.current.id, items[0].id, 'Removing a playlist leaves the playing video on screen.');
  assert.ok(room.queue.every(item => item.playlistId === another.data.playlistId));
  assert.ok((await stat(first.file)).isFile());
  assert.equal(instance.uploads.uploads.size, 3);
  assert.equal(instance.store.load('uploads').length, 3);
});

test('batch upload metadata and playlist identity survive a backend restart and a single file remains ungrouped', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const result = await instance.uploads.createBatch(room, instance.accounts.users[0], { files });
  const upload = instance.uploads.get(result.uploads[0].uploadId);
  await instance.uploads.append(upload, 0, Buffer.from('pa'), 1);
  await instance.close();
  const restarted = await createApp({ dataDir: dir, maxTranscoders: 0 });
  t.after(() => restarted.close());
  const restored = restarted.rooms.get('lobby');
  const items = [restored.current, ...restored.queue];
  assert.deepEqual(items.map(item => item.title), files.map(file => file.name));
  assert.ok(items.every(item => item.playlistId === result.playlistId && item.playlistTitle === 'Night Walk'));
  assert.equal(restarted.uploads.get(upload.id).received, 2);
  const single = await restarted.uploads.create(restored, restarted.accounts.users[0], files[0]);
  assert.equal(restored.queue.at(-1).source.uploadId, single.uploadId);
  assert.equal(restored.queue.at(-1).playlistId, null);
  assert.equal(restored.queue.at(-1).playlistTitle, null);
  await restarted.close();
});

test('invalid batches and capacity failures do not create files, upload rows or partial queue items', async t => {
  const { instance } = await start(t, { maxTranscoders: 0, maxQueue: 3, maxStorageBytes: 16, maxUploadBytes: 10 });
  const room = instance.rooms.get('lobby');
  const create = body => instance.uploads.createBatch(room, instance.accounts.users[0], body);
  for (const value of [null, 'files', [], Array(101).fill(files[0])]) {
    await assert.rejects(create({ files: value }), { status: 400 });
  }
  for (const invalid of [null, { ...files[0], size: 0 }, { ...files[0], size: 11 },
    { ...files[0], duration: -1 }, { ...files[0], lastModified: -1 }, { ...files[0], name: '' }]) {
    await assert.rejects(create({ files: [files[0], invalid] }), { status: 400 });
  }
  await assert.rejects(create({ files, insertAt: -1 }), { status: 400 });
  await assert.rejects(create({ files: Array(4).fill(files[0]) }), { status: 409 });
  await assert.rejects(create({ files: files.map(file => ({ ...file, size: 8 })) }), { status: 507 });
  assert.equal(room.current, null);
  assert.deepEqual(room.queue, []);
  assert.equal(instance.uploads.uploads.size, 0);
  assert.deepEqual(instance.store.load('uploads'), []);
  assert.deepEqual(await readdir(instance.uploads.dir), []);
});

test('batch creation rolls back SQLite and memory before broadcasting if persistence fails', async t => {
  const { instance } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const before = instance.store.load('rooms');
  const changes = [];
  instance.rooms.on('state', () => changes.push(room.version));
  instance.store.db.exec(`CREATE TRIGGER reject_batch BEFORE INSERT ON documents
    WHEN NEW.collection = 'rooms' AND json_extract(NEW.value, '$.current.playlistTitle') = 'Night Walk'
    BEGIN SELECT RAISE(ABORT, 'test playlist persistence failure'); END`);
  await assert.rejects(instance.uploads.createBatch(room, instance.accounts.users[0], { files }), /test playlist persistence failure/);
  assert.equal(room.current, null);
  assert.deepEqual(room.queue, []);
  assert.equal(room.version, 0);
  assert.deepEqual(changes, []);
  assert.deepEqual(instance.store.load('rooms'), before);
  assert.deepEqual(instance.store.load('uploads'), []);
  assert.equal(instance.uploads.uploads.size, 0);
  assert.deepEqual(await readdir(instance.uploads.dir), []);
  instance.store.db.exec('DROP TRIGGER reject_batch');
  await instance.uploads.createBatch(room, instance.accounts.users[0], { files });
  assert.equal(room.queue.length, 2);
  assert.equal(changes.length, 1);
});

test('concurrent upload batches reserve their full storage budget before opening files', async t => {
  const { instance } = await start(t, { maxTranscoders: 0, maxStorageBytes: 16 });
  const room = instance.rooms.get('lobby');
  const results = await Promise.allSettled(Array.from({ length: 2 }, () =>
    instance.uploads.createBatch(room, instance.accounts.users[0], { files })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 507);
  assert.equal(instance.uploads.uploads.size, 3);
  assert.equal(room.queue.length, 2);
  assert.equal((await readdir(instance.uploads.dir)).length, 3);
});