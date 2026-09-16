import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as tick } from 'node:timers/promises';
import { get } from 'svelte/store';
import { createUploadManager } from '../src/lib/uploads.js';
import { until } from './helpers.js';

const localDeliveryConfig = async () => ({ bareMetalOrigin: '' });

test('upload manager restores from the server without browser storage and resumes the acknowledged offset', async t => {
  const requests = [];
  const file = new File(['partrest'], 'clip.mp4', { lastModified: 123 });
  const manager = createUploadManager('viewer', { getDeliveryConfig: localDeliveryConfig, request: async (url, options = {}) => {
    requests.push({ url, options });
    if (url === '/api/uploads') return { uploads: [{ id: 'saved', roomId: 'lobby', roomName: 'Room', name: file.name,
      size: 8, received: 4, lastModified: 123, chunkSize: 512 * 1024 }] };
    if (options.method === 'PUT') {
      assert.equal(url, '/api/uploads/saved?offset=4');
      assert.equal(await options.body.text(), 'rest');
      return { received: 8, complete: true };
    }
    return { received: 4, complete: false, active: true };
  } });
  t.after(() => manager.dispose());
  await manager.ready;
  assert.equal(get(manager.transfers)[0].state, 'needs-file');
  assert.throws(() => manager.resume('saved', new File(['partrest'], 'clip.mp4', { lastModified: 999 })), /original/);
  manager.resume('saved', file);
  await until(() => get(manager.transfers)[0].state === 'complete');
  assert.equal(requests.filter(r => r.options.method === 'PUT').length, 1);
});

test('late upload restoration cannot duplicate a newly created transfer or revive a disposed manager', async t => {
  let resolveRestore;
  const manager = createUploadManager('viewer', { getDeliveryConfig: localDeliveryConfig, metadata: async () => 10, request: async (url, options = {}) => {
    if (url === '/api/uploads') return new Promise(resolve => { resolveRestore = resolve; });
    if (options.method === 'POST') {
      assert.equal(options.body.lastModified, 123);
      return { uploadId: 'new', chunkSize: 512 * 1024 };
    }
    return { received: 8, complete: true };
  } });
  t.after(() => manager.dispose());
  await manager.add(new File(['partrest'], 'clip.mp4', { lastModified: 123 }), { id: 'lobby', name: 'Room' });
  resolveRestore({ uploads: [{ id: 'new', name: 'clip.mp4', size: 8 }] });
  await manager.ready;
  assert.equal(get(manager.transfers).length, 1);
  const disposed = createUploadManager('viewer', { request: () => new Promise(resolve => { resolveRestore = resolve; }) });
  disposed.dispose();
  resolveRestore({ uploads: [{ id: 'old' }] });
  await disposed.ready;
  assert.deepEqual(get(disposed.transfers), []);
});

test('upload restoration failures are surfaced without erasing durable server state', async () => {
  const errors = [];
  const manager = createUploadManager('viewer', {
    request: async () => { throw new Error('offline'); }, onError: message => errors.push(message),
  });
  await manager.ready;
  assert.deepEqual(errors, ['Could not restore uploads: offline']);
  manager.dispose();
});

