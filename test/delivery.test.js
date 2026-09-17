import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

test('Twitch and hosted media use authorized encrypted edge delivery and direct keys', async t => {
  const { api, job, direct, url, cookie } = await fixture(t);
  for (const kind of ['twitch', 'http']) {
    const media = await job(kind);
    const access = await api(`/api/media/${media.id}/access`);
    assert.equal(access.data.url, `/media/${media.id}/index.m3u8`);
    const edgePath = `/api/edge/media/${media.id}/segment-000000.ts`;
    assert.equal((await api(edgePath)).status, 403);
    assert.equal((await api(edgePath, { headers: { 'X-Helltube-Edge': secret } })).data.cacheable, true);
    const playlist = await fetch(url + access.data.url, { headers: { Cookie: cookie } });
    assert.equal(playlist.status, 200);
    const contents = await playlist.text();
    assert.match(contents, /\nsegment-000000\.ts\n/);
    const keyUrl = contents.match(/URI="([^"]+)"/)[1];
    assert.equal(new URL(keyUrl).origin, origin);
    assert.deepEqual(Buffer.from(await (await direct(keyUrl)).arrayBuffer()), media.key);
  }
});

test('original quality uses its own authorized delivery, key and fallback grant', async t => {
  const {instance, api, job, direct, url, cookie} = await fixture(t);
  const standard = await job('twitch');
  const original = await job('twitch');
  instance.media.jobs.delete(original.item.id);
  original.item = standard.item;
  standard.original = original;
  const access = (await api(`/api/media/${original.id}/access`)).data;
  assert.equal(access.url, `/media/${original.id}/index.m3u8`);
  const playlist = await direct(access.fallbackUrl);
  assert.equal(playlist.status, 200);
  const contents = await playlist.text();
  const keyUrl = contents.match(/URI="([^"]+)"/)[1];
  assert.deepEqual(Buffer.from(await (await direct(keyUrl)).arrayBuffer()), original.key);
  assert.equal((await direct(keyUrl.replace(original.id, standard.id))).status, 401);
  const segmentUrl = contents.split('\n').find(line => line.startsWith('https://'));
  assert.equal((await direct(segmentUrl)).status, 200);
  const edge = `/api/edge/media/${original.id}/segment-000000.ts`;
  assert.equal((await api(edge, {headers: {'X-Helltube-Edge': secret}})).data.cacheable, true);
  assert.equal((await fetch(url + access.url)).status, 401);
  assert.equal((await fetch(url + access.url, {headers: {Cookie: cookie}})).status, 200);
  original.failed = new Error('Copy failed');
  assert.equal((await api(`/api/media/${original.id}/access`)).status, 404);
  assert.equal((await api(`/api/media/${standard.id}/access`)).status, 200);
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
  assert.deepEqual(await readFile(path.join(upload.dir, 'segment-000000.ts')), Buffer.alloc(32, 0xa5));
  const segment = await direct(segmentUrl);
  assert.equal(segment.status, 200);
  assert.deepEqual(Buffer.from(await segment.arrayBuffer()), Buffer.alloc(32, 0xa5));
  assert.equal(segment.headers.get('cache-control'), 'no-store');
  const range = await direct(segmentUrl, { headers: { Range: 'bytes=0-15' } });
  assert.equal(range.status, 206);
  assert.equal(range.headers.get('content-range'), 'bytes 0-15/32');
  assert.deepEqual(Buffer.from(await range.arrayBuffer()), Buffer.alloc(16, 0xa5));
  await writeFile(path.join(upload.dir, '.secret'), 'private');
  assert.equal((await direct(segmentUrl.replace('segment-000000.ts', '.secret'))).status, 404);
  assert.equal((await direct(segmentUrl.replace('segment-000000.ts', '..%2Fsegment-000000.ts'))).status, 404);
  const youtubeSegment = await fetch(`${url}/media/${youtube.id}/segment-000000.ts`, { headers: { Cookie: cookie, 'X-Helltube-Edge': secret } });
  assert.equal(youtubeSegment.status, 200);
  assert.deepEqual(Buffer.from(await youtubeSegment.arrayBuffer()), Buffer.alloc(32, 0xa5));
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

test('YouTube fallback playlists and segments bypass the edge with live, scoped authorization', async t => {
  const {api, job, direct, room, instance, cookie} = await fixture(t);
  const youtube = await job('youtube');
  const access = (await api(`/api/media/${youtube.id}/access`)).data;
  assert.equal(access.url, `/media/${youtube.id}/index.m3u8`);
  assert.match(access.fallbackUrl, /^https:\/\/metal\.example\.net\/direct\/media\/.+\/index\.m3u8\?grant=/);
  const response = await direct(access.fallbackUrl);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), frontend);
  const playlist = await response.text();
  const segment = playlist.split('\n').find(line => line.startsWith(origin));
  assert.ok(segment?.includes('/direct/media/') && segment.includes('?grant='));
  assert.equal(new URL(segment).search, new URL(access.fallbackUrl).search);
  const content = await direct(segment);
  assert.equal(content.status, 200);
  assert.deepEqual(Buffer.from(await content.arrayBuffer()), Buffer.alloc(32, 0xa5));
  assert.equal((await direct(segment, {headers: {'X-Helltube-Edge': secret}})).status, 403);
  assert.equal((await direct(segment.split('?')[0])).status, 401);
  assert.equal((await api(`/api/media/${youtube.id}/access`, {auth: ''})).status, 401);
  room.members.clear();
  assert.equal((await api(`/api/media/${youtube.id}/access`)).status, 403);
  assert.equal((await direct(access.fallbackUrl)).status, 403);
  assert.equal((await direct(segment)).status, 403);
  instance.accounts.logout(cookie.slice('session='.length));
  assert.equal((await direct(access.fallbackUrl)).status, 401);
  assert.equal((await direct(segment)).status, 401);
});

test('SponsorBlock gaps reach both edge and direct HLS without changing grants or encryption', async t => {
  const { api, job, direct, url, cookie } = await fixture(t);
  const youtube = await job('youtube');
  youtube.baseTime = 40;
  youtube.item.sponsorSegments = [[40, 42]];
  const access = (await api(`/api/media/${youtube.id}/access`)).data;
  for (const response of [
    await fetch(url + access.url, { headers: { Cookie: cookie, 'X-Helltube-Edge': secret } }),
    await direct(access.fallbackUrl),
  ]) {
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /#EXTINF:2.0,\n#EXT-X-GAP\n/);
    assert.match(text, /METHOD=AES-128,URI="https:\/\/metal\.example\.net\/direct\/media\/[^\"]+key\.bin\?grant=/);
  }
});

test('all proxied media kinds receive metal fallback access while uploads start on metal', async t => {
  const {api, job} = await fixture(t);
  for (const kind of ['youtube', 'twitch', 'http', 'upload']) {
    const media = await job(kind);
    const {data, status} = await api(`/api/media/${media.id}/access`);
    assert.equal(status, 200);
    if (kind === 'upload') {
      assert.ok(data.url.startsWith(`${origin}/direct/`));
      assert.equal(data.fallbackUrl, undefined);
    } else {
      assert.equal(data.url, `/media/${media.id}/index.m3u8`);
      assert.ok(data.fallbackUrl.startsWith(`${origin}/direct/`));
    }
  }
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
