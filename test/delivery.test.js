import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, until } from './helpers.js';
import { makeItem } from '../server/rooms.js';
import { DirectAccess } from '../server/direct-access.js';
import { deploymentOrigin, securityHeaders } from '../shared/deployment.js';

const frontend = 'https://watch.example.com';
const origin = 'https://metal.example.net';
const secret = 'test-edge-secret-with-at-least-32-characters';

async function fixture(t) {
  const context = await start(t, { bareMetalOrigin: origin, edgeProxySecret: secret, origins: [frontend], maxTranscoders: 0 });
  const ws = await context.connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = context.instance.rooms.get('lobby');
  await until(() => room.members.size);
  const job = async kind => {
    const item = makeItem({ kind, url: 'https://youtu.be/BaW_jenozKc' }, { duration: 30 });
    context.instance.rooms.add(room, [item]);
    const id = randomUUID();
    const dir = path.join(context.instance.media.dir, id);
    const keyDir = path.join(context.instance.media.keyDir, id);
    await mkdir(dir, { recursive: true });
    await mkdir(keyDir, { recursive: true });
    await writeFile(path.join(dir, 'index.m3u8'), `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/direct/media/${id}/key.bin"\n#EXTINF:2.0,\nsegment-000000.ts\n`);
    await writeFile(path.join(dir, 'segment-000000.ts'), Buffer.alloc(32, 0xa5));
    const value = { id, dir, keyDir, item, key: randomBytes(16), done: true };
    context.instance.media.jobs.set(item.id, value);
    return value;
  };
  const direct = (url, options = {}) => {
    const target = new URL(url);
    return fetch(context.url + target.pathname + target.search, { ...options,
      headers: { Origin: frontend, 'Sec-Fetch-Site': 'cross-site', ...options.headers } });
  };
  return { ...context, job, direct, room, ws };
}