test('batch uploads probe at most four files and preserve ordered metadata, IDs, and bytes in one POST', { timeout: 5000 }, async t => {
  const files = Array.from({ length: 6 }, (_, index) => new File([`video-${index}`], `Series ${index}.mp4`, {
    type: 'video/mp4', lastModified: 100 + index,
  }));
  const durations = [20, undefined, 30, undefined, 40, 50];
  const probes = new Map();
  const requests = [];
  const bytes = files.map(() => '');
  const inFlight = new Set();
  const sizes = [];
  let active = 0;
  let peak = 0;
  const result = { uploads: files.map((_, index) => ({ uploadId: `batch-${index}`, chunkSize: 2 })),
    playlistId: 'playlist-1', playlistTitle: 'Server-inferred series' };
  const manager = createUploadManager('viewer', {
    getDeliveryConfig: localDeliveryConfig,
    metadata: file => {
      active++;
      peak = Math.max(peak, active);
      return new Promise(resolve => probes.set(file, resolve)).finally(() => active--);
    },
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/uploads') return { uploads: [] };
      if (options.method === 'POST') return result;
      const index = Number(/batch-(\d+)/.exec(url)[1]);
      if (options.method === 'PUT') {
        assert.equal(inFlight.has(index), false, 'only one chunk per file may be in flight');
        inFlight.add(index);
        assert.equal(Number(new URL(url, 'http://localhost').searchParams.get('offset')), bytes[index].length);
        bytes[index] += await options.body.text();
        inFlight.delete(index);
      }
      return { received: bytes[index].length, complete: bytes[index].length === files[index].size, active: true };
    },
  });
  t.after(() => manager.dispose());
  const unsubscribe = manager.transfers.subscribe(items => sizes.push(items.length));
  t.after(unsubscribe);
  await manager.ready;
  const room = { id: 'room/a', name: 'Room' };
  const selection = [...files];
  const adding = manager.addMany(selection, room, 3);
  selection.reverse();
  room.id = 'elsewhere';
  room.name = 'Elsewhere';
  assert.equal(probes.size, 4);
  assert.equal(requests.filter(item => item.options.method === 'POST').length, 0);
  probes.get(files[2])(durations[2]);
  probes.get(files[0])(durations[0]);
  await until(() => probes.size === 6);
  for (const index of [5, 3, 4, 1]) probes.get(files[index])(durations[index]);
  assert.deepEqual(await adding, result);
  const posts = requests.filter(item => item.options.method === 'POST');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, '/api/rooms/room%2Fa/uploads/batch');
  assert.deepEqual(posts[0].options.body, { insertAt: 3, files: files.map((file, index) => ({
    name: file.name, size: file.size, lastModified: file.lastModified, mime: file.type,
    ...(durations[index] ? { duration: durations[index] } : {}),
  })) });
  assert.equal(peak, 4);
  assert.equal(active, 0);
  assert.equal(sizes.some(size => size > 0 && size < files.length), false, 'register the batch atomically');
  assert.deepEqual(get(manager.transfers).map(item => item.id), result.uploads.map(item => item.uploadId));
  assert.deepEqual(get(manager.transfers).map(item => item.duration), durations);
  assert.equal(get(manager.transfers).every(item => item.roomId === 'room/a' && item.roomName === 'Room'), true);
  await until(() => get(manager.transfers).every(item => item.state === 'complete'));
  assert.deepEqual(bytes, await Promise.all(files.map(file => file.text())));
});

test('batch validation rejects the entire selection before metadata or creation requests', async t => {
  const video = new File(['video'], 'clip.mp4');
  const cases = [
    { files: [], error: /choose.*1.*100/i },
    { files: [video, new File([], 'empty.mov')], error: /empty\.mov.*empty/i },
    { files: [video, new File(['text'], 'notes.txt', { type: 'text/plain' })], error: /notes\.txt.*video/i },
    { files: [video, new File(['audio'], 'song.mp3', { type: 'audio/mpeg' })], error: /song\.mp3.*video/i },
    { files: Array.from({ length: 101 }, () => video), error: /100/ },
  ];
  for (const { files, error } of cases) {
    await t.test(`${files.length} files: ${error}`, async t => {
      const requests = [];
      let metadataCalls = 0;
      const manager = createUploadManager('viewer', {
        metadata: async () => { metadataCalls++; return 20; },
        request: async (url, options = {}) => { requests.push({ url, options }); return { uploads: [] }; },
      });
      t.after(() => manager.dispose());
      await manager.ready;
      await assert.rejects(manager.addMany(files, { id: 'room', name: 'Room' }), error);
      assert.equal(metadataCalls, 0);
      assert.deepEqual(requests.map(item => item.url), ['/api/uploads']);
      assert.deepEqual(get(manager.transfers), []);
    });
  }
});

