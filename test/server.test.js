import test from 'node:test';
import assert from 'node:assert/strict';
import { start, until } from './helpers.js';
import { makeItem } from '../server/rooms.js';

test('room owners and administrators can manage rooms, while other users cannot', async t => {
  const { instance, api, connect } = await start(t, { maxTranscoders: 0 });
  const member = (await api('/api/users', { method: 'POST', body: { username: 'roomowner', password: 'owner-password', role: 'user' } })).data.user;
  const login = await api('/api/login', { method: 'POST', body: { username: 'roomowner', password: 'owner-password' } });
  const auth = login.response.headers.get('set-cookie').split(';')[0];
  const created = await api('/api/rooms', { auth, method: 'POST', body: { name: 'Owned room', ownerId: 'forged' } });
  assert.equal(created.status, 201);
  assert.equal(created.data.room.ownerId, member.id);
  const id = created.data.room.id;
  const other = (await api('/api/rooms', { method: 'POST', body: { name: 'Another owner' } })).data.room;
  for (const method of ['PATCH', 'DELETE']) {
    assert.equal((await api(`/api/rooms/${other.id}`, { auth, method, body: { name: 'Forbidden' } })).status, 403);
    assert.equal((await api('/api/rooms/lobby', { auth, method, body: { name: 'Forbidden' } })).status, 403);
    assert.equal((await api(`/api/rooms/${id}`, { auth: '', method, body: { name: 'Forbidden' } })).status, 401);
  }
  const ws = await connect(auth);
  ws.send(JSON.stringify({ type: 'join', roomId: id }));
  await until(() => instance.rooms.get(id).members.size === 1);
  assert.equal((await api(`/api/rooms/${id}`, { auth, method: 'PATCH', body: { name: '   ' } })).status, 400);
  assert.equal((await api(`/api/rooms/${id}`, { auth, method: 'PATCH', body: { name: 'Renamed' } })).status, 200);
  await until(() => ws.messages.some(m => m.type === 'state' && m.room.name === 'Renamed'));
  assert.equal((await api(`/api/rooms/${id}`, { method: 'PATCH', body: { name: 'Admin edit' } })).status, 200);
  const upload = await instance.uploads.create(instance.rooms.get(id), member, { name: 'pending.mp4', size: 8 });
  assert.equal((await api(`/api/rooms/${id}`, { auth, method: 'DELETE' })).status, 200);
  assert.equal(instance.uploads.uploads.has(upload.uploadId), false);
  await until(() => ws.messages.some(m => m.type === 'rooms' && !m.rooms.some(r => r.id === id)));
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  await until(() => instance.rooms.get('lobby').members.size === 1);
  assert.equal((await api('/api/rooms/lobby', { method: 'DELETE' })).status, 200);
  assert.equal((await api(`/api/rooms/${id}`, { auth, method: 'PATCH', body: { name: 'Gone' } })).status, 404);
});

test('authenticated HTTP and two real WebSocket clients share controls and isolate rooms', async t => {
  const { instance, api, connect, url } = await start(t, { maxTranscoders: 0 });
  assert.equal((await api('/api/me', { auth: '' })).status, 401);
  assert.equal((await api('/api/rooms', { method: 'POST', body: { name: 'blocked' }, headers: { Origin: 'https://evil.test' } })).status, 403);
  const a = await connect();
  const b = await connect();
  a.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  b.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  await until(() => instance.rooms.get('lobby').members.size === 2);
  const room = instance.rooms.get('lobby');
  const item = makeItem({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=BaW_jenozKc' }, { duration: 60,
    status: 'ready', media: { url: '/media/test/index.m3u8', baseTime: 0, bufferedUntil: 60, complete: true } });
  instance.rooms.add(room, [item]);
  instance.rooms.tick();
  await until(() => b.messages.some(m => m.type === 'state' && !m.room.playback.paused));
  a.send(JSON.stringify({ type: 'control', action: 'pause', revision: room.playback.revision }));
  await until(() => b.messages.some(m => m.type === 'state' && m.room.playback.paused && m.room.playback.revision === room.playback.revision));
  assert.equal(room.playback.paused, true);
  b.send(JSON.stringify({ type: 'control', action: 'seek', position: 12, revision: room.playback.revision }));
  await until(() => room.playback.position === 12);
  const staleRevision = room.playback.revision - 1;
  a.send(JSON.stringify({ type: 'control', action: 'play', revision: staleRevision }));
  await until(() => a.messages.some(m => m.type === 'error' && m.message.includes('changed')));
  const other = (await api('/api/rooms', { method: 'POST', body: { name: 'Quiet room' } })).data.room;
  b.send(JSON.stringify({ type: 'join', roomId: other.id }));
  await until(() => instance.rooms.get(other.id).members.size === 1);
  assert.equal(instance.rooms.get(other.id).current, null);
  assert.equal(room.members.size, 1);
  a.send(JSON.stringify({ type: 'ping', sentAt: 123 }));
  await until(() => a.messages.some(m => m.type === 'pong' && m.sentAt === 123));
  assert.equal((await fetch(`${url}/internal/uploads/nope?key=wrong`)).status, 403);
  await api('/api/logout', { method: 'POST' });
  await until(() => a.messages.some(m => m.type === 'session-ended'));
});

