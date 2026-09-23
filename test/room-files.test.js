import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile, appendFile, stat} from 'node:fs/promises';
import {createApp} from '../server/app.js';
import {start, until} from './helpers.js';
import {chunkSize} from '../server/uploads.js';

const options = {maxTranscoders: 0, ffmpeg: 'missing-ffmpeg', ytdlp: 'missing-ytdlp'};
async function join(h, cookie = h.cookie, roomId = 'lobby') {
  const ws = await h.connect(cookie);
  ws.send(JSON.stringify({type: 'join', roomId}));
  await until(() => ws.messages.some(message => message.type === 'files:state' && message.roomId === roomId));
  return ws;
}
async function account(h, username) {
  const user = await h.instance.accounts.create({username, displayName: username, password: 'test-password', role: 'user'});
  const login = await h.api('/api/login', {method: 'POST', body: {username, password: 'test-password'}});
  return {user, cookie: login.response.headers.get('set-cookie').split(';')[0]};
}
const create = (h, body = {}, auth = h.cookie, roomId = 'lobby') =>
  h.api(`/api/rooms/${roomId}/files`, {method: 'POST', auth, body: {name: 'notes.txt', size: 5, lastModified: 123, ...body}});
const put = (h, id, body, offset = 0, auth = h.cookie) =>
  h.api(`/api/files/${id}?offset=${offset}`, {method: 'PUT', auth, body: Buffer.from(body), headers: {'Content-Type': 'application/octet-stream'}});

test('room files require membership, share live with members and download exact bytes as attachments', async t => {
  const h = await start(t, options);
  assert.equal((await create(h)).status, 403);
  assert.equal((await h.api('/api/rooms/lobby/files', {auth: ''})).status, 401);
  const owner = await account(h, 'uploader');
  const viewer = await account(h, 'viewer');
  const adminSocket = await join(h);
  const uploaderSocket = await join(h, owner.cookie);
  const viewerSocket = await join(h, viewer.cookie);
  const result = await create(h, {name: 'unsafe.html'}, owner.cookie);
  assert.equal(result.status, 201);
  const id = result.data.file.id;
  assert.equal(h.instance.rooms.get('lobby').current, null);
  assert.equal(h.instance.rooms.get('lobby').queue.length, 0);
  await until(() => viewerSocket.messages.some(message => message.files?.some(file => file.id === id)));
  assert.equal((await h.api(`/api/files/${id}/download`, {auth: viewer.cookie})).status, 409);
  assert.equal((await put(h, id, 'hello', 0, viewer.cookie)).status, 403);
  assert.equal((await h.api(`/api/files/${id}`, {method: 'DELETE', auth: viewer.cookie})).status, 403);
  assert.equal((await put(h, id, 'hello', 0, owner.cookie)).status, 200);
  await until(() => viewerSocket.messages.some(message => message.files?.some(file => file.id === id && file.complete)));
  const download = await fetch(`${h.url}/api/files/${id}/download`, {headers: {Cookie: viewer.cookie}});
  assert.equal(download.status, 200);
  assert.equal(await download.text(), 'hello');
  assert.match(download.headers.get('content-disposition'), /^attachment;.*unsafe.html/);
  assert.match(download.headers.get('content-type'), /application\/octet-stream/);
  assert.match(download.headers.get('content-security-policy'), /sandbox/);
  assert.equal(download.headers.get('cache-control'), 'no-store');
  const range = await fetch(`${h.url}/api/files/${id}/download`, {headers: {Cookie: viewer.cookie, Range: 'bytes=1-3'}});
  assert.equal(range.status, 206);
  assert.equal(await range.text(), 'ell');
  viewerSocket.send(JSON.stringify({type: 'join', roomId: 'the-ben-zone'}));
  await until(() => viewerSocket.messages.some(message => message.type === 'files:state' && message.roomId === 'the-ben-zone'));
  assert.equal((await h.api(`/api/files/${id}/access`, {auth: viewer.cookie})).status, 403);
  assert.equal((await h.api('/api/rooms/the-ben-zone/files', {auth: viewer.cookie})).data.files.length, 0);
  assert.equal((await h.api(`/api/files/${id}`, {method: 'DELETE', auth: owner.cookie})).status, 200);
  await until(() => adminSocket.messages.at(-1)?.type === 'files:state' && !adminSocket.messages.at(-1).files.length);
  assert.equal((await h.api(`/api/files/${id}`, {auth: owner.cookie})).status, 404);
  assert.equal(uploaderSocket.readyState, 1);
});