test('batch validation accepts video MIME types or common video extensions, including 100 files', async t => {
  const names = ['clip.MKV', 'clip.MOV', 'clip.mp4', 'clip.webm', 'clip.avi', 'clip.m4v', 'clip.ts',
    'clip.mts', 'clip.m2ts', 'clip.m2t', 'clip.mpeg', 'clip.mpg', 'clip.wmv', 'clip.flv', 'clip.ogv',
    'clip.3gp', 'clip.rm', 'clip.rmvb'];
  const files = Array.from({ length: 100 }, (_, index) => index === 99
    ? new File(['video'], 'extensionless', { type: 'video/mp4' })
    : new File(['video'], names[index % names.length], { type: 'application/octet-stream' }));
  let posts = 0;
  const manager = createUploadManager('viewer', {
    getDeliveryConfig: localDeliveryConfig,
    metadata: async () => undefined,
    request: async (url, options = {}) => {
      if (url === '/api/uploads') return { uploads: [] };
      if (options.method === 'POST') {
        posts++;
        assert.equal(options.body.files.length, 100);
        assert.equal(options.body.files.some(file => Object.hasOwn(file, 'duration')), false);
        return { uploads: files.map((_, index) => ({ uploadId: `video-${index}`, chunkSize: 524288 })),
          playlistId: 'playlist', playlistTitle: 'Videos' };
      }
      return { received: 5, complete: true };
    },
  });
  t.after(() => manager.dispose());
  await manager.ready;
  await manager.addMany(files, { id: 'room', name: 'Room' });
  assert.equal(posts, 1);
  assert.equal(get(manager.transfers).length, 100);
});

test('a rejected batch POST leaves no half-created transfers and preserves restored uploads', async t => {
  const requests = [];
  const manager = createUploadManager('viewer', {
    metadata: async () => 10,
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/uploads') return { uploads: [{ id: 'saved', name: 'old.mp4', size: 4 }] };
      throw new Error('Not enough space for the whole playlist.');
    },
  });
  t.after(() => manager.dispose());
  await manager.ready;
  const saved = get(manager.transfers);
  await assert.rejects(manager.addMany([new File(['one'], 'one.mp4'), new File(['two'], 'two.mp4')],
    { id: 'room', name: 'Room' }), /Not enough space/);
  assert.deepEqual(get(manager.transfers), saved);
  assert.deepEqual(requests.map(item => item.url), ['/api/uploads', '/api/rooms/room/uploads/batch']);
});

test('disposal aborts the four active video probes, releases their resources, and never starts the rest', async t => {
  const videos = [];
  const revoked = [];
  const requests = [];
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', { configurable: true, value: {
    createElement: tag => {
      assert.equal(tag, 'video');
      const video = { duration: NaN, loads: 0, src: '',
        removeAttribute(name) { assert.equal(name, 'src'); this.src = ''; },
        load() { this.loads++; },
      };
      videos.push(video);
      return video;
    },
  } });
  t.after(() => {
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else delete globalThis.document;
  });
  t.mock.method(URL, 'createObjectURL', () => `blob:probe-${videos.length}`);
  t.mock.method(URL, 'revokeObjectURL', url => revoked.push(url));
  const manager = createUploadManager('viewer', {
    request: async (url, options = {}) => { requests.push({ url, options }); return { uploads: [] }; },
  });
  t.after(() => manager.dispose());
  await manager.ready;
  const adding = manager.addMany(Array.from({ length: 6 }, (_, index) => new File(['video'], `${index}.mp4`)),
    { id: 'room', name: 'Room' });
  assert.equal(videos.length, 4);
  const rejected = assert.rejects(adding, { name: 'AbortError' });
  manager.dispose();
  await rejected;
  assert.equal(videos.length, 4);
  assert.deepEqual(revoked, ['blob:probe-1', 'blob:probe-2', 'blob:probe-3', 'blob:probe-4']);
  for (const video of videos) {
    assert.equal(video.src, '');
    assert.equal(video.loads, 1);
    assert.equal(video.onloadedmetadata, null);
    assert.equal(video.onerror, null);
  }
  assert.deepEqual(get(manager.transfers), []);
  assert.deepEqual(requests.map(item => item.url), ['/api/uploads']);
});

