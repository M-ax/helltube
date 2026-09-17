import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv } from 'node:crypto';
import { mkdir, open, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, until } from './helpers.js';
import { makeItem } from '../server/rooms.js';
import { createApp } from '../server/app.js';
import { WebSocket } from 'ws';
import { remoteURL } from '../server/remote-media.js';
import { create4kFixture } from './media-4k-fixture.js';
import { createSeekFixture } from './media-seek-fixture.js';

const exec = promisify(execFile);

for (const codec of ['vp9', 'av1', 'h264']) {
  test(`resumed ${codec} copies only nearby packets and retains source timestamps and duration`, {timeout: 60000}, async t => {
    const context = await start(t);
    const {instance, connect, dir} = context;
    const sources = await createSeekFixture(t, context, codec);
    const ws = await connect();
    ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    const room = instance.rooms.get('lobby');
    await until(() => room.members.size);
    const item = makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw', startAt: 63.3}, {duration: 80, startAt: 63.3});
    instance.rooms.add(room, [item]);
    await until(() => instance.media.jobs.get(item.id)?.done, 30000);
    const job = instance.media.jobs.get(item.id);
    assert.equal(job.original.failed, undefined, job.original.failed?.message || job.original.errors);
    assert.deepEqual(item.media.qualities.map(quality => quality.id), ['original', 'standard']);
    const original = item.media.qualities[0];
    assert.ok(original.baseTime > 54 && original.baseTime <= 63.3, `Actual preroll starts at ${original.baseTime}.`);
    assert.ok(Math.abs(original.bufferedUntil - 80) < 0.25, `Reported end: ${original.bufferedUntil}`);
    const contents = await readFile(path.join(job.original.dir, 'index.m3u8'), 'utf8');
    const chunks = [];
    let iv;
    for (const line of contents.split('\n')) {
      if (line.startsWith('#EXT-X-KEY:')) iv = Buffer.from(line.match(/IV=0x([a-f0-9]+)/)[1], 'hex');
      const file = line.startsWith('#EXT-X-MAP:') ? 'init.mp4' : /^segment-\d+\.m4s$/.test(line) ? line : null;
      if (!file) continue;
      const cipher = createDecipheriv('aes-128-cbc', job.original.key, iv);
      chunks.push(Buffer.concat([cipher.update(await readFile(path.join(job.original.dir, file))), cipher.final()]));
    }
    const copied = path.join(dir, 'resumed.mp4');
    await writeFile(copied, Buffer.concat(chunks));
    const probe = async (file, stream) => JSON.parse((await exec('ffprobe', ['-v', 'error', '-select_streams', stream,
      '-show_packets', '-show_entries', 'format=start_time:packet=pts_time,dts_time,data_hash',
      '-show_data_hash', 'sha256', '-of', 'json', file], {maxBuffer: 4 * 1024 * 1024})).stdout);
    for (const [stream, source] of [['v:0', sources.video], ['a:0', sources.audio]]) {
      const input = await probe(source, stream.startsWith('v') ? 'v:0' : 'a:0');
      const output = await probe(copied, stream);
      assert.ok(output.packets.length > 0 && output.packets.length < input.packets.length / 2);
      const sourceStart = Number(input.format.start_time);
      const byTime = new Map(input.packets.map(packet => [Math.round((Number(packet.pts_time) - sourceStart) * 1000), packet.data_hash]));
      for (const packet of output.packets) {
        assert.equal(packet.data_hash, byTime.get(Math.round(Number(packet.pts_time) * 1000)),
          `${stream} packet at ${packet.pts_time} keeps both its bytes and normalized source timestamp.`);
      }
    }
    await exec(instance.media.config.ffmpeg, ['-v', 'error', '-xerror', '-i', copied, '-map', '0:v', '-map', '0:a', '-f', 'null', '-']);
  });
}

