import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv } from 'node:crypto';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, until } from './helpers.js';
import { makeItem } from '../server/rooms.js';
import { createApp } from '../server/app.js';
import { WebSocket } from 'ws';

const exec = promisify(execFile);

async function encryptedHLS(instance, url, cookie, item, contents) {
  const job = instance.media.jobs.get(item.id);
  assert.ok(Buffer.isBuffer(job.key));
  assert.equal(job.key.length, 16);
  const keyURI = `/direct/media/${job.id}/key.bin`;
  assert.match(contents, /#EXT-X-KEY:METHOD=AES-128,/);
  assert.equal((await fetch(url + keyURI)).status, 401);
  assert.equal((await fetch(url + keyURI, { headers: { Cookie: 'session=invalid' } })).status, 401);
  const response = await fetch(url + keyURI, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('cache-control'), /\bno-store\b/);
  const key = Buffer.from(await response.arrayBuffer());
  assert.deepEqual(key, job.key);
  assert.equal((await fetch(`${url}/media/${job.id}/key.bin`, { headers: { Cookie: cookie } })).status, 404);
  assert.equal((await fetch(`${url}/media/${job.id}/key-info`, { headers: { Cookie: cookie } })).status, 404);
  const keyFile = path.resolve(job.keyDir, 'key.bin');
  const keyInfoFile = path.join(job.keyDir, 'key-info');
  assert.ok(path.relative(path.dirname(instance.media.dir), keyFile).startsWith(`..${path.sep}`));
  assert.deepEqual(await readFile(keyFile), key);
  assert.equal(await readFile(keyInfoFile, 'utf8'), `${keyURI}\n${keyFile}\n`, 'Key-info omits an explicit IV.');
  if (process.platform !== 'win32') {
    for (const dir of [path.dirname(instance.media.keyDir), instance.media.keyDir, job.keyDir]) {
      assert.equal((await stat(dir)).mode & 0o777, 0o700);
    }
    for (const file of [keyFile, keyInfoFile]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  }
  assert.equal(Object.hasOwn(item, 'key'), false);
  assert.deepEqual(Object.keys(item.media).sort(), ['baseTime', 'bufferedUntil', 'complete', 'url']);
  for (const secret of [JSON.stringify(key), key.toString('hex'), key.toString('base64'), keyFile]) {
    assert.equal(JSON.stringify(item).includes(secret), false, 'Serialized items must not contain key material or private paths.');
  }
  let sequence = BigInt(contents.match(/^#EXT-X-MEDIA-SEQUENCE:(\d+)/m)?.[1] || '0');
  let keyTag;
  const decodedSegments = [];
  for (const line of contents.split(/\r?\n/)) {
    if (line.startsWith('#EXT-X-KEY:')) keyTag = line;
    if (!line || line.startsWith('#')) continue;
    assert.match(line, /^segment-\d{6,}\.ts$/, 'Local segments stay relative.');
    assert.equal(keyTag?.match(/URI="([^"]+)"/)?.[1], keyURI);
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(sequence++, 8);
    const declaredIV = keyTag.match(/IV=0x([\da-f]+)/i)?.[1];
    if (declaredIV) assert.equal(declaredIV.toLowerCase().padStart(32, '0'), iv.toString('hex'));
    const segment = await fetch(new URL(line, url + item.media.url), { headers: { Cookie: cookie } });
    assert.equal(segment.status, 200);
    const encrypted = Buffer.from(await segment.arrayBuffer());
    assert.ok(encrypted.length > 1000);
    assert.equal(encrypted.length % 16, 0);
    const decipher = createDecipheriv('aes-128-cbc', key, iv);
    const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    assert.notDeepEqual(encrypted, decrypted);
    assert.equal(decrypted.length % 188, 0, 'Decrypted segments contain whole MPEG-TS packets.');
    for (let offset = 0; offset < decrypted.length; offset += 188) assert.equal(decrypted[offset], 0x47);
    decodedSegments.push(decrypted);
    if (decodedSegments.length === 2) break;
  }
  assert.equal(decodedSegments.length, 2, 'Check sequence IVs on at least two segments.');
  return { job, key, decodedSegments };
}

test('YouTube HLS input with separate audio becomes playable server HLS', { timeout: 30000 }, async t => {
  const { instance, connect, url, cookie, dir } = await start(t);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-map', '0:v:0', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod',
    '-hls_segment_filename', path.join(dir, 'source-%d.ts'), path.join(dir, 'source.m3u8'),
    '-map', '1:a:0', '-t', '8', '-c:a', 'libopus', path.join(dir, 'source.webm')]);
  instance.app.get('/youtube-source/:file', (req, res) => {
    if (!/^(source\.m3u8|source\.webm|source-\d+\.ts)$/.test(req.params.file)) return res.sendStatus(404);
    res.sendFile(path.join(dir, req.params.file));
  });
  t.mock.method(instance.youtube, 'resolve', async () => ({ duration: 8, inputs: [
    { url: `${url}/youtube-source/source.m3u8`, headers: {} },
    { url: `${url}/youtube-source/source.webm`, headers: {} },
  ] }));
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  instance.rooms.add(room, [makeItem({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=_LzsKxJCTPw' })]);
  await until(() => {
    assert.notEqual(room.current.status, 'error', instance.media.jobs.get(room.current.id)?.errors || room.current.error);
    return room.current.media?.complete;
  }, 20000);
  assert.ok(room.current.media.bufferedUntil >= 8);
  const playlist = await fetch(url + room.current.media.url, { headers: { Cookie: cookie } });
  assert.equal(playlist.status, 200);
  const contents = await playlist.text();
  assert.match(contents, /#EXTINF:/);
  const first = await encryptedHLS(instance, url, cookie, room.current, contents);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-headers', `Cookie: ${cookie}\r\n`,
    '-i', url + room.current.media.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);

  t.mock.method(instance.youtube, 'extract', async () => ({ id: 'BaW_jenozKc', duration: 8 }));
  const [next] = await instance.youtube.items('https://youtu.be/BaW_jenozKc?t=3', { displayName: 'Viewer' });
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  instance.rooms.add(room, [next]);
  await until(() => {
    assert.notEqual(next.status, 'error', instance.media.jobs.get(next.id)?.errors || next.error);
    return next.media?.complete;
  }, 20000);
  assert.equal(next.media.baseTime, 3, 'Next-video conversion starts at the chosen timestamp.');
  assert.ok(next.media.bufferedUntil >= 8);
  const preparedURL = next.media.url;
  const nextPlaylist = await fetch(url + preparedURL, { headers: { Cookie: cookie } });
  const prepared = await encryptedHLS(instance, url, cookie, next, await nextPlaylist.text());
  assert.notDeepEqual(prepared.key, first.key, 'Each YouTube job has a fresh key.');
  instance.rooms.advance(room);
  assert.equal(room.playback.position, 3);
  assert.equal(room.current.media.url, preparedURL, 'Advancing reuses timestamped prebuffering.');
  instance.rooms.tick();
  assert.equal(room.playback.paused, false);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-headers', `Cookie: ${cookie}\r\n`,
    '-i', url + preparedURL, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
});

test('real FFmpeg streams an incomplete upload, prebuffers the next item, and serves authorized HLS', { timeout: 90000 }, async t => {
  const { instance, api, connect, url, cookie, dir } = await start(t, { ffmpegLogLevel: 'debug' });
  assert.equal(instance.capabilities.ffmpeg, true);
  const sample = path.join(dir, 'sample.mp4');
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov', sample]);
  const bytes = await readFile(sample);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size > 0);
  const create = () => api('/api/rooms/lobby/uploads', { method: 'POST', body: { name: 'sample.mp4', size: bytes.length, duration: 30 } });
  const first = await create();
  assert.equal(first.status, 201);
  const uploadId = first.data.uploadId;
  const send = async (id, from, to) => {
    for (let offset = from; offset < to; offset += first.data.chunkSize) {
      const result = await api(`/api/uploads/${id}?offset=${offset}`, { method: 'PUT',
        body: bytes.subarray(offset, Math.min(to, offset + first.data.chunkSize)), headers: { 'Content-Type': 'application/octet-stream' } });
      assert.equal(result.status, 200, JSON.stringify(result.data));
    }
  };
  const split = Math.floor(bytes.length * 0.65);
  await send(uploadId, 0, split);
  await until(() => {
    assert.notEqual(room.current.status, 'error', room.current.error);
    return room.current.media?.bufferedUntil >= 4;
  }, 20000).catch(error => {
    t.diagnostic(instance.media.jobs.get(room.current.id)?.errors || 'No FFmpeg job output');
    throw error;
  });
  assert.equal(instance.uploads.get(uploadId).complete, false);
  assert.equal(room.current.media.complete, false);
  t.diagnostic(`HLS playable at ${split}/${bytes.length} uploaded bytes; ${room.current.media.bufferedUntil}s prepared before EOF.`);
  const playlist = await fetch(url + room.current.media.url, { headers: { Cookie: cookie } });
  assert.equal(playlist.status, 200);
  const contents = await playlist.text();
  assert.ok(contents.includes('#EXTINF:'));
  assert.ok(!contents.includes('#EXT-X-ENDLIST'));
  assert.equal((await fetch(url + room.current.media.url)).status, 401);
  const encrypted = await encryptedHLS(instance, url, cookie, room.current, contents);
  const decoding = exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'mpegts',
    '-i', 'pipe:0', '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  decoding.child.stdin.end(Buffer.concat(encrypted.decodedSegments));
  await decoding;
  await send(uploadId, split, bytes.length);
  await until(() => room.current.media?.complete, 20000);
  const second = await create();
  assert.equal(second.status, 201);
  await send(second.data.uploadId, 0, bytes.length);
  await until(() => room.queue[0]?.media?.bufferedUntil >= 4, 20000);
  const nextId = room.queue[0].id;
  const preparedURL = room.queue[0].media.url;
  const nextJob = instance.media.jobs.get(nextId);
  const nextKey = Buffer.from(nextJob.key);
  assert.notDeepEqual(nextKey, encrypted.key, 'Identical uploads still get independent keys.');
  await assert.rejects(createApp({ dataDir: dir, port: 0 }), /already in use/);
  assert.deepEqual(await readFile(path.join(encrypted.job.keyDir, 'key.bin')), encrypted.key,
    'A backend without the ownership lock cannot clean up live keys.');
  instance.rooms.control(room, { action: 'skip', revision: room.playback.revision });
  assert.equal(room.current.id, nextId);
  assert.equal(room.current.media.url, preparedURL);
  instance.rooms.tick();
  assert.equal(room.playback.paused, false);
  instance.rooms.control(room, { action: 'previous', revision: room.playback.revision });
  assert.equal(room.current.source.uploadId, uploadId);
  assert.equal(room.queue[0].id, nextId);
  t.diagnostic('Next-video segments were ready before skip; FFmpeg decoded decrypted HLS segments successfully.');
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  instance.rooms.control(room, { action: 'seek', position: 12, revision: room.playback.revision });
  const oldMediaURL = room.current.media.url;
  await instance.close();
  await assert.rejects(stat(instance.media.keyDir), { code: 'ENOENT' });
  await assert.rejects(stat(encrypted.job.keyDir), { code: 'ENOENT' });
  await assert.rejects(stat(nextJob.keyDir), { code: 'ENOENT' });
  assert.deepEqual(encrypted.job.key, Buffer.alloc(16), 'Closed jobs erase their in-memory keys.');
  assert.deepEqual(nextJob.key, Buffer.alloc(16));
  const staleDir = path.join(dir, 'media-keys', 'stale-run', 'old-job');
  await mkdir(staleDir, { recursive: true, mode: 0o700 });
  await writeFile(path.join(staleDir, 'key.bin'), encrypted.key, { mode: 0o600 });
  await writeFile(path.join(staleDir, 'key-info'), 'stale key information', { mode: 0o600 });
  const restarted = await createApp({ dataDir: dir, port: 0 });
  t.after(() => restarted.close());
  await assert.rejects(stat(staleDir), { code: 'ENOENT' });
  const restartedURL = await restarted.listen(0);
  const viewer = new WebSocket(restartedURL.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie, Origin: restartedURL } });
  t.after(() => viewer.terminate());
  await new Promise((resolve, reject) => { viewer.once('open', resolve); viewer.once('error', reject); });
  viewer.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const recovered = restarted.rooms.get('lobby');
  await until(() => {
    assert.notEqual(recovered.current.status, 'error', recovered.current.error);
    return recovered.members.size && recovered.current.media?.complete && recovered.queue[0]?.media?.bufferedUntil >= 4;
  }, 20000);
  assert.equal(recovered.playback.paused, true);
  assert.equal(recovered.playback.position, 12);
  assert.equal(recovered.current.media.baseTime, 12);
  assert.notEqual(recovered.current.media.url, oldMediaURL);
  assert.equal(recovered.queue[0].id, nextId);
  const recoveredPlaylist = await fetch(restartedURL + recovered.current.media.url, { headers: { Cookie: cookie } });
  const recoveredEncryption = await encryptedHLS(restarted, restartedURL, cookie, recovered.current, await recoveredPlaylist.text());
  assert.notEqual(recoveredEncryption.job.id, encrypted.job.id);
  assert.notDeepEqual(recoveredEncryption.key, encrypted.key, 'Restarted uploads get fresh keys.');
  assert.notDeepEqual(restarted.media.jobs.get(nextId).key, nextKey);
  assert.equal((await fetch(`${restartedURL}/direct/media/${encrypted.job.id}/key.bin`, { headers: { Cookie: cookie } })).status, 404);
  await exec(restarted.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL', '-headers', `Cookie: ${cookie}\r\n`,
    '-i', restartedURL + recovered.current.media.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  restarted.rooms.control(recovered, { action: 'seek', position: 4, revision: recovered.playback.revision });
  await until(() => {
    assert.notEqual(recovered.current.status, 'error', recovered.current.error);
    return recovered.current.media?.complete && recovered.current.media.baseTime === 4;
  }, 20000);
  const seekPlaylist = await fetch(restartedURL + recovered.current.media.url, { headers: { Cookie: cookie } });
  const seekEncryption = await encryptedHLS(restarted, restartedURL, cookie, recovered.current, await seekPlaylist.text());
  assert.notEqual(seekEncryption.job.id, recoveredEncryption.job.id);
  assert.notDeepEqual(seekEncryption.key, recoveredEncryption.key, 'Out-of-buffer seeks rotate the key and job.');
  await recoveredEncryption.job.cleanup;
  await assert.rejects(stat(recoveredEncryption.job.dir), { code: 'ENOENT' });
  await assert.rejects(stat(recoveredEncryption.job.keyDir), { code: 'ENOENT' });
  assert.deepEqual(recoveredEncryption.job.key, Buffer.alloc(16), 'Disposed jobs erase their in-memory keys.');
  assert.equal((await fetch(`${restartedURL}/direct/media/${recoveredEncryption.job.id}/key.bin`, { headers: { Cookie: cookie } })).status, 404);
  await restarted.close();
  await assert.rejects(stat(restarted.media.keyDir), { code: 'ENOENT' });
  t.diagnostic('A fresh backend rebuilt and decoded the saved upload at 12s and prebuffered the persisted queue.');
});

test('an uploaded network playlist is not allowed to initiate nested media requests', { timeout: 30000 }, async t => {
  const { instance, api, connect } = await start(t);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const bytes = Buffer.from('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://127.0.0.1:9/private.ts\n#EXT-X-ENDLIST\n');
  const created = await api('/api/rooms/lobby/uploads', { method: 'POST', body: { name: 'malicious.mp4', size: bytes.length, duration: 2 } });
  await api(`/api/uploads/${created.data.uploadId}?offset=0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream' } });
  await until(() => room.current.status === 'error');
  assert.equal(room.current.media, null);
  const job = instance.media.jobs.get(room.current.id);
  assert.match(job.errors, /not on whitelist/);
});

test('ordinary MP4 with an end-of-file index recovers after upload completion', { timeout: 40000 }, async t => {
  const { instance, api, connect, dir } = await start(t);
  const sample = path.join(dir, 'index-at-end.mp4');
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', sample]);
  const bytes = await readFile(sample);
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const created = await api('/api/rooms/lobby/uploads', { method: 'POST', body: { name: 'index-at-end.mp4', size: bytes.length, duration: 8 } });
  assert.equal(created.status, 201);
  const split = Math.floor(bytes.length / 2);
  const send = (from, to) => api(`/api/uploads/${created.data.uploadId}?offset=${from}`, { method: 'PUT',
    body: bytes.subarray(from, to), headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal((await send(0, split)).status, 200);
  await until(() => instance.media.jobs.get(room.current.id)?.child);
  assert.equal(room.current.media, null);
  for (let offset = split; offset < bytes.length; offset += created.data.chunkSize) {
    assert.equal((await send(offset, Math.min(bytes.length, offset + created.data.chunkSize))).status, 200);
  }
  await until(() => {
    assert.notEqual(room.current.status, 'error', room.current.error);
    return room.current.media?.complete;
  }, 20000);
  assert.ok(room.current.media.bufferedUntil >= 7.9);
});