test('a disposed manager rejects single and batch additions without probing or creating uploads', async () => {
  let metadataCalls = 0;
  const requests = [];
  const manager = createUploadManager('viewer', {
    metadata: async () => { metadataCalls++; return 10; },
    request: async (url, options = {}) => { requests.push({ url, options }); return { uploads: [] }; },
  });
  await manager.ready;
  manager.dispose();
  const file = new File(['video'], 'clip.mp4');
  await assert.rejects(manager.add(file, { id: 'room', name: 'Room' }), { name: 'AbortError' });
  await assert.rejects(manager.addMany([file, file], { id: 'room', name: 'Room' }), { name: 'AbortError' });
  assert.equal(metadataCalls, 0);
  assert.deepEqual(requests.map(item => item.url), ['/api/uploads']);
  assert.deepEqual(get(manager.transfers), []);
});

test('late metadata and creation responses cannot add transfers after disposal, even if they ignore abort', async t => {
  for (const stage of ['metadata', 'POST']) {
    await t.test(stage, async t => {
      const files = [new File(['one'], 'one.mp4'), new File(['two'], 'two.mp4')];
      const probes = [];
      const requests = [];
      let resolvePost;
      const result = { uploads: files.map((_, index) => ({ uploadId: `late-${index}`, chunkSize: 524288 })),
        playlistId: 'late-playlist', playlistTitle: 'Late' };
      const manager = createUploadManager('viewer', {
        metadata: () => stage === 'metadata' ? new Promise(resolve => probes.push(resolve)) : Promise.resolve(10),
        request: async (url, options = {}) => {
          requests.push({ url, options });
          if (url === '/api/uploads') return { uploads: [] };
          return new Promise(resolve => { resolvePost = resolve; });
        },
      });
      t.after(() => manager.dispose());
      await manager.ready;
      const adding = manager.addMany(files, { id: 'room', name: 'Room' });
      const rejected = assert.rejects(adding, { name: 'AbortError' });
      if (stage === 'POST') await until(() => !!resolvePost);
      manager.dispose();
      if (stage === 'metadata') probes.forEach(resolve => resolve(10));
      else resolvePost(result);
      await rejected;
      assert.deepEqual(get(manager.transfers), []);
      assert.equal(requests.length, stage === 'metadata' ? 1 : 2);
      assert.equal(requests.every(item => item.options.signal.aborted), true);
    });
  }
});

test('add and one-file addMany retain the single upload endpoint and ungrouped response', async t => {
  for (const method of ['add', 'addMany']) {
    await t.test(method, async t => {
      const file = new File(['single'], 'clip.mov', { type: 'video/quicktime', lastModified: 321 });
      const requests = [];
      const result = { uploadId: 'single', chunkSize: 524288 };
      let uploaded = '';
      const manager = createUploadManager('viewer', {
        getDeliveryConfig: localDeliveryConfig,
        metadata: async () => method === 'add' ? 12 : undefined,
        request: async (url, options = {}) => {
          requests.push({ url, options });
          if (url === '/api/uploads') return { uploads: [] };
          if (options.method === 'POST') return result;
          if (options.method === 'PUT') uploaded += await options.body.text();
          return { received: uploaded.length, complete: uploaded.length === file.size, active: true };
        },
      });
      t.after(() => manager.dispose());
      await manager.ready;
      assert.deepEqual(await manager[method](method === 'add' ? file : [file], { id: 'room', name: 'Room' }, 0), result);
      const posts = requests.filter(item => item.options.method === 'POST');
      assert.equal(posts.length, 1);
      assert.equal(posts[0].url, '/api/rooms/room/uploads');
      assert.deepEqual(posts[0].options.body, { name: file.name, size: file.size, lastModified: 321,
        mime: file.type, ...(method === 'add' ? { duration: 12 } : {}), insertAt: 0 });
      assert.equal(get(manager.transfers).length, 1);
      await until(() => get(manager.transfers)[0].state === 'complete');
      assert.equal(uploaded, 'single');
    });
  }
});

