import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { appendFile, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';
import { makeItem, Rooms } from '../server/rooms.js';
import { Media } from '../server/media.js';
import { StateStore } from '../server/store.js';
import { start as startServer, until } from './helpers.js';

const servers = new WeakMap();
async function start(t, options) {
  const cleanups = [];
  const context = await startServer({ after: cleanup => cleanups.push(cleanup) }, options);
  const instances = [context.instance];
  servers.set(t, instances);
  t.after(async () => {
    for (const instance of instances.toReversed()) await instance.close();
    for (const cleanup of cleanups) await cleanup();
  });
  return context;
}

async function cache(instance, item, { baseTime = 0, originalBaseTime = baseTime, complete = true, originalComplete = complete } = {}) {
  const media = instance.media;
  const rendition = (baseTime, label) => {
    const id = randomUUID();
    return { id, item, baseTime, label, dir: path.join(media.dir, id), keyDir: path.join(media.keyDir, id),
      key: randomBytes(16), done: true, lastBuffered: baseTime };
  };
  const job = rendition(baseTime);
  job.original = rendition(originalBaseTime, 'Original (2160p)');
  media.jobs.set(item.id, job);
  for (const variant of [job, job.original]) {
    await media.prepareEncryption(variant);
    const original = variant === job.original;
    const files = original ? ['init.mp4', 'segment-000000.m4s'] : ['segment-000000.ts'];
    const lines = ['#EXTM3U', '#EXT-X-TARGETDURATION:120', '#EXT-X-MEDIA-SEQUENCE:0'];
    for (const [index, file] of files.entries()) {
      const iv = Buffer.alloc(16, index);
      const cipher = createCipheriv('aes-128-cbc', variant.key, iv);
      await writeFile(path.join(variant.dir, file), Buffer.concat([cipher.update(`cached ${file}`), cipher.final()]));
      lines.push(`#EXT-X-KEY:METHOD=AES-128,URI="/direct/media/${variant.id}/key.bin",IV=0x${iv.toString('hex')}`);
      if (file === 'init.mp4') lines.push('#EXT-X-MAP:URI="init.mp4"');
      else lines.push(`#EXTINF:${120 - variant.baseTime},`, file);
    }
    if (original ? originalComplete : complete) lines.push('#EXT-X-ENDLIST');
    await writeFile(path.join(variant.dir, 'index.m3u8'), lines.join('\n') + '\n');
  }
  await media.refresh(job);
  return job;
}

async function restart(t, instance, dir, options = {}) {
  await instance.close();
  const restarted = await createApp({ dataDir: dir, port: 0, desktopPort: 0, maxTranscoders: 0, ...options });
  servers.get(t).push(restarted);
  t.mock.method(restarted.youtube, 'resolve', () => { throw new Error('Cached media must not resolve YouTube again.'); });
  return restarted;
}

for (const complete of [true, false]) {
  test(`published ${complete ? 'complete' : 'interrupted'} cache survives without a shutdown checkpoint`, async t => {
    await mkdir('test-artifacts', { recursive: true });
    const dir = await mkdtemp(path.resolve('test-artifacts', 'cache-crash-'));
    const store = new StateStore(dir);
    await store.init();
    const config = { dataDir: dir, maxTranscoders: 0 };
    const rooms = new Rooms({ store });
    const media = new Media(config, rooms, { uploads: new Map() }, { close() {} });
    let restored;
    t.after(async () => {
      clearInterval(media.timer);
      await restored?.close();
      store.close();
      await rm(dir, { recursive: true, force: true });
    });
    await media.init();
    const item = makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 });
    rooms.add(rooms.get('lobby'), [item]);
    const job = await cache({ media }, item, { complete });
    const qualities = structuredClone(item.media.qualities);
    clearInterval(media.timer);
    store.close(); // Simulate exit without invoking Media.close or Rooms.checkpoint.
    if (!complete) for (const variant of [job, job.original]) {
      await appendFile(path.join(variant.dir, 'index.m3u8'), '#EXT-X-ENDLIST\n');
    }
    await store.init();
    const recoveredRooms = new Rooms({ store });
    restored = new Media(config, recoveredRooms, { uploads: new Map() }, { close() {} });
    await restored.init();
    assert.deepEqual(recoveredRooms.get('lobby').current.media.qualities, qualities,
      'An ENDLIST written while terminating an encoder must not turn a partial cache into a complete video.');
    assert.deepEqual(restored.jobs.get(item.id).key, job.key);
    assert.deepEqual(restored.jobs.get(item.id).original.key, job.original.key);
  });
}