test('file validation, bounded chunks, offsets, empty files and room-owner removal', async t => {
  const h = await start(t, {...options, maxUploadBytes: chunkSize * 2});
  await join(h);
  for (const body of [{name: '../escape'}, {name: 'a\\b'}, {name: 'a\r\nb'}, {size: -1}, {size: 1.5}, {size: chunkSize * 3}, {lastModified: -1}]) {
    assert.equal((await create(h, body)).status, 400, JSON.stringify(body));
  }
  const id = (await create(h)).data.file.id;
  assert.equal((await put(h, id, 'hello', 1)).status, 409);
  assert.equal((await put(h, id, '')).status, 400);
  assert.equal((await put(h, id, 'too long')).status, 400);
  assert.equal((await h.api(`/api/files/${id}`, {method: 'PUT', body: Buffer.from('hi'), headers: {'Content-Type': 'application/octet-stream'}})).status, 409);
  assert.equal((await put(h, id, 'hello')).status, 200);
  assert.equal((await put(h, id, 'x', 5)).status, 400);
  const big = (await create(h, {size: chunkSize + 1})).data.file.id;
  assert.equal((await put(h, big, Buffer.alloc(chunkSize + 1))).status, 413);
  const empty = (await create(h, {name: 'empty', size: 0})).data.file;
  assert.equal(empty.complete, true);
  const response = await fetch(`${h.url}/api/files/${empty.id}/download`, {headers: {Cookie: h.cookie}});
  assert.equal(response.status, 200);
  assert.equal((await response.arrayBuffer()).byteLength, 0);
  const owner = await account(h, 'room-owner');
  const room = h.instance.rooms.create('Owned room', undefined, owner.user.id);
  const ws = await join(h, owner.cookie, room.id);
  const admin = await join(h, h.cookie, room.id);
  const shared = (await create(h, {}, h.cookie, room.id)).data.file.id;
  assert.equal((await h.api(`/api/files/${shared}`, {method: 'DELETE', auth: owner.cookie})).status, 200);
  assert.equal(ws.readyState + admin.readyState, 2);
});

test('shared files and video uploads reserve the same account and server budgets', async t => {
  const h = await start(t, {...options, maxUserStorageBytes: 10, maxStorageBytes: 12, maxUserUploads: 2});
  await join(h);
  const id = (await create(h, {size: 8})).data.file.id;
  await assert.rejects(h.instance.uploads.create(h.instance.rooms.get('lobby'), h.instance.accounts.authenticate(h.cookie).user,
    {name: 'movie.mp4', size: 3}), {status: 409});
  assert.equal((await create(h, {size: 3})).status, 409);
  const second = await account(h, 'second-user');
  await join(h, second.cookie);
  assert.equal((await create(h, {size: 5}, second.cookie)).status, 507);
  await h.api(`/api/files/${id}`, {method: 'DELETE'});
  await h.instance.uploads.create(h.instance.rooms.get('lobby'), h.instance.accounts.authenticate(h.cookie).user,
    {name: 'movie.mp4', size: 8});
  assert.equal((await create(h, {size: 3})).status, 409);
  assert.equal((await create(h, {size: 0})).status, 201);
  assert.equal((await create(h, {size: 0})).status, 409);
});

test('files survive restarts, resume committed offsets, expire unfinished transfers and disappear with rooms', async t => {
  let now = Date.now();
  const h = await start(t, {...options, now: () => now, uploadIdleTimeoutMs: 1000});
  await join(h);
  const partial = (await create(h)).data.file.id;
  const finished = (await create(h, {size: 0})).data.file.id;
  assert.equal((await put(h, partial, 'he')).status, 200);
  const filePath = h.instance.roomFiles.diskPath(partial);
  await h.instance.close();
  await appendFile(filePath, 'uncommitted');
  const restarted = await createApp({...options, dataDir: h.dir, port: 0, desktopPort: 0, now: () => now, uploadIdleTimeoutMs: 1000});
  try {
    const file = restarted.roomFiles.get(partial);
    assert.equal(file.received, 2);
    assert.equal((await stat(filePath)).size, 2);
    assert.equal(restarted.roomFiles.get(finished).complete, true);
    await restarted.roomFiles.append(file, 2, Buffer.from('llo'), () => {});
    assert.equal(await readFile(filePath, 'utf8'), 'hello');
    const user = restarted.accounts.authenticate(h.cookie).user;
    const stale = await restarted.roomFiles.create(restarted.rooms.get('lobby'), user, {name: 'stale', size: 1}, () => {});
    now += 1001;
    await restarted.roomFiles.cleanup();
    assert.throws(() => restarted.roomFiles.get(stale.id), {status: 404});
    assert.equal(restarted.roomFiles.get(partial).complete, true);
    const url = await restarted.listen(0);
    const deleted = await fetch(`${url}/api/rooms/lobby`, {method: 'DELETE', headers: {Cookie: h.cookie}});
    assert.equal(deleted.status, 200);
    assert.equal(restarted.roomFiles.files.size, 0);
    await assert.rejects(stat(filePath), {code: 'ENOENT'});
  } finally { await restarted.close(); }
});

