import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { createApp } from '../server/app.js';
import { start, until } from './helpers.js';

const badLogin = { username: 'nobody', password: 'incorrect-password' };
const goodLogin = { username: 'admin', password: 'garbageTime_' };

test('login throttling isolates visitors behind the configured loopback proxy', async t => {
  const { api, instance } = await start(t, { trustProxy: true, maxTranscoders: 0 });
  const trusts = instance.app.get('trust proxy fn');
  assert.equal(trusts('127.0.0.1'), true);
  assert.equal(trusts('::1'), true);
  assert.equal(trusts('192.0.2.1'), false);
  assert.equal(trusts('2001:db8::1'), false);
  const login = (ip, body = badLogin) => api('/api/login', { method: 'POST', body,
    headers: { 'X-Forwarded-For': ip } });
  for (let i = 0; i < 10; i++) assert.equal((await login('192.0.2.1')).status, 401);
  assert.equal((await login('192.0.2.1', goodLogin)).status, 429);
  assert.equal((await login('192.0.2.2', goodLogin)).status, 200);
  // A caller cannot smuggle a different leftmost address past nginx's peer address.
  assert.equal((await login('192.0.2.99, 192.0.2.1', goodLogin)).status, 429);
});

test('direct callers cannot rotate forwarding headers to evade login throttling', async t => {
  const { api } = await start(t, { maxTranscoders: 0 });
  const login = index => api('/api/login', { method: 'POST', body: badLogin, headers: {
    'X-Forwarded-For': `192.0.2.${index}`, 'X-Real-IP': `192.0.2.${index}`,
    'CF-Connecting-IP': `192.0.2.${index}`, 'X-Helltube-Client-IP': `192.0.2.${index}`,
  } });
  // The helper's successful initial login also counts against this socket address.
  for (let i = 1; i <= 9; i++) assert.equal((await login(i)).status, 401);
  assert.equal((await login(10)).status, 429);
});

test('authenticated edge client addresses have separate login budgets', async t => {
  const secret = 'project-local-test-secret-'.repeat(2);
  const { api } = await start(t, { edgeProxySecret: secret, maxTranscoders: 0 });
  const login = (ip, body = badLogin, marker = secret) => api('/api/login', { method: 'POST', body,
    headers: { 'X-Helltube-Edge': marker, 'X-Helltube-Client-IP': ip } });
  assert.equal((await login('192.0.2.1', badLogin, 'forged')).status, 403);
  for (let i = 0; i < 10; i++) assert.equal((await login('192.0.2.1')).status, 401);
  assert.equal((await login('192.0.2.1', goodLogin)).status, 429);
  assert.equal((await login('2001:db8::2', goodLogin)).status, 200);
  // Invalid addresses fall back to the connection, rather than becoming arbitrary keys.
  for (let i = 0; i < 9; i++) assert.equal((await login(`invalid-${i}`)).status, 401);
  assert.equal((await login('another-invalid', goodLogin)).status, 429);
});