test('batch registration returns while inactive files wait and every file gets its own worker', { timeout: 5000 }, async t => {
  const files = ['one', 'two', 'three'].map(name => new File([name], `${name}.mp4`));
  const uploaded = files.map(() => '');
  let activateLater = false;
  let releaseWait;
  const manager = createUploadManager('viewer', {
    getDeliveryConfig: localDeliveryConfig,
    metadata: async () => 10,
    wait: (delay, signal) => {
      assert.ok(delay >= 1000);
      return new Promise((resolve, reject) => {
        const abort = () => reject(new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', abort, { once: true });
        releaseWait = () => { signal.removeEventListener('abort', abort); resolve(); };
      });
    },
    request: async (url, options = {}) => {
      if (url === '/api/uploads') return { uploads: [] };
      if (options.method === 'POST') return {
        uploads: files.map((_, index) => ({ uploadId: `scheduled-${index}`, chunkSize: 2 })),
        playlistId: 'scheduled', playlistTitle: 'Scheduled',
      };
      const index = Number(/scheduled-(\d+)/.exec(url)[1]);
      if (options.method === 'PUT') uploaded[index] += await options.body.text();
      return { received: uploaded[index].length, complete: uploaded[index].length === files[index].size,
        active: index < 2 || activateLater, delayMs: 0 };
    },
  });
  t.after(() => manager.dispose());
  await manager.ready;
  await manager.addMany(files, { id: 'room', name: 'Room' });
  await until(() => get(manager.transfers).slice(0, 2).every(item => item.state === 'complete') && !!releaseWait);
  assert.equal(get(manager.transfers).length, 3);
  assert.equal(get(manager.transfers)[2].state, 'waiting');
  assert.deepEqual(uploaded, ['one', 'two', '']);
  activateLater = true;
  releaseWait();
  await until(() => get(manager.transfers).every(item => item.state === 'complete'));
  assert.deepEqual(uploaded, ['one', 'two', 'three']);
});

test('direct uploads keep metadata proxied but send bounded chunks only to the granted destination', async t => {
  const origin = 'https://delivery.example';
  const id = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
  const file = new File(['abcdefghij'], 'clip.mp4', { lastModified: 123 });
  const requests = [];
  const waits = [];
  const rates = [];
  let received = 2;
  let version = 0;
  let clock = 0;
  let loseResponse = true;
  const status = () => ({ received, complete: received === file.size, active: true, delayMs: 250,
    transferUrl: `${origin}/direct/uploads/${id}?grant=opaque%2Bsession-${version}` });
  const manager = createUploadManager('viewer', {
    getDeliveryConfig: async () => ({ bareMetalOrigin: origin }),
    metadata: async () => 10,
    now: () => clock,
    wait: async delay => { waits.push(delay); clock += delay; },
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/uploads') return { uploads: [] };
      if (options.method === 'POST') return { uploadId: id, chunkSize: 3 };
      if (options.method === 'DELETE') return {};
      if (options.method === 'PUT') {
        assert.equal(url, `${status().transferUrl}&offset=${received}`);
        const chunk = await options.body.text();
        assert.ok(options.body.size <= 3);
        assert.equal(chunk, (await file.text()).slice(received, received + 3));
        received += chunk.length;
        version++;
        clock += 100;
        if (loseResponse) {
          loseResponse = false;
          throw new Error('Response lost after saving the chunk');
        }
      } else assert.equal(url, `/api/uploads/${id}`);
      return status();
    },
  });
  t.after(() => manager.dispose());
  t.after(manager.transfers.subscribe(items => { if (items[0]?.rate) rates.push(items[0].rate); }));
  await manager.ready;
  await manager.add(file, { id: 'room', name: 'Room' });
  await until(() => ['complete', 'error'].includes(get(manager.transfers)[0].state));
  assert.equal(get(manager.transfers)[0].state, 'complete', get(manager.transfers)[0].error);
  const puts = requests.filter(item => item.options.method === 'PUT');
  assert.deepEqual(puts.map(item => Number(new URL(item.url).searchParams.get('offset'))), [2, 5, 8]);
  assert.equal(puts.every(item => item.url.startsWith(`${origin}/direct/uploads/`)), true);
  assert.equal(requests.some(item => item.options.body instanceof Blob && item.url.startsWith('/api/')), false);
  assert.deepEqual(waits, [250, 1000, 250, 250]);
  assert.deepEqual([...new Set(rates)], [30, 27], 'pacing and recovery waits must not reduce the measured byte rate');
  assert.equal(requests.filter(item => item.url === `/api/uploads/${id}`).length, 2);
  assert.equal(requests.find(item => item.options.method === 'POST').url, '/api/rooms/room/uploads');
  await manager.cancel(id);
  assert.equal(requests.at(-1).url, `/api/uploads/${id}`);
  assert.equal(requests.at(-1).options.method, 'DELETE');
});

