import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile, readFile, stat, readdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { Rooms, makeItem } from '../server/rooms.js';
import { StateStore } from '../server/store.js';
import { start, until } from './helpers.js';

test('room checkpoints recover order, playlists, five-item history and a frozen clock without live members or stale media', async t => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'rooms-db-'));
  const store = new StateStore(dir);
  await store.init();
  t.after(() => { store.close(); return rm(dir, { recursive: true, force: true }); });
  let now = 100000;
  const rooms = new Rooms({ store, now: () => now });
  const room = rooms.create('Persistent cinema');
  const items = Array.from({ length: 12 }, (_, i) => makeItem({ kind: 'youtube', url: `video-${i}` }, {
    title: `Video ${i}`, duration: 120, playlistId: i > 8 ? 'playlist' : null, playlistTitle: 'Mix', startAt: 4,
  }));
  rooms.add(room, items);
  for (let i = 0; i < 7; i++) rooms.advance(room);
  rooms.mutateQueue(room, { type: 'queue:move', itemId: items[11].id, toIndex: 0 });
  room.current.media = { url: '/media/stale/index.m3u8', baseTime: 0, bufferedUntil: 120, complete: true };
  room.current.status = 'ready';
  room.members.set('dead-socket', { id: 'user', displayName: 'Not online' });
  rooms.tick();
  now += 12500;
  rooms.tick();
  const revision = room.playback.revision;
  store.close();
  await store.init();
  now += 86400000;
  const restored = new Rooms({ store, now: () => now });
  const actual = restored.get(room.id);
  assert.equal(actual.name, room.name);
  assert.equal(actual.current.id, items[7].id);
  assert.deepEqual(actual.queue.map(i => i.id), [items[11].id, items[8].id, items[9].id, items[10].id]);
  assert.equal(actual.queue[0].playlistId, 'playlist');
  assert.deepEqual(actual.history.map(i => i.id), items.slice(2, 7).reverse().map(i => i.id));
  assert.equal(actual.current.media, null);
  assert.equal(actual.current.source.startAt, 16.5);
  assert.equal(actual.current.startAt, 4);
  assert.equal(restored.position(actual), 16.5, 'Offline time does not advance the room.');
  assert.equal(actual.playback.paused, true);
  assert.equal(actual.resumeWhenReady, true);
  assert.equal(actual.members.size, 0);
  assert.ok(actual.playback.revision > revision);
  assert.throws(() => restored.control(actual, { action: 'play', revision }), /changed/);
  const lobby = restored.get('lobby');
  lobby.name = 'A checkpoint that must retry';
  actual.name = 'reject checkpoint';
  store.db.exec(`CREATE TRIGGER reject_checkpoint BEFORE INSERT ON documents
    WHEN NEW.collection = 'rooms' AND json_extract(NEW.value, '$.name') = 'reject checkpoint'
    BEGIN SELECT RAISE(ABORT, 'test checkpoint failure'); END`);
  assert.throws(() => restored.checkpoint(), /test checkpoint failure/);
  assert.notEqual(store.load('rooms').find(r => r.id === 'lobby').name, lobby.name);
  store.db.exec('DROP TRIGGER reject_checkpoint');
  restored.checkpoint();
  assert.equal(store.load('rooms').find(r => r.id === 'lobby').name, lobby.name, 'A rolled-back checkpoint must not poison the write cache.');
});

test('SQLite restart preserves sessions, account volume and resumable upload bytes, while clearing old managed data', async t => {
  const { instance, dir, cookie, api } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const user = instance.accounts.users[0];
  assert.equal((await api('/api/me/preferences', { method: 'PATCH', body: { volume: .23, muted: true } })).status, 200);
  assert.equal((await api('/api/me/preferences', { method: 'PATCH', body: { volume: 2 } })).status, 400);
  assert.equal((await api('/api/me/preferences', { method: 'PATCH', auth: '', body: { volume: .5 } })).status, 401);
  const completeId = (await instance.uploads.create(room, user, { name: 'complete.mp4', size: 4, duration: 30 })).uploadId;
  await instance.uploads.append(instance.uploads.get(completeId), 0, Buffer.from('done'), 1);
  const partialId = (await instance.uploads.create(room, user, { name: 'partial.mp4', size: 8, duration: 30, lastModified: 123 })).uploadId;
  await instance.uploads.append(instance.uploads.get(partialId), 0, Buffer.from('part'), 1);
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  await instance.close();
  await appendFile(path.join(dir, 'uploads', partialId), 'tail');
  await mkdir(path.join(dir, 'media', 'old-process'), { recursive: true });
  await writeFile(path.join(dir, 'media', 'old-process', 'segment.ts'), 'obsolete');
  await mkdir(path.join(dir, 'uploads', 'old-process'), { recursive: true });
  await writeFile(path.join(dir, 'uploads', 'old-process', 'partial'), 'obsolete');
  await writeFile(path.join(dir, 'keep.txt'), 'unrelated');
  const restarted = await createApp({ dataDir: dir, port: 0, maxTranscoders: 0 });
  t.after(() => restarted.close());
  const url = await restarted.listen(0);
  const me = await fetch(`${url}/api/me`, { headers: { Cookie: cookie } });
  assert.equal(me.status, 200, 'The original session survives restart.');
  assert.deepEqual((await me.json()).user.preferences, { volume: .23, muted: true });
  assert.equal(restarted.rooms.get('lobby').current.id, room.current.id);
  assert.equal(restarted.rooms.get('lobby').resumeWhenReady, false);
  assert.equal(restarted.uploads.get(completeId).complete, true);
  const partial = restarted.uploads.get(partialId);
  assert.equal(partial.received, 4);
  assert.equal(partial.complete, false);
  assert.equal(await readFile(partial.file, 'utf8'), 'part', 'Unacknowledged crash tail is discarded.');
  const listing = await fetch(`${url}/api/uploads`, { headers: { Cookie: cookie } }).then(r => r.json());
  assert.deepEqual(listing.uploads.map(u => [u.id, u.received, u.lastModified]), [[partialId, 4, 123]]);
  await restarted.uploads.append(partial, 4, Buffer.from('rest'), 1);
  assert.equal(await readFile(partial.file, 'utf8'), 'partrest');
  assert.equal(partial.complete, true);
  assert.equal(restarted.rooms.get('lobby').queue[0].source.complete, true);
  await assert.rejects(stat(path.join(dir, 'uploads', 'old-process')), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(dir, 'media', 'old-process')), { code: 'ENOENT' });
  assert.equal(await readFile(path.join(dir, 'keep.txt'), 'utf8'), 'unrelated');
  assert.equal((await readFile(path.join(dir, 'helltube.sqlite'))).subarray(0, 15).toString(), 'SQLite format 3');
  await restarted.close();
});