test('restart and viewer reconnect reuse current, queued and historical qualities, keys and timelines', async t => {
  const { instance, dir, cookie } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const items = Array.from({ length: 4 }, (_, index) => makeItem(
    { kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw', startAt: index === 1 ? 30 : 0 },
    { duration: 120, startAt: index === 1 ? 30 : 0 }));
  instance.rooms.add(room, items);
  const history = await cache(instance, items[0]);
  instance.rooms.advance(room);
  const current = await cache(instance, items[1], { baseTime: 30, originalBaseTime: 26.25 });
  const queued = await cache(instance, items[2]);
  const later = await cache(instance, items[3]);
  instance.rooms.stamp(room, 45, true);
  room.resumeWhenReady = false;
  items[1].sponsorSegments = [[60, 70]];
  await instance.media.refresh(current);
  const jobs = [history, current, queued, later];
  const keys = new Map(jobs.flatMap(job => [job, job.original]).map(job => [job.id, Buffer.from(job.key)]));
  const qualities = new Map(items.map(item => [item.id, structuredClone(item.media.qualities)]));
  const restarted = await restart(t, instance, dir, { maxTranscoders: 4 });
  const url = await restarted.listen(0);
  const restored = restarted.rooms.get('lobby');
  assert.equal(restored.playback.position, 45);
  assert.equal(restored.playback.paused, true);
  assert.deepEqual(restored.current.sponsorSegments, [[60, 70]]);
  for (const item of restarted.rooms.allItems()) {
    assert.deepEqual(item.media.qualities, qualities.get(item.id));
    const job = restarted.media.jobs.get(item.id);
    assert.deepEqual(job.key, keys.get(job.id));
    assert.deepEqual(job.original.key, keys.get(job.original.id));
  }
  for (let reconnect = 0; reconnect < 2; reconnect++) {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { Cookie: cookie, Origin: url } });
    t.after(() => ws.terminate());
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
    await until(() => restored.members.size === 1);
    for (const quality of restored.current.media.qualities) {
      const response = await fetch(url + quality.url, { headers: { Cookie: cookie } });
      assert.equal(response.status, 200);
      const playlist = await response.text();
      const keyPath = playlist.match(/URI="([^"]+key.bin[^"]*)"/)[1];
      const keyResponse = await fetch(new URL(keyPath, url), { headers: { Cookie: cookie } });
      assert.equal(keyResponse.status, 200);
      const key = Buffer.from(await keyResponse.arrayBuffer());
      const files = quality.id === 'original' ? ['init.mp4', 'segment-000000.m4s'] : ['segment-000000.ts'];
      for (const [index, file] of files.entries()) {
        const segment = await fetch(new URL(file, url + quality.url), { headers: { Cookie: cookie } });
        assert.equal(segment.status, 200);
        const decipher = createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, index));
        assert.equal(Buffer.concat([decipher.update(Buffer.from(await segment.arrayBuffer())), decipher.final()]).toString(), `cached ${file}`);
      }
    }
    ws.terminate();
    await until(() => restored.members.size === 0);
  }
  restarted.rooms.replay(restored, items[0].id);
  assert.deepEqual(restored.current.media.qualities, qualities.get(items[0].id));
  await restarted.cleanup();
  assert.equal(restarted.media.allJobs().length, 8, 'Periodic cleanup also retains jobs from previous runs.');
  assert.equal(restarted.youtube.resolve.mock.callCount(), 0);
  const again = await restart(t, restarted, dir, { maxTranscoders: 4 });
  await again.listen(0);
  assert.deepEqual(again.rooms.get('lobby').current.media.qualities, qualities.get(items[0].id));
  assert.equal(again.youtube.resolve.mock.callCount(), 0);
  await again.close();
});