test('direct upload configuration and missing or invalid grants fail closed without sending any bytes', async t => {
  const origin = 'https://delivery.example';
  const id = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
  const valid = `${origin}/direct/uploads/${id}?grant=opaque`;
  const cases = [
    ...[undefined, null, '', `/api/uploads/${id}`, valid.replace(origin, 'https://other.example'),
      valid.replace('https:', 'http:'), valid.replace(id, 'different-id'), `${valid}#hash`,
      valid.replace('delivery.example', 'user:pass@delivery.example'),
      valid.replace('/direct/uploads/', '/direct/media/'), `${valid}&offset=0`, valid.replace('grant=opaque', 'grant=')]
      .map(transferUrl => ({ config: { bareMetalOrigin: origin }, transferUrl, error: /invalid direct upload URL/ })),
    { config: {}, transferUrl: valid, error: /invalid delivery configuration/ },
    { config: { bareMetalOrigin: 'http://public.example' }, transferUrl: valid, error: /invalid delivery configuration/ },
    { config: { bareMetalOrigin: '' }, transferUrl: valid, error: /invalid direct upload URL/ },
    { failure: new Error('Configuration unavailable'), transferUrl: undefined, error: /Configuration unavailable/ },
  ];
  for (const [index, { config, transferUrl, failure, error }] of cases.entries()) {
    await t.test(`invalid destination ${index + 1}`, async t => {
      const requests = [];
      const manager = createUploadManager('viewer', {
        getDeliveryConfig: async () => { if (failure) throw failure; return config; },
        metadata: async () => 10,
        wait: async () => {},
        request: async (url, options = {}) => {
          requests.push({ url, options });
          if (url === '/api/uploads') return { uploads: [] };
          if (options.method === 'POST') return { uploadId: id, chunkSize: 2 };
          if (options.method === 'PUT') return { received: 4, complete: true };
          return { received: 0, complete: false, active: true, transferUrl };
        },
      });
      t.after(() => manager.dispose());
      await manager.ready;
      await manager.add(new File(['data'], 'clip.mp4'), { id: 'room', name: 'Room' });
      await until(() => ['error', 'complete'].includes(get(manager.transfers)[0].state));
      assert.equal(get(manager.transfers)[0].state, 'error');
      assert.match(get(manager.transfers)[0].error, error);
      assert.equal(requests.some(item => item.options.method === 'PUT'), false);
      assert.equal(requests.some(item => item.options.body instanceof Blob), false);
    });
  }
});