for (const codec of ['vp9', 'av1']) {
  test(`encrypted fMP4 copies ${codec} video and separate Opus audio alongside 720p`, {timeout: 60000}, async t => {
    const context = await start(t);
    const {instance, connect, url, cookie, dir} = context;
    const {video: source, audio} = await create4kFixture(t, context, {codec, size: codec === 'vp9' ? '3840x2160' : '640x360'});
    const ws = await connect();
    ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    const room = instance.rooms.get('lobby');
    await until(() => room.members.size);
    const item = makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw'}, {duration: 6});
    instance.rooms.add(room, [item]);
    await until(() => {
      assert.notEqual(item.status, 'error', item.error);
      return instance.media.jobs.get(item.id)?.done;
    }, 30000);
    const job = instance.media.jobs.get(item.id);
    assert.equal(job.original.failed, undefined, job.original.errors);
    assert.equal(item.media.qualities.length, 2);
    const quality = item.media.qualities.find(quality => quality.id === 'original');
    const contents = await (await fetch(url + quality.url, {headers: {Cookie: cookie}})).text();
    assert.match(contents, /#EXT-X-MAP:URI="init.mp4"/);
    const decoded = [];
    const ivs = new Set();
    let iv;
    for (const line of contents.split('\n')) {
      if (line.startsWith('#EXT-X-KEY:')) {
        iv = line.match(/IV=0x([a-f0-9]+)/)[1];
        continue;
      }
      const file = line.startsWith('#EXT-X-MAP:') ? 'init.mp4' : /^segment-\d+\.m4s$/.test(line) ? line : null;
      if (!file) continue;
      assert.ok(!ivs.has(iv), 'Initialization and every media fragment use distinct IVs.');
      ivs.add(iv);
      const target = new URL(file, url + quality.url);
      assert.equal((await fetch(target)).status, 401);
      const response = await fetch(target, {headers: {Cookie: cookie}});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-helltube-encrypted'), 'aes-128');
      assert.match(response.headers.get('content-type'), /video\/mp4/);
      const cipher = createDecipheriv('aes-128-cbc', job.original.key, Buffer.from(iv, 'hex'));
      const encrypted = Buffer.from(await response.arrayBuffer());
      decoded.push(Buffer.concat([cipher.update(encrypted), cipher.final()]));
    }
    assert.ok(decoded.length >= 3);
    const copied = path.join(dir, 'decoded.mp4');
    await writeFile(copied, Buffer.concat(decoded));
    const probe = async (file, stream = 'v:0') => JSON.parse((await exec('ffprobe', ['-v', 'error', '-select_streams', stream, '-show_packets',
      '-show_entries', 'stream=width,height,codec_name:packet=data_hash', '-show_data_hash', 'sha256', '-of', 'json', file])).stdout);
    const original = await probe(source);
    const output = await probe(copied);
    assert.deepEqual(output.streams, original.streams);
    assert.deepEqual(output.packets, original.packets, 'Encoded video packets are preserved byte for byte.');
    assert.deepEqual((await probe(copied, 'a:0')).packets.map(packet => packet.data_hash),
      (await probe(audio, 'a:0')).packets.map(packet => packet.data_hash),
      'Encoded audio packets are also preserved byte for byte.');
    await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-xerror', '-allowed_extensions', 'ALL',
      '-headers', `Cookie: ${cookie}\r\n`, '-i', url + quality.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
    assert.notDeepEqual(job.key, job.original.key);
    instance.media.dispose(job);
    await job.cleanup;
    await assert.rejects(stat(job.original.clearDir), {code: 'ENOENT'});
    assert.deepEqual(job.original.key, Buffer.alloc(16));
  });
}

test('tail-indexed MP4 duration reaches viewers before conversion and enables a full-timeline seek', { timeout: 40000 }, async t => {
  const {instance, api, connect, url, cookie, dir} = await start(t);
  const original = path.join(dir, 'original.mp4');
  const file = path.join(dir, 'tail-index.mp4');
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', original]);
  const data = await readFile(original);
  let moov = 0;
  while (data.toString('ascii', moov + 4, moov + 8) !== 'moov') {
    const size = data.readUInt32BE(moov);
    assert.ok(size >= 8 && moov + size < data.length);
    moov += size;
  }
  // A sparse free box puts the index far from the media without moving any sample offsets.
  const padding = 32 * 1024 * 1024;
  const free = Buffer.alloc(8);
  free.writeUInt32BE(padding);
  free.write('free', 4, 'ascii');
  const handle = await open(file, 'w');
  try {
    await handle.write(data.subarray(0, moov), 0, moov, 0);
    await handle.write(free, 0, free.length, moov);
    await handle.truncate(data.length + padding);
    await handle.write(data.subarray(moov), 0, data.length - moov, moov + padding);
  } finally { await handle.close(); }
  const gate = Promise.withResolvers();
  t.after(() => gate.resolve());
  let item;
  let probedBytes = 0;
  const probeRanges = [];
  instance.app.get('/metadata-file.mp4', async (req, res) => {
    if (item?.duration) await gate.promise;
    else {
      probeRanges.push(req.headers.range);
      const write = res.write;
      res.write = function (chunk, ...args) {
        probedBytes += Buffer.byteLength(chunk);
        return write.call(this, chunk, ...args);
      };
    }
    if (!res.destroyed) res.sendFile(file, {dotfiles: 'allow'});
  });
  instance.app.get('/metadata-watch.mp4', (_req, res) => res.type('html').send('<video src="/metadata-file.mp4?token=fixture&amp;part=1"></video>'));
  t.mock.method(instance.remote, 'resolve', async value => {
    const target = remoteURL(value);
    assert.equal(target.hostname, 'media.test');
    return {url: target, addresses: [{address: '127.0.0.1', family: 4}]};
  });
  const ws = await connect();
  ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const source = `${url.replace('127.0.0.1', 'media.test')}/metadata-watch.mp4`;
  assert.equal((await api('/api/rooms/lobby/media', {method: 'POST', body: {url: source}})).status, 201);
  item = room.current;
  const revision = room.playback.revision;
  await until(() => ws.messages.some(message => message.type === 'state' && message.room.current?.duration === 8));
  assert.equal(item.duration, 8);
  assert.equal(item.media, null, 'Duration is available before any conversion output.');
  assert.equal(room.playback.revision, revision, 'Metadata does not change the room clock.');
  assert.equal(instance.store.load('rooms').find(value => value.id === room.id).current.duration, 8);
  assert.ok(probeRanges.some(range => Number(/^bytes=(\d+)-/.exec(range || '')?.[1]) >= moov + padding),
    'The actual probe must seek to the index at the end.');
  assert.ok(probedBytes < padding / 2, `Probe read ${probedBytes} bytes rather than the full file.`);
  assert.throws(() => instance.rooms.control(room, {action: 'seek', position: 9, revision}), /Invalid seek/);
  instance.rooms.control(room, {action: 'seek', position: 3, revision});
  gate.resolve();
  await until(() => {
    assert.notEqual(item.status, 'error', item.error);
    return item.media?.complete && item.media.baseTime === 3;
  }, 15000);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL',
    '-headers', `Cookie: ${cookie}\r\n`, '-i', url + item.media.url, '-map', '0:v:0', '-f', 'null', '-']);
  t.diagnostic(`Duration arrived before conversion; the probe fetched ${probedBytes} bytes from a ${data.length + padding}-byte MP4.`);
});