test('startup and periodic cleanup remove every quality and key only after its item is unreferenced', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const items = Array.from({ length: 8 }, () => makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 }));
  instance.rooms.add(room, items);
  const jobs = [];
  for (const item of items) jobs.push(await cache(instance, item));
  for (let i = 0; i < 5; i++) instance.rooms.advance(room);
  await instance.close();
  const store = new StateStore(dir);
  await store.init();
  const saved = store.load('rooms').find(room => room.id === 'lobby');
  saved.queue.pop(); // An abandoned cache entry left behind by an interrupted cleanup.
  store.save('rooms', saved.id, saved);
  store.close();
  const restarted = await restart(t, instance, dir);
  for (const variant of [jobs[7], jobs[7].original]) {
    await assert.rejects(stat(variant.dir), { code: 'ENOENT' });
    await assert.rejects(stat(variant.keyDir), { code: 'ENOENT' });
  }
  assert.equal(restarted.store.load('media').length, 7);
  for (const job of jobs.slice(0, 7)) for (const variant of [job, job.original]) assert.ok((await stat(variant.dir)).isDirectory());
  await restarted.listen(0);
  restarted.rooms.advance(restarted.rooms.get('lobby'));
  await restarted.cleanup();
  for (const variant of [jobs[0], jobs[0].original]) {
    await assert.rejects(stat(variant.dir), { code: 'ENOENT' });
    await assert.rejects(stat(variant.keyDir), { code: 'ENOENT' });
  }
  assert.equal(restarted.store.load('media').length, 6);
  await restarted.close();
});

for (const broken of ['standard', 'original', 'both']) {
  test(`restart recovers the other quality when ${broken} cached media is missing`, async t => {
    const { instance, dir } = await start(t, { maxTranscoders: 0 });
    const item = makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 });
    instance.rooms.add(instance.rooms.get('lobby'), [item]);
    const job = await cache(instance, item);
    await instance.close();
    if (broken !== 'original') await rm(path.join(job.keyDir, 'key.bin'));
    if (broken !== 'standard') await rm(path.join(job.original.dir, 'init.mp4'));
    const restarted = await restart(t, instance, dir);
    const restored = restarted.rooms.get('lobby').current;
    if (broken === 'both') {
      assert.equal(restored.media, null);
      assert.equal(restored.status, 'queued');
      assert.equal(restarted.media.jobs.size, 0);
    } else {
      assert.deepEqual(restored.media.qualities.map(quality => quality.id), [broken === 'standard' ? 'original' : 'standard']);
      assert.equal(restored.status, 'ready');
      await restarted.listen(0);
      restarted.media.schedule();
      assert.equal(restarted.youtube.resolve.mock.callCount(), 0);
    }
    await restarted.close();
  });
}

test('a completed Original survives shutdown while Standard is still downloading', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const item = makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 });
  instance.rooms.add(instance.rooms.get('lobby'), [item]);
  const job = await cache(instance, item, { complete: false, originalComplete: true });
  job.done = false;
  const restarted = await restart(t, instance, dir, { maxTranscoders: 4 });
  await restarted.listen(0);
  const qualities = restarted.rooms.get('lobby').current.media.qualities;
  assert.deepEqual(qualities.map(quality => [quality.id, quality.complete]), [['original', true], ['standard', false]]);
  assert.equal(restarted.youtube.resolve.mock.callCount(), 0);
  await restarted.close();
});

test('interrupted buffers are reused, then missing media is prepared from the saved position', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const item = makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 240 });
  instance.rooms.add(room, [item]);
  const job = await cache(instance, item, { complete: false });
  job.done = false;
  instance.rooms.stamp(room, 60, true);
  room.resumeWhenReady = false;
  const restarted = await restart(t, instance, dir, { maxTranscoders: 4 });
  const started = t.mock.method(restarted.media, 'start', () => {});
  await restarted.listen(0);
  const restored = restarted.rooms.get('lobby');
  assert.equal(restored.current.media.url, item.media.url);
  assert.equal(restored.current.media.complete, false);
  assert.equal(started.mock.callCount(), 0);
  restarted.rooms.stamp(restored, 117, true);
  restarted.media.schedule();
  assert.equal(started.mock.callCount(), 1);
  assert.equal(started.mock.calls[0].arguments[1], 117);
  await restarted.cleanup();
  await restarted.close();
});