test('account upload quotas reserve atomically and leave capacity for other accounts', async t => {
  const { instance } = await start(t, { maxTranscoders: 0, maxUploadBytes: 10,
    maxStorageBytes: 30, maxUserStorageBytes: 15, maxUploads: 6, maxUserUploads: 3 });
  const { uploads, rooms, store } = instance;
  const room = rooms.get('lobby');
  const alice = { id: 'alice', displayName: 'Alice' };
  const bob = { id: 'bob', displayName: 'Bob' };
  const file = size => ({ name: 'video.mp4', size });
  await assert.rejects(uploads.createBatch(room, alice, { files: Array(3).fill(file(10)) }), { status: 409 });
  assert.equal(room.current, null);
  assert.equal(store.load('uploads').length, 0);
  assert.deepEqual(await readdir(uploads.dir), []);
  const results = await Promise.allSettled([uploads.create(room, alice, file(8)), uploads.create(room, alice, file(8))]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const first = uploads.get(results.find(result => result.status === 'fulfilled').value.uploadId);
  await uploads.append(first, 0, Buffer.alloc(8), 1);
  await assert.rejects(uploads.create(room, alice, file(8)), { status: 409 }, 'Completed sources still count toward the quota.');
  await uploads.createBatch(room, alice, { files: [file(1), file(1)] });
  await assert.rejects(uploads.create(room, alice, file(1)), { status: 409 }, 'Tiny reservations cannot monopolize all slots.');
  await uploads.create(room, bob, file(10));
  assert.equal(uploads.uploads.size, 4);
});

test('incomplete reservations expire on inactivity, persist progress, and release current/queued/history sources', async t => {
  let now = 100000;
  const options = { maxTranscoders: 0, cleanupIntervalMs: 3600000, uploadIdleTimeoutMs: 1000, now: () => now };
  const { instance, dir } = await start(t, options);
  const { uploads, rooms } = instance;
  const room = rooms.get('lobby');
  const result = await uploads.createBatch(room, instance.accounts.users[0], {
    files: Array.from({ length: 5 }, (_, i) => ({ name: `video-${i}.mp4`, size: 4 })),
  });
  const [history, current, queued, progressing, completed] = result.uploads.map(u => uploads.get(u.uploadId));
  rooms.advance(room);
  await uploads.append(completed, 0, Buffer.alloc(4), 1);
  now += 800;
  await assert.rejects(uploads.append(current, 1, Buffer.alloc(1), 1), { status: 409 });
  await uploads.append(progressing, 0, Buffer.alloc(1), 1);
  uploads.status(current);
  uploads.list(current.userId);
  assert.equal(current.lastProgressAt, 100000, 'Polling does not renew a reservation.');
  assert.equal(instance.store.load('uploads').find(u => u.id === progressing.id).lastProgressAt, now);
  // Simulate an older persisted record from before lastProgressAt was introduced.
  history.lastProgressAt = undefined;
  await instance.close();
  now += 300;
  const restored = await createApp({ ...options, dataDir: dir, port: 0 });
  try {
    for (const expired of [history, current, queued]) assert.throws(() => restored.uploads.get(expired.id), { status: 404 });
    const restoredRoom = restored.rooms.get('lobby');
    assert.equal(restoredRoom.current.source.uploadId, progressing.id);
    assert.deepEqual(restoredRoom.history, []);
    assert.equal(restored.uploads.get(progressing.id).received, 1);
    assert.equal(restored.uploads.get(completed.id).complete, true);
    assert.equal((await readdir(restored.uploads.dir)).length, 2);
    now += 800;
    restored.uploads.get(progressing.id).busy = true;
    await restored.uploads.cleanup();
    assert.equal(restored.uploads.get(progressing.id).received, 1, 'An in-flight write is not expired.');
    restored.uploads.get(progressing.id).busy = false;
    await restored.uploads.cleanup();
    assert.equal(restoredRoom.current.source.uploadId, completed.id);
    assert.equal(restored.uploads.uploads.size, 1);
    assert.equal(restored.store.load('uploads').length, 1);
    assert.equal((await readdir(restored.uploads.dir)).length, 1);
  } finally { await restored.close(); }
});

test('repeated same-room joins preserve membership and cause no room broadcasts', async t => {
  const { instance, connect } = await start(t, { maxTranscoders: 0 });
  const a = await connect();
  const b = await connect();
  const send = (ws, message) => ws.send(JSON.stringify(message));
  for (const ws of [a, b]) send(ws, { type: 'join', roomId: 'lobby' });
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  for (const ws of [a, b]) send(ws, { type: 'ping', sentAt: 0 });
  await until(() => [a, b].every(ws => ws.messages.some(m => m.type === 'pong')));
  const before = new Map(room.members);
  a.messages.length = b.messages.length = 0;
  for (let i = 0; i < 5; i++) send(a, { type: 'join', roomId: 'lobby' });
  send(a, { type: 'ping', sentAt: 123 });
  await until(() => a.messages.some(m => m.type === 'pong' && m.sentAt === 123));
  send(b, { type: 'ping', sentAt: 456 });
  await until(() => b.messages.some(m => m.type === 'pong' && m.sentAt === 456));
  assert.deepEqual(room.members, before);
  for (const ws of [a, b]) assert.equal(ws.messages.filter(m => ['state', 'rooms', 'reactions:state'].includes(m.type)).length, 0);
  const other = instance.rooms.create('Other room');
  send(a, { type: 'join', roomId: other.id });
  await until(() => other.members.size === 1);
  assert.equal(room.members.size, 1);
});