test('periodic cleanup deletes unreferenced files but protects current, queue and the last five history sources', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0, cleanupIntervalMs: 100 });
  const room = instance.rooms.get('lobby');
  const user = instance.accounts.users[0];
  const uploads = [];
  for (let i = 0; i < 9; i++) {
    const { uploadId } = await instance.uploads.create(room, user, { name: `clip-${i}.mp4`, size: 4, duration: 30 });
    uploads.push(instance.uploads.get(uploadId));
  }
  const historyDir = path.join(instance.media.dir, 'history-job');
  const historyKeyDir = path.join(instance.media.keyDir, 'history-job');
  await mkdir(historyDir);
  await mkdir(historyKeyDir);
  await writeFile(path.join(historyDir, 'index.m3u8'), 'keep');
  const key = Buffer.alloc(16, 1);
  await writeFile(path.join(historyKeyDir, 'key.bin'), key);
  instance.media.jobs.set(uploads[2].item.id, { id: 'history-job', item: uploads[2].item, done: true,
    dir: historyDir, keyDir: historyKeyDir, key });
  for (let i = 0; i < 7; i++) instance.rooms.advance(room);
  await writeFile(path.join(instance.uploads.dir, 'orphan'), 'delete');
  await mkdir(path.join(instance.media.dir, 'orphan-job'));
  await mkdir(path.join(dir, 'media', 'orphan-run'));
  await until(async () => !(await readdir(instance.uploads.dir)).includes('orphan') &&
    !(await readdir(instance.media.dir)).includes('orphan-job') && !(await readdir(path.join(dir, 'media'))).includes('orphan-run'));
  await instance.cleanup();
  for (const upload of uploads.slice(0, 2)) {
    await assert.rejects(stat(upload.file), { code: 'ENOENT' });
    assert.equal(instance.store.load('uploads').some(u => u.id === upload.id), false);
  }
  for (const upload of uploads.slice(2)) assert.ok((await stat(upload.file)).isFile());
  assert.equal(await readFile(path.join(historyDir, 'index.m3u8'), 'utf8'), 'keep');
  assert.deepEqual(await readFile(path.join(historyKeyDir, 'key.bin')), key);
  instance.rooms.advance(room);
  await instance.cleanup();
  await assert.rejects(stat(historyDir), { code: 'ENOENT' });
  await assert.rejects(stat(historyKeyDir), { code: 'ENOENT' });
  assert.deepEqual(key, Buffer.alloc(16));
  await assert.rejects(stat(uploads[2].file), { code: 'ENOENT' });
  assert.ok((await stat(instance.store.file)).isFile());
});

test('a second backend cannot clean an active server data directory', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const file = path.join(instance.media.dir, 'active');
  await writeFile(file, 'do not delete');
  await assert.rejects(createApp({ dataDir: dir, port: 0, maxTranscoders: 0 }), /already in use/);
  assert.equal(await readFile(file, 'utf8'), 'do not delete');
  assert.ok(instance.accounts.authenticate(`session=${(await instance.accounts.login('admin', 'garbageTime_')).token}`));
});

test('missing upload sources fail visibly after restart without losing queue or database state', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const { uploadId } = await instance.uploads.create(room, instance.accounts.users[0], { name: 'missing.mp4', size: 4, duration: 10 });
  const source = instance.uploads.get(uploadId).file;
  const next = makeItem({ kind: 'youtube', url: 'https://youtu.be/BaW_jenozKc' });
  instance.rooms.add(room, [next]);
  await instance.close();
  await rm(source);
  const restarted = await createApp({ dataDir: dir, port: 0, maxTranscoders: 0 });
  t.after(() => restarted.close());
  const restored = restarted.rooms.get('lobby');
  assert.equal(restored.current.status, 'error');
  assert.match(restored.current.error, /source is missing/);
  assert.equal(restored.current.media, null);
  assert.equal(restored.queue[0].id, next.id);
  assert.equal(restarted.uploads.uploads.size, 0);
  assert.equal(restarted.store.load('uploads').length, 0);
  assert.equal(restarted.accounts.users.length, 1);
  await restarted.close();
});