for (const finished of ['both', 'standard', 'original']) {
  test(`a scheduler poll past EOF preserves finished ${finished} media until the queue advances`, async t => {
    const { instance, dir } = await start(t, { maxTranscoders: 0 });
    const room = instance.rooms.get('lobby');
    const items = Array.from({ length: 2 }, () => makeItem(
      { kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 }));
    instance.rooms.add(room, items);
    await cache(instance, items[0], { complete: finished !== 'original', originalComplete: finished !== 'standard' });
    await cache(instance, items[1]);
    instance.rooms.stamp(room, 60, true);
    room.resumeWhenReady = false;
    const restarted = await restart(t, instance, dir, { maxTranscoders: 4 });
    const started = t.mock.method(restarted.media, 'start', () => {});
    await restarted.listen(0);
    const restored = restarted.rooms.get('lobby');
    const current = restored.current;
    const job = restarted.media.jobs.get(current.id);
    const qualities = structuredClone(current.media.qualities);
    // The 500 ms media poll can run after EOF but before the 750 ms room tick.
    restarted.rooms.stamp(restored, 120.419, false);
    restarted.media.schedule();
    assert.equal(started.mock.callCount(), 0, 'EOF must not start another transcoder');
    assert.equal(restarted.media.jobs.get(current.id), job, 'Retain the cache for history/replay');
    assert.deepEqual(current.media.qualities, qualities);
    assert.equal(current.status, 'ready');
    assert.equal(current.error, null);
    restarted.rooms.tick();
    assert.equal(restored.current.id, items[1].id);
    assert.equal(restored.history[0], current);
    assert.equal(restarted.youtube.resolve.mock.callCount(), 0);
    restarted.rooms.stamp(restored, 120.419, false);
    restarted.media.schedule();
    restarted.rooms.tick();
    assert.equal(restored.current, null, 'The final video also finishes without an error');
    assert.equal(started.mock.callCount(), 0);
    await restarted.close();
  });
}

test('resuming interrupted Standard preserves the finished Original across further restarts', async t => {
  const { instance, dir } = await start(t, { maxTranscoders: 0 });
  const room = instance.rooms.get('lobby');
  const item = makeItem({ kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw' }, { duration: 120 });
  instance.rooms.add(room, [item]);
  const cached = await cache(instance, item, { complete: false, originalComplete: true });
  const original = structuredClone(item.media.qualities.find(quality => quality.id === 'original'));
  const key = Buffer.from(cached.original.key);
  instance.rooms.stamp(room, 117, true);
  room.resumeWhenReady = false;
  const restarted = await restart(t, instance, dir, { maxTranscoders: 4 });
  restarted.youtube.resolve.mock.restore();
  const resolve = t.mock.method(restarted.youtube, 'resolve', async () => ({ duration: 120,
    inputs: [{ url: 'https://upstream.invalid/video', headers: {} }], copyQuality: { label: 'Original (2160p)' } }));
  const convert = t.mock.method(restarted.media, 'convert', async job => {
    await writeFile(path.join(job.dir, 'segment-000000.ts'), Buffer.alloc(16));
    await writeFile(path.join(job.dir, 'index.m3u8'), '#EXTM3U\n#EXTINF:3,\nsegment-000000.ts\n#EXT-X-ENDLIST\n');
  });
  await restarted.listen(0);
  const job = restarted.media.jobs.get(item.id);
  await job.task;
  assert.notEqual(job.id, cached.id);
  assert.equal(job.original.id, cached.original.id);
  assert.deepEqual(job.original.key, key);
  assert.deepEqual(job.item.media.qualities.find(quality => quality.id === 'original'), original);
  assert.equal(resolve.mock.callCount(), 1);
  assert.equal(convert.mock.callCount(), 1, 'Only the missing Standard range is downloaded/encoded.');
  assert.ok(convert.mock.calls[0].arguments[1].includes('libx264'));
  const again = await restart(t, restarted, dir, { maxTranscoders: 4 });
  await again.listen(0);
  assert.equal(again.youtube.resolve.mock.callCount(), 0);
  const retained = again.media.jobs.get(item.id);
  assert.deepEqual(retained.original.key, key);
  assert.deepEqual(retained.item.media.qualities.find(quality => quality.id === 'original'), original);
  assert.equal(retained.item.media.qualities.find(quality => quality.id === 'standard').baseTime, 117);
  await again.close();
});
