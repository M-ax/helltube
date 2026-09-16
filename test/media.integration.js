import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { start, until } from './helpers.js';
import { makeItem } from '../server/rooms.js';
import { createApp } from '../server/app.js';
import { WebSocket } from 'ws';

const exec = promisify(execFile);

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
  assert.match(await playlist.text(), /#EXTINF:/);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-headers', `Cookie: ${cookie}\r\n`,
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
  instance.rooms.advance(room);
  assert.equal(room.playback.position, 3);
  assert.equal(room.current.media.url, preparedURL, 'Advancing reuses timestamped prebuffering.');
  instance.rooms.tick();
  assert.equal(room.playback.paused, false);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-headers', `Cookie: ${cookie}\r\n`,
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
  const segment = contents.split('\n').find(s => s.endsWith('.ts'));
  const segmentURL = url + room.current.media.url.replace('index.m3u8', segment);
  const segmentResponse = await fetch(segmentURL, { headers: { Cookie: cookie } });
  assert.equal(segmentResponse.status, 200);
  assert.ok((await segmentResponse.arrayBuffer()).byteLength > 1000);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-headers', `Cookie: ${cookie}\r\n`,
    '-i', segmentURL, '-f', 'null', '-']);
  await send(uploadId, split, bytes.length);
  await until(() => room.current.media?.complete, 20000);
  const second = await create();
  assert.equal(second.status, 201);
  await send(second.data.uploadId, 0, bytes.length);
  await until(() => room.queue[0]?.media?.bufferedUntil >= 4, 20000);
  const nextId = room.queue[0].id;
  const preparedURL = room.queue[0].media.url;
  instance.rooms.control(room, { action: 'skip', revision: room.playback.revision });
  assert.equal(room.current.id, nextId);
  assert.equal(room.current.media.url, preparedURL);
  instance.rooms.tick();
  assert.equal(room.playback.paused, false);
  instance.rooms.control(room, { action: 'previous', revision: room.playback.revision });
  assert.equal(room.current.source.uploadId, uploadId);
  assert.equal(room.queue[0].id, nextId);
  t.diagnostic('Next-video segments were ready before skip; FFmpeg decoded a served HLS segment successfully.');
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  instance.rooms.control(room, { action: 'seek', position: 12, revision: room.playback.revision });
  const oldMediaURL = room.current.media.url;
  await instance.close();
  const restarted = await createApp({ dataDir: dir, port: 0 });
  t.after(() => restarted.close());
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
  await exec(restarted.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-headers', `Cookie: ${cookie}\r\n`,
    '-i', restartedURL + recovered.current.media.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  await restarted.close();
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