test('Twitch VOD HLS and hosted watch pages share playable, seekable encrypted playback', { timeout: 60000 }, async t => {
  const { instance, api, connect, url, cookie, dir } = await start(t, { youtubeProxy: 'http://127.0.0.1:1' });
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '8', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    path.join(dir, 'remote.mp4')]);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', path.join(dir, 'remote.mp4'),
    '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(dir, 'vod.m3u8')]);
  const ranges = [];
  instance.app.get('/remote-fixture/:file', (req, res) => {
    ranges.push(req.headers.range);
    res.sendFile(path.join(dir, path.basename(req.params.file)), { dotfiles: 'allow' });
  });
  instance.app.get('/watch/remote.mp4', (_req, res) => res.type('html').send(
    '<!doctype html><video src="../remote-fixture/remote.mp4?signature=keep&amp;expires=tomorrow"></video>'));
  t.mock.method(instance.remote, 'resolve', async value => {
    const target = remoteURL(value);
    assert.equal(target.hostname, 'media.test');
    return { url: target, addresses: [{ address: '127.0.0.1', family: 4 }] };
  });
  instance.capabilities.twitch = true;
  t.mock.method(instance.twitch, 'extract', async () => ({ title: 'VOD fixture', duration: 8 }));
  t.mock.method(instance.twitch, 'resolve', async () => ({ duration: 8, inputs: [{ url: `${url}/remote-fixture/vod.m3u8`, headers: {} }] }));
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const add = source => api('/api/rooms/lobby/media', { method: 'POST', body: { url: source } });
  assert.equal((await add('https://twitch.tv/videos/12345')).status, 201);
  const hosted = `${url.replace('127.0.0.1', 'media.test')}/watch/remote.mp4`;
  assert.equal((await add(hosted)).status, 201);
  for (const item of [room.current, room.queue[0]]) {
    await until(() => {
      assert.notEqual(item.status, 'error', instance.media.jobs.get(item.id)?.errors || item.error);
      return item.media?.complete;
    }, 20000);
    const playlist = await fetch(url + item.media.url, { headers: { Cookie: cookie } });
    await encryptedHLS(instance, url, cookie, item, await playlist.text());
    await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL',
      '-headers', `Cookie: ${cookie}\r\n`, '-i', url + item.media.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  }
  assert.ok(ranges.some(range => range?.startsWith('bytes=')), 'The upstream receives range requests for an MP4 with its index at EOF.');
  assert.equal(room.queue[0].source.url, hosted, 'Persist the watch page, not its expiring signed media URL.');
  instance.rooms.advance(room);
  const item = room.current;
  const previous = item.media.url;
  instance.media.dispose(instance.media.jobs.get(item.id));
  instance.rooms.control(room, { action: 'seek', position: 3, revision: room.playback.revision });
  await until(() => {
    assert.notEqual(item.status, 'error', instance.media.jobs.get(item.id)?.errors || item.error);
    return item.media?.complete;
  }, 20000);
  assert.notEqual(item.media.url, previous);
  assert.equal(item.media.baseTime, 3);
  assert.ok(item.media.bufferedUntil >= 8);
  assert.equal((await fetch(`${url}/internal/remote/${instance.media.jobs.get(item.id).id}?key=wrong`)).status, 403);
});