test('deployment origins and CSP reject credentials, paths and insecure public hosts', () => {
  assert.equal(deploymentOrigin(''), '');
  assert.equal(deploymentOrigin(`${origin}/`), origin);
  assert.equal(deploymentOrigin('http://127.0.0.1:3000'), 'http://127.0.0.1:3000');
  for (const value of ['http://metal.example.net', 'https://user:pass@metal.example.net', `${origin}/keys`, `${origin}?q=1`,
    `${origin}#fragment`, 'data:text/plain,x', 'https://metal.example.net\n', null]) assert.throws(() => deploymentOrigin(value));
  const headers = securityHeaders(origin);
  assert.match(headers['Content-Security-Policy'], /media-src 'self' blob: https:\/\/metal.example.net;/);
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('direct grants are resource-scoped, survive restart, and enforce live session expiry/revocation', async t => {
  const { instance, cookie } = await start(t, { maxTranscoders: 0 });
  const auth = instance.accounts.authenticate(cookie);
  const access = new DirectAccess(instance.accounts);
  const grant = access.issue(auth, 'media:one');
  assert.ok(!grant.includes(auth.token));
  assert.equal(access.authenticate(grant, 'media:one').user.id, auth.user.id);
  assert.equal(new DirectAccess(instance.accounts).authenticate(grant, 'media:one').user.id, auth.user.id);
  for (const scope of ['media:two', 'upload:one']) assert.throws(() => access.authenticate(grant, scope), { status: 401 });
  for (const value of [grant + '0', '', {}, `${grant.slice(0, -1)}${grant.endsWith('0') ? '1' : '0'}`]) {
    assert.throws(() => access.authenticate(value, 'media:one'), { status: 401 });
  }
  instance.accounts.sessions.get(auth.token).expires = Date.now() - 1;
  assert.throws(() => access.authenticate(grant, 'media:one'), { status: 401 });
  access.prune();
  assert.equal(access.sessions.size, 0);
});

test('YouTube keys bypass the Worker; uploaded playlists and segments are direct and private', async t => {
  const { api, job, direct, room, instance, url, cookie } = await fixture(t);
  const youtube = await job('youtube');
  const upload = await job('upload');
  assert.equal((await api('/api/config')).data.bareMetalOrigin, origin);
  assert.equal((await api(`/api/media/${youtube.id}/access`)).data.url, `/media/${youtube.id}/index.m3u8`);
  const playlist = await fetch(`${url}/media/${youtube.id}/index.m3u8`, { headers: { Cookie: cookie, 'X-Helltube-Edge': secret } });
  assert.equal(playlist.status, 200);
  assert.equal(playlist.headers.get('cache-control'), 'no-store');
  const text = await playlist.text();
  assert.match(text, /\nsegment-000000\.ts\n/);
  const keyUrl = text.match(/URI="([^"]+)"/)[1];
  assert.equal(new URL(keyUrl).origin, origin);
  const key = await direct(keyUrl);
  assert.equal(key.status, 200);
  assert.deepEqual(Buffer.from(await key.arrayBuffer()), youtube.key);
  assert.equal(key.headers.get('access-control-allow-origin'), frontend);
  assert.equal(key.headers.get('access-control-allow-credentials'), null);
  assert.equal(key.headers.get('cache-control'), 'no-store');
  assert.equal((await direct(keyUrl, { headers: { 'X-Helltube-Edge': secret } })).status, 403);
  assert.equal((await direct(keyUrl.split('?')[0], { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await direct(keyUrl.replace(youtube.id, upload.id))).status, 401);
  const access = (await api(`/api/media/${upload.id}/access`)).data.url;
  assert.equal(new URL(access).origin, origin);
  const uploadedPlaylist = await direct(access);
  assert.equal(uploadedPlaylist.status, 200);
  const uploadedText = await uploadedPlaylist.text();
  const segmentUrl = uploadedText.split('\n').find(line => line.startsWith(origin));
  assert.match(segmentUrl, /\/direct\/media\/.+\/segment-000000\.ts\?grant=/);
  const segment = await direct(segmentUrl);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get('cache-control'), 'no-store');
  assert.equal((await direct(segmentUrl, { headers: { Range: 'bytes=0-15' } })).status, 206);
  assert.equal((await fetch(`${url}/media/${upload.id}/segment-000000.ts`, { headers: { Cookie: cookie } })).status, 409);
  const edge = id => api(`/api/edge/media/${id}/segment-000000.ts`, { headers: { 'X-Helltube-Edge': secret } });
  assert.deepEqual((await edge(youtube.id)).data, { cacheable: true });
  assert.equal((await edge(upload.id)).status, 403);
  assert.equal((await api(`/api/edge/media/${youtube.id}/segment-000000.ts`)).status, 403);
  assert.equal((await api(`/api/edge/media/${youtube.id}/segment-000001.ts`, { headers: { 'X-Helltube-Edge': secret } })).status, 404);
  room.members.clear();
  assert.equal((await edge(youtube.id)).status, 403);
  assert.equal((await direct(keyUrl)).status, 403);
  assert.equal((await direct(segmentUrl)).status, 403);
  instance.accounts.logout(cookie.slice('session='.length));
  assert.equal((await direct(keyUrl)).status, 401);
});

test('direct chunk uploads support CORS, offsets and revocation without cross-site API access', async t => {
  const { api, direct, url, cookie } = await fixture(t);
  const create = () => api('/api/rooms/lobby/uploads', { method: 'POST', body: { name: 'sample.mp4', size: 8, duration: 10 } });
  const first = (await create()).data.uploadId;
  const second = (await create()).data.uploadId;
  const transferUrl = (await api(`/api/uploads/${first}`)).data.transferUrl;
  const put = (offset, body, headers = {}) => direct(`${transferUrl}&offset=${offset}`, {
    method: 'PUT', body, headers: { 'Content-Type': 'application/octet-stream', ...headers },
  });
  const preflight = await direct(transferUrl, { method: 'OPTIONS', headers: {
    'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), frontend);
  assert.equal((await put(0, 'abcd', { Origin: 'https://evil.test' })).status, 403);
  assert.equal((await direct(transferUrl.replace(first, second), { method: 'PUT', body: 'abcd',
    headers: { 'Content-Type': 'application/octet-stream' } })).status, 401);
  assert.equal((await put(1, 'abcd')).status, 409);
  const partial = await put(0, 'abcd');
  assert.equal(partial.status, 200);
  assert.equal((await partial.json()).received, 4);
  assert.equal((await put(4, '12345')).status, 400);
  assert.equal((await (await put(4, '1234')).json()).complete, true);
  assert.equal((await fetch(`${url}/api/uploads/${first}?offset=0`, { method: 'PUT', body: 'x',
    headers: { Cookie: cookie, 'Content-Type': 'application/octet-stream' } })).status, 409);
  assert.equal((await api('/api/me', { headers: { Origin: frontend, 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await api('/api/me', { headers: { 'X-Helltube-Edge': 'wrong' } })).status, 403);
  await api('/api/logout', { method: 'POST' });
  assert.equal((await put(8, '')).status, 401);
});