test('a direct PUT response must supply a valid destination for the next chunk; resuming reacquires status', async t => {
  const origin = 'https://delivery.example';
  const id = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
  const requests = [];
  let received = 0;
  let grant = 'first';
  const manager = createUploadManager('viewer', {
    getDeliveryConfig: async () => ({ bareMetalOrigin: origin }),
    metadata: async () => 10,
    request: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/uploads') return { uploads: [] };
      if (options.method === 'POST') return { uploadId: id, chunkSize: 2 };
      if (options.method === 'PUT') {
        received += options.body.size;
        return { received, complete: received === 4 };
      }
      return { received, complete: false, active: true, transferUrl: `${origin}/direct/uploads/${id}?grant=${grant}` };
    },
  });
  t.after(() => manager.dispose());
  await manager.ready;
  await manager.add(new File(['data'], 'clip.mp4'), { id: 'room', name: 'Room' });
  await until(() => ['error', 'complete'].includes(get(manager.transfers)[0].state));
  assert.equal(get(manager.transfers)[0].state, 'error');
  assert.match(get(manager.transfers)[0].error, /invalid direct upload URL/);
  assert.equal(received, 2);
  assert.equal(requests.filter(item => item.options.method === 'PUT').length, 1);
  grant = 'resumed';
  manager.resume(id);
  await until(() => get(manager.transfers)[0].state === 'complete');
  assert.deepEqual(requests.filter(item => item.options.method === 'PUT').map(item => item.url), [
    `${origin}/direct/uploads/${id}?grant=first&offset=0`, `${origin}/direct/uploads/${id}?grant=resumed&offset=2`,
  ]);
  assert.equal(requests.filter(item => item.url === `/api/uploads/${id}`).length, 2);
});

test('pause, cancel, and disposal stop direct uploads during config loading, pacing, or an in-flight PUT', async t => {
  for (const stage of ['config', 'pacing', 'PUT']) {
    for (const action of ['pause', 'cancel', 'dispose']) {
      await t.test(`${action} during ${stage}`, async t => {
        const id = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
        const origin = 'https://delivery.example';
        const config = { bareMetalOrigin: origin };
        const status = { received: 0, complete: false, active: true, delayMs: stage === 'pacing' ? 1000 : 0,
          transferUrl: `${origin}/direct/uploads/${id}?grant=opaque` };
        const entered = Promise.withResolvers();
        const pending = Promise.withResolvers();
        const requests = [];
        const manager = createUploadManager('viewer', {
          getDeliveryConfig: async () => {
            if (stage !== 'config') return config;
            entered.resolve();
            return pending.promise;
          },
          metadata: async () => 10,
          wait: async () => { entered.resolve(); return pending.promise; },
          request: async (url, options = {}) => {
            requests.push({ url, options });
            if (url === '/api/uploads') return { uploads: [] };
            if (options.method === 'POST') return { uploadId: id, chunkSize: 2 };
            if (options.method === 'PUT') { entered.resolve(); return pending.promise; }
            if (options.method === 'DELETE') return {};
            return status;
          },
        });
        t.after(() => manager.dispose());
        await manager.ready;
        await manager.add(new File(['data'], 'clip.mp4'), { id: 'room', name: 'Room' });
        await entered.promise;
        const before = get(manager.transfers);
        await manager[action](id);
        pending.resolve(stage === 'config' ? config : { ...status, received: 2 });
        await tick();
        const puts = requests.filter(item => item.options.method === 'PUT');
        assert.equal(puts.length, stage === 'PUT' ? 1 : 0);
        assert.equal(puts.every(item => item.url.startsWith(`${origin}/direct/uploads/`) && item.options.signal.aborted), true);
        if (action === 'pause') assert.equal(get(manager.transfers)[0].state, 'paused');
        if (action === 'dispose') assert.equal(get(manager.transfers), before);
        if (action === 'cancel') {
          assert.deepEqual(get(manager.transfers), []);
          assert.equal(requests.at(-1).url, `/api/uploads/${id}`);
          assert.equal(requests.at(-1).options.method, 'DELETE');
        }
      });
    }
  }
});