test('upload endpoints enforce membership, offset, ownership, size and cancellation', async t => {
  const { instance, api, connect } = await start(t, { maxTranscoders: 0 });
  assert.equal(instance.capabilities.ffmpeg, true, 'FFmpeg must be installed for integration tests.');
  const body = { name: 'clip.mp4', size: 8, duration: 10 };
  assert.equal((await api('/api/rooms/lobby/uploads', { method: 'POST', body })).status, 403);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  await until(() => instance.rooms.get('lobby').members.size);
  const created = await api('/api/rooms/lobby/uploads', { method: 'POST', body });
  assert.equal(created.status, 201);
  const id = created.data.uploadId;
  const put = (offset, value) => api(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT', body: Buffer.from(value), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal((await put(1, 'abcd')).status, 409);
  assert.equal((await put(0, 'abcd')).data.received, 4);
  assert.equal((await put(4, '12345')).status, 400);
  assert.equal((await put(4, '1234')).data.complete, true);
  const user = await api('/api/users', { method: 'POST', body: { username: 'viewer', password: 'viewer-password', role: 'user' } });
  assert.equal(user.status, 201);
  const login = await api('/api/login', { method: 'POST', body: { username: 'viewer', password: 'viewer-password' } });
  const viewerCookie = login.response.headers.get('set-cookie').split(';')[0];
  assert.equal((await api('/api/users', { auth: viewerCookie })).status, 403);
  assert.equal((await api(`/api/uploads/${id}`, { auth: viewerCookie })).status, 403);
  assert.equal((await api(`/api/uploads/${id}`, { method: 'DELETE' })).status, 200);
  assert.equal(instance.rooms.get('lobby').current, null);
  assert.equal((await api(`/api/uploads/${id}`)).status, 404);
});

test('YouTube HTTP submissions honor start edits, opt-out, queue insertion and validation', async t => {
  const { instance, api, connect } = await start(t, { maxTranscoders: 0 });
  instance.capabilities.youtube = true;
  t.mock.method(instance.youtube, 'extract', async () => ({ id: 'BaW_jenozKc', duration: 120 }));
  const a = await connect();
  const b = await connect();
  for (const ws of [a, b]) ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const submit = body => api('/api/rooms/lobby/youtube', { method: 'POST',
    body: { url: 'https://youtube.com/watch?v=BaW_jenozKc&t=30', ...body } });
  assert.equal((await submit({})).status, 201);
  assert.equal(room.playback.position, 30);
  await until(() => b.messages.some(m => m.type === 'state' && m.room.playback.position === 30));
  assert.equal((await submit({ startAt: 45 })).status, 201);
  assert.equal((await submit({ startAt: 0, insertAt: 0 })).status, 201);
  assert.deepEqual(room.queue.map(item => item.startAt), [0, 45]);
  for (const startAt of [-1, null, '30', 1.5, 120, 200]) {
    const result = await submit({ startAt });
    assert.equal(result.status, 400, JSON.stringify(result.data));
    assert.match(result.data.error, /start time/i);
  }
  assert.equal(room.queue.length, 2, 'Invalid starts must not mutate the queue.');
  instance.rooms.advance(room);
  assert.equal(room.playback.position, 0);
  instance.rooms.advance(room);
  assert.equal(room.playback.position, 45);
});