test('compatible HLS keeps original frames while preparing an independently encrypted standard quality', {timeout: 45000}, async t => {
  const {instance, connect, url, cookie, dir} = await start(t);
  const source = path.join(dir, 'quality.m3u8');
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=60', '-f', 'lavfi', '-i', 'sine=frequency=440',
    '-t', '6', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '120', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', source]);
  instance.app.get('/quality/:file', (req, res) => res.sendFile(req.params.file, {root: dir, dotfiles: 'allow'}));
  t.mock.method(instance.twitch, 'resolve', async () => ({duration: 6, copyQuality: {label: 'Original (180p)'},
    inputs: [{url: `${url}/quality/quality.m3u8`, headers: {}}]}));
  const ws = await connect();
  ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const item = makeItem({kind: 'twitch', url: 'https://twitch.tv/videos/12345'}, {duration: 6});
  instance.rooms.add(room, [item]);
  await until(() => {
    assert.notEqual(item.status, 'error', item.error);
    return instance.media.jobs.get(item.id)?.done;
  }, 20000);
  assert.deepEqual(item.media.qualities.map(quality => quality.id), ['original', 'standard']);
  const keys = [];
  for (const quality of item.media.qualities) {
    const playlist = await fetch(url + quality.url, {headers: {Cookie: cookie}});
    const encrypted = await encryptedHLS(instance, url, cookie, {...item, media: quality}, await playlist.text());
    keys.push(encrypted.key);
    await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL',
      '-headers', `Cookie: ${cookie}\r\n`, '-i', url + quality.url, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  }
  assert.notDeepEqual(...keys);
  const frames = async (input, headers = []) => {
    const result = await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-allowed_extensions', 'ALL',
      ...headers, '-i', input, '-map', '0:v:0', '-f', 'framemd5', '-']);
    return result.stdout.split(/\r?\n/).filter(line => line && !line.startsWith('#')).map(line => line.split(',').at(-1).trim());
  };
  const originalFrames = await frames(url + item.media.qualities[0].url, ['-headers', `Cookie: ${cookie}\r\n`]);
  assert.deepEqual(originalFrames, await frames(source), 'Every decoded frame is unchanged by encryption-only processing.');
  assert.equal(originalFrames.length, 360, 'Original preserves 60 fps.');
  const standardFrames = await frames(url + item.media.qualities[1].url, ['-headers', `Cookie: ${cookie}\r\n`]);
  assert.ok(standardFrames.length >= 179 && standardFrames.length <= 182, 'Standard retains the existing 30 fps encoding.');
  const job = instance.media.jobs.get(item.id);
  instance.rooms.control(room, {action: 'seek', position: item.duration, revision: room.playback.revision});
  assert.equal(instance.media.jobs.get(item.id), job, 'Seeking to the prepared end retains the playable renditions.');
  await instance.media.cleanup();
  await stat(job.original.dir);
  instance.media.dispose(job);
  await job.cleanup;
  for (const rendition of [job, job.original]) await assert.rejects(stat(rendition.keyDir), {code: 'ENOENT'});
});