test('file reservations are atomic and failed writes or revoked access never advance the saved offset', async t => {
  const h = await start(t, {...options, maxUserStorageBytes: 5});
  await join(h);
  const results = await Promise.all([create(h), create(h)]);
  assert.deepEqual(results.map(result => result.status).sort(), [201, 409]);
  const id = results.find(result => result.status === 201).data.file.id;
  const file = h.instance.roomFiles.get(id);
  const save = h.instance.store.save.bind(h.instance.store);
  h.instance.store.save = (collection, ...args) => {
    if (collection === 'room-files') throw new Error('Simulated storage failure');
    return save(collection, ...args);
  };
  await assert.rejects(h.instance.roomFiles.append(file, 0, Buffer.from('hello'), () => {}), /storage failure/);
  assert.equal(file.received, 0);
  assert.equal(h.instance.store.load('room-files')[0].received, 0);
  h.instance.store.save = save;
  let checks = 0;
  await assert.rejects(h.instance.roomFiles.append(file, 0, Buffer.from('hello'), () => {
    if (++checks === 2) throw Object.assign(new Error('Left room'), {status: 403});
  }), {status: 403});
  assert.equal(file.received, 0);
  assert.equal((await put(h, id, 'hello')).status, 200);
  assert.equal(await readFile(h.instance.roomFiles.diskPath(id), 'utf8'), 'hello');
  await h.api(`/api/files/${id}`, {method: 'DELETE'});
  const spaced = await create(h, {name: ' notes.txt ', size: 0});
  assert.equal(spaced.data.file.name, ' notes.txt ');
});

test('split delivery scopes grants, bypasses the Worker, and revokes file access on leaving or logout', async t => {
  const origin = 'https://files.example.test';
  const frontend = 'https://watch.example.test';
  const h = await start(t, {...options, bareMetalOrigin: origin, origins: [frontend]});
  const ws = await join(h);
  const id = (await create(h)).data.file.id;
  assert.equal((await put(h, id, 'hello')).status, 409);
  const transfer = (await h.api(`/api/files/${id}`)).data.transferUrl;
  const direct = (url, options = {}) => fetch(url.replace(origin, h.url), options);
  const uploaded = await direct(transfer + '&offset=0', {method: 'PUT', body: 'hello',
    headers: {Origin: frontend, 'Content-Type': 'application/octet-stream', 'Sec-Fetch-Site': 'cross-site'}});
  assert.equal(uploaded.status, 200);
  assert.equal(uploaded.headers.get('access-control-allow-origin'), frontend);
  assert.equal((await h.api(`/api/files/${id}/download`)).status, 409);
  const access = (await h.api(`/api/files/${id}/access`)).data.url;
  const response = await direct(access, {headers: {'Sec-Fetch-Site': 'cross-site'}});
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'hello');
  assert.ok((await direct(transfer.replace('/files/' + id, '/files/' + id + '/download'))).status >= 400);
  assert.ok((await direct(access.replace(id, '00000000-0000-0000-0000-000000000000'))).status >= 400);
  assert.equal((await direct(access, {headers: {Origin: 'https://untrusted.test', 'Sec-Fetch-Site': 'cross-site'}})).status, 403);
  ws.send(JSON.stringify({type: 'join', roomId: 'the-ben-zone'}));
  await until(() => ws.messages.some(message => message.type === 'files:state' && message.roomId === 'the-ben-zone'));
  assert.equal((await direct(access)).status, 403);
  ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
  await until(() => h.instance.rooms.get('lobby').members.size === 1);
  await h.api('/api/logout', {method: 'POST'});
  assert.equal((await direct(access)).status, 401);
});