test('HTTP audio is playable and a hosted manifest cannot trigger nested requests', { timeout: 30000 }, async t => {
  const { instance, connect, url, dir } = await start(t);
  const audio = path.join(dir, 'audio.mp3');
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '5', audio]);
  let nestedRequests = 0;
  instance.app.get('/remote-audio.mp3', (_req, res) => res.sendFile(audio, { dotfiles: 'allow' }));
  instance.app.get('/hosted-playlist.mp4', (_req, res) => res.type('application/vnd.apple.mpegurl').send(`#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n${url}/private.ts\n#EXT-X-ENDLIST\n`));
  instance.app.get('/private.ts', (_req, res) => { nestedRequests++; res.sendStatus(404); });
  t.mock.method(instance.remote, 'resolve', async value => ({ url: new URL(value), addresses: [{ address: '127.0.0.1', family: 4 }] }));
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const items = [makeItem({ kind: 'http', url: `${url}/remote-audio.mp3` }), makeItem({ kind: 'http', url: `${url}/hosted-playlist.mp4` })];
  instance.rooms.add(room, items);
  await until(() => {
    assert.notEqual(items[0].status, 'error', instance.media.jobs.get(items[0].id)?.errors || items[0].error);
    return items[0].media?.complete && items[1].status === 'error';
  }, 20000);
  assert.ok(items[0].duration >= 5);
  assert.equal(nestedRequests, 0);
  assert.match(instance.media.jobs.get(items[1].id).errors, /not on whitelist/);
});

async function encryptedHLS(instance, url, cookie, item, contents) {
  const job = instance.media.allJobs().find(job => item.media.url === `/media/${job.id}/index.m3u8`);
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
  assert.ok(Object.keys(item.media).every(key => ['baseTime', 'bufferedUntil', 'complete', 'url', 'id', 'label', 'qualities'].includes(key)));
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
    res.sendFile(path.join(dir, req.params.file), { dotfiles: 'allow' });
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
  const { instance, api, connect, url, cookie, dir } = await start(t, {
    ffmpegLogLevel: 'debug', youtubeProxy: 'http://127.0.0.1:1',
  });
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
