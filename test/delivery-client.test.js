import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { setImmediate as tick } from 'node:timers/promises';
import { parse } from 'svelte/compiler';
import { api } from '../src/lib/api.js';
import { createDeliveryClient, DeliveryError, isSameOriginUrl, uploadTransferUrl } from '../src/lib/delivery.js';
import { targetPosition } from '../src/lib/format.js';
import { createBufferHealth, isProxyLoadFailure } from '../src/lib/buffer-health.js';
import { qualityReady } from '../src/lib/media-quality.js';

const appOrigin = 'https://app.example';
const directOrigin = 'https://delivery.example';
const jobId = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
const otherId = '047d987c-5112-45fd-a1a5-1933fdb1d342';
const mediaPath = `/media/${jobId}/index.m3u8`;
const accessPath = `/api/media/${jobId}/access`;
const directMediaUrl = `${directOrigin}/direct${mediaPath}?grant=opaque%2Bsession`;

function invalidDestinations(path) {
  const valid = `${directOrigin}${path}?grant=opaque`;
  return [undefined, null, '', path, `//delivery.example${path}?grant=opaque`,
    valid.replace(directOrigin, appOrigin), valid.replace('delivery.example', 'delivery.example.evil.test'),
    valid.replace('delivery.example', 'delivery.example:8443'), valid.replace('https:', 'http:'),
    valid.replace('delivery.example', 'user:password@delivery.example'),
    valid.replace('delivery.example', '@delivery.example'), valid.replace(jobId, otherId),
    valid.replace('/direct/', '/api/'), valid.replace('/direct/', '/unexpected/../direct/'),
    valid.replace('/direct/', '/%64irect/'), valid.replace('/direct/', '/direct//'),
    valid.replace('/direct/', '\\direct/'), `${valid}#fragment`, `${valid}#`,
    `${valid}&offset=0`, `${valid}&grant=second`, `${valid}&other=value`,
    `${directOrigin}${path}`, `${directOrigin}${path}?grant=`, `${directOrigin}${path}?grant=%20`,
    ` ${valid}`, `${valid}\n`, `${valid}&`, valid.replace('?grant=', '?%67rant=')];
}

test('delivery configuration is lazy, shared across concurrent consumers, and cached only on success', async () => {
  const pending = Promise.withResolvers();
  const requests = [];
  const client = createDeliveryClient({ request: async url => { requests.push(url); return pending.promise; } });
  assert.deepEqual(requests, []);
  const first = client.getConfig();
  const second = client.getConfig();
  assert.equal(first, second);
  pending.resolve({ bareMetalOrigin: directOrigin });
  assert.deepEqual(await first, { bareMetalOrigin: directOrigin });
  assert.equal(await first, await client.getConfig());
  assert.equal(Object.isFrozen(await first), true);
  assert.deepEqual(requests, ['/api/config']);

  let attempts = 0;
  const retrying = createDeliveryClient({ request: async () => {
    if (++attempts === 1) throw new Error('offline');
    return { bareMetalOrigin: '' };
  } });
  await assert.rejects(retrying.getConfig(), /offline/);
  assert.deepEqual(await retrying.getConfig(), { bareMetalOrigin: '' });
  assert.equal(attempts, 2);
});

test('delivery accepts HTTPS origins, loopback HTTP origins, and an explicitly empty local configuration', async () => {
  for (const bareMetalOrigin of ['', directOrigin, `${directOrigin}:8443`, 'http://localhost:3000',
    'http://127.0.0.1:3000', 'http://127.2.3.4', 'http://[::1]:3000']) {
    const client = createDeliveryClient({ request: async () => ({ bareMetalOrigin }) });
    assert.deepEqual(await client.getConfig(), { bareMetalOrigin });
  }
});

test('malformed or unsafe configuration fails closed before media access and can be retried', async () => {
  const invalid = [undefined, null, {}, [], '', { bareMetalOrigin: null }, { bareMetalOrigin: false },
    ...[' ', 'http://delivery.example', 'http://127.evil.test', 'http://localhost.evil.test',
      'http://192.168.0.1', 'http://[::2]', 'ftp://delivery.example', '//delivery.example',
      `${directOrigin}/`, `${directOrigin}/direct`, `${directOrigin}?q=1`, `${directOrigin}#`,
      'https://user:pass@delivery.example', ` ${directOrigin}`, `${directOrigin}\n`]
      .map(bareMetalOrigin => ({ bareMetalOrigin }))];
  for (const config of invalid) {
    const requests = [];
    let response = config;
    const client = createDeliveryClient({ origin: () => appOrigin, request: async url => {
      requests.push(url);
      return response;
    } });
    await assert.rejects(client.resolveMediaUrl(mediaPath), DeliveryError);
    assert.deepEqual(requests, ['/api/config']);
    response = { bareMetalOrigin: '' };
    assert.deepEqual(await client.getConfig(), response);
    assert.deepEqual(requests, ['/api/config', '/api/config']);
  }
});

test('only a validated same-origin media job may request access', async () => {
  const requests = [];
  const client = createDeliveryClient({ origin: () => appOrigin, request: async url => { requests.push(url); } });
  for (const value of [undefined, null, '', '/api/logout', '/media/not-a-uuid/index.m3u8',
    `${directOrigin}${mediaPath}`, directMediaUrl, `//app.example${mediaPath}`,
    `https://user:pass@app.example${mediaPath}`, `${mediaPath}?grant=x`, `${mediaPath}?`,
    `${mediaPath}#x`, `${mediaPath}#`, mediaPath.replace('/media/', '/other/../media/'),
    mediaPath.replace('/media/', '/%6dedia/'), mediaPath.replace('index.m3u8', 'key.bin'),
    ` ${mediaPath}`, `${mediaPath}\n`]) {
    await assert.rejects(client.resolveMediaUrl(value), DeliveryError);
  }
  assert.deepEqual(requests, []);
});

test('media access is resolved per attachment while configuration is shared, including local and YouTube playback', async () => {
  for (const bareMetalOrigin of ['', directOrigin]) {
    const requests = [];
    let url = mediaPath;
    const client = createDeliveryClient({ origin: () => appOrigin, request: async (path, options) => {
      requests.push({ path, options });
      return path === '/api/config' ? { bareMetalOrigin } : { url };
    } });
    const controller = new AbortController();
    assert.equal(await client.resolveMediaUrl(mediaPath, { signal: controller.signal }), `${appOrigin}${mediaPath}`);
    url = bareMetalOrigin ? directMediaUrl : mediaPath;
    assert.equal(await client.resolveMediaUrl(`${appOrigin}${mediaPath}`), bareMetalOrigin ? url : `${appOrigin}${url}`);
    assert.deepEqual(requests.map(item => item.path), ['/api/config', accessPath, accessPath]);
    assert.equal(requests[1].options.signal, controller.signal);
  }
});

test('media access and direct upload destinations require the exact configured origin, resource, path, and grant', async () => {
  let url;
  const client = createDeliveryClient({ origin: () => appOrigin, request: async path => path === '/api/config'
    ? { bareMetalOrigin: directOrigin } : { url } });
  for (url of [...invalidDestinations(`/direct${mediaPath}`), mediaPath.replace(jobId, otherId),
    `${appOrigin}${mediaPath}`, directMediaUrl.replace('index.m3u8', 'key.bin')]) {
    await assert.rejects(client.resolveMediaUrl(mediaPath), DeliveryError);
  }
  for (const transferUrl of invalidDestinations(`/direct/uploads/${jobId}`)) {
    assert.throws(() => uploadTransferUrl(jobId, transferUrl, { bareMetalOrigin: directOrigin }), DeliveryError);
  }
  const transferUrl = `${directOrigin}/direct/uploads/${jobId}?grant=opaque%2B%2F%3D`;
  assert.equal(uploadTransferUrl(jobId, transferUrl, { bareMetalOrigin: directOrigin }), transferUrl);
  assert.equal(uploadTransferUrl(jobId, undefined, { bareMetalOrigin: '' }), `/api/uploads/${jobId}`);
  assert.throws(() => uploadTransferUrl(jobId, undefined, {}), DeliveryError);
  assert.throws(() => uploadTransferUrl(jobId, transferUrl, { bareMetalOrigin: '' }), DeliveryError);
  assert.throws(() => uploadTransferUrl('../other', undefined, { bareMetalOrigin: '' }), DeliveryError);
  const local = createDeliveryClient({ origin: () => appOrigin, request: async path => path === '/api/config'
    ? { bareMetalOrigin: '' } : { url: directMediaUrl } });
  await assert.rejects(local.resolveMediaUrl(mediaPath), DeliveryError);
});

test('aborting one media attachment does not cancel shared config or allow its stale access request', async () => {
  const config = Promise.withResolvers();
  const requests = [];
  const client = createDeliveryClient({ origin: () => appOrigin, request: async path => {
    requests.push(path);
    return path === '/api/config' ? config.promise : { url: mediaPath };
  } });
  const controller = new AbortController();
  const stale = client.resolveMediaUrl(mediaPath, { signal: controller.signal });
  const current = client.resolveMediaUrl(mediaPath);
  const rejected = assert.rejects(stale, { name: 'AbortError' });
  controller.abort();
  config.resolve({ bareMetalOrigin: '' });
  await rejected;
  assert.equal(await current, `${appOrigin}${mediaPath}`);
  assert.deepEqual(requests, ['/api/config', accessPath]);
});

test('late media access responses are rejected after abort, and access errors never fall back to state URLs', async () => {
  const pending = Promise.withResolvers();
  const entered = Promise.withResolvers();
  const client = createDeliveryClient({ origin: () => appOrigin, request: async (path, options) => {
    if (path === '/api/config') return { bareMetalOrigin: directOrigin };
    entered.resolve(options.signal);
    return pending.promise;
  } });
  const controller = new AbortController();
  const resolving = client.resolveMediaUrl(mediaPath, { signal: controller.signal });
  assert.equal(await entered.promise, controller.signal);
  const rejected = assert.rejects(resolving, { name: 'AbortError' });
  controller.abort();
  pending.resolve({ url: directMediaUrl });
  await rejected;

  const denied = createDeliveryClient({ origin: () => appOrigin, request: async path => {
    if (path === '/api/config') return { bareMetalOrigin: '' };
    throw new Error('Access denied');
  } });
  await assert.rejects(denied.resolveMediaUrl(mediaPath), /Access denied/);
});

test('API requests retain same-origin-only credentials for direct PUTs and authenticated metadata', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    return new Response('{}', { status: 200 });
  });
  await api('/api/config');
  const body = new Blob(['bytes']);
  await api(`${directOrigin}/direct/uploads/${jobId}?grant=opaque&offset=0`, { method: 'PUT', body });
  assert.equal(requests.every(item => item.options.credentials === 'same-origin'), true);
  assert.equal(requests[1].options.body, body);
  assert.equal(requests[1].options.headers['Content-Type'], 'application/octet-stream');
  assert.equal(requests[1].options.headers.Cookie, undefined);
});

// Exercise the real component's source lifecycle without a DOM or media decoder; browser coverage runs separately.
const playerSource = await readFile(new URL('../src/components/Player.svelte', import.meta.url), 'utf8');
const playerAst = parse(playerSource);
const sourceLifecycle = playerAst.instance.content.body.filter(node => node.type === 'VariableDeclaration' ||
  (node.type === 'FunctionDeclaration' && ['cleanupSource', 'attach', 'retryPlayback', 'switchToMetal',
    'reportBufferHealth', 'nativePlaybackError', 'useStandardQuality'].includes(node.id.name)))
  .map(node => playerSource.slice(node.start, node.end)).join('\n');

function playerHarness(resolveMediaUrl, native = false) {
  const instances = [];
  const previews = [];
  class Hls {
    static Events = { MEDIA_ATTACHED: 'attached', MANIFEST_PARSED: 'parsed', ERROR: 'error', FRAG_LOADED: 'loaded' };
    static ErrorTypes = { MEDIA_ERROR: 'media', NETWORK_ERROR: 'network' };
    static isSupported() { return !native; }
    constructor(config) { this.config = config; this.events = new Map(); instances.push(this); }
    on(event, callback) { this.events.set(event, callback); }
    attachMedia() { this.events.get('attached')(); }
    loadSource(url) { this.source = url; }
    startLoad(position) { this.position = position; }
    destroy() { this.destroyed = true; }
  }
  const video = { src: '', pause() {}, load() {}, canPlayType() { return 'probably'; },
    removeAttribute(name) { assert.equal(name, 'src'); this.src = ''; } };
  const room = { current: { id: 'queue-item-not-job-id', duration: 100, media: { url: mediaPath, baseTime: 5 } },
    playback: { paused: true, position: 30, updatedAt: 0 } };
  const createSeekPreview = (_hls, _events, _video, callback) => {
    const preview = { callback, destroy() { this.destroyed = true; } };
    previews.push(preview);
    return preview;
  };
  const create = new Function('delivery', 'Hls', 'targetPosition', 'createSeekPreview', 'isSameOriginUrl',
    'room', 'clockOffset', 'element', 'createBufferHealth', 'isProxyLoadFailure', 'qualityReady', `${sourceLifecycle}
    video = element;
    let connected = true;
    let item = room.current;
    let media = item.media;
    const qualities = [];
    return {attach, cleanupSource, retryPlayback, switchToMetal, nativePlaybackError,
      qualities, state: () => ({playerError, localBuffering, previewPosition, mediaAccess, fallbackNotice, qualityPreference, qualityFallbackItemId})};`);
  return { ...create({ resolveMediaAccess: async (...args) => {
    const access = await resolveMediaUrl(...args);
    return typeof access === 'string' ? {url: access, fallbackUrl: null, route: 'metal'} : access;
  } }, Hls, targetPosition, createSeekPreview,
    value => isSameOriginUrl(value, appOrigin), room, 0, video, createBufferHealth, isProxyLoadFailure, qualityReady),
    instances, previews, video, room };
}

test('original playback errors select the ready standard quality in HLS.js and native players', async () => {
  for (const native of [false, true]) {
    const player = playerHarness(async () => directMediaUrl, native);
    player.room.current.media.id = 'original';
    player.qualities.push({id: 'standard', baseTime: 5, bufferedUntil: 50, complete: true});
    await player.attach(player.room.current.id, mediaPath, 5);
    if (native) player.nativePlaybackError();
    else player.instances[0].events.get('error')('error', {fatal: true, type: 'media'});
    assert.equal(player.state().qualityPreference, 'original');
    assert.equal(player.state().qualityFallbackItemId, player.room.current.id);
    assert.equal(player.state().playerError, '');
  }
});

test('player generation guards discard stale responses and errors after source changes, removal, or destruction', async t => {
  for (const native of [false, true]) {
    for (const outcome of ['resolve', 'reject']) {
      await t.test(`${native ? 'native' : 'hls.js'}: stale ${outcome}`, async () => {
        const pending = [];
        const player = playerHarness((url, { signal }) => {
          const response = Promise.withResolvers();
          pending.push({ ...response, url, signal });
          return response.promise;
        }, native);
        const first = player.attach('first', mediaPath, 5);
        assert.equal(player.instances.length, 0);
        assert.equal(player.video.src, '');
        const second = player.attach('second', mediaPath.replace(jobId, otherId), 10);
        assert.equal(pending[0].signal.aborted, true);
        pending[1].resolve(directMediaUrl.replace(jobId, otherId));
        await second;
        pending[0][outcome](outcome === 'resolve' ? directMediaUrl : new Error('stale error'));
        await first;
        assert.equal(player.state().playerError, '');
        assert.equal(native ? player.video.src : player.instances[0].source, directMediaUrl.replace(jobId, otherId));
        assert.equal(player.instances.length, native ? 0 : 1);
        for (const stop of [() => player.attach(null, null, 0), () => player.cleanupSource()]) {
          const late = player.attach('late', mediaPath, 0);
          const response = pending.at(-1);
          await stop();
          assert.equal(response.signal.aborted, true);
          response.resolve(directMediaUrl);
          await late;
          assert.equal(player.video.src, '');
          assert.equal(player.instances.length, native ? 0 : 1);
          assert.equal(player.state().playerError, '');
        }
        assert.equal(player.instances.every(instance => instance.destroyed), true);
        assert.equal(player.previews.every(preview => preview.destroyed), true);
      });
    }
  }
});

test('player access errors use the retry UI and reacquire access without disrupting alignment or previews', async () => {
  const pending = [];
  const player = playerHarness(() => {
    const response = Promise.withResolvers();
    pending.push(response);
    return response.promise;
  });
  const failing = player.attach(player.room.current.id, mediaPath, 5);
  pending[0].reject(new Error('Access temporarily unavailable'));
  await failing;
  assert.equal(player.state().playerError, 'Access temporarily unavailable');
  assert.equal(player.state().localBuffering, false);
  assert.equal(player.instances.length, 0);
  player.retryPlayback();
  assert.equal(pending.length, 2);
  pending[1].resolve(directMediaUrl);
  await tick();
  assert.equal(player.state().playerError, '');
  assert.equal(player.instances[0].source, directMediaUrl);
  assert.equal(player.instances[0].config.startPosition, 25);
  player.room.playback.position = 40;
  player.instances[0].events.get('parsed')();
  assert.equal(player.instances[0].position, 35);
  player.previews[0].callback({}, 12);
  assert.equal(player.state().previewPosition, 17);
  await player.attach(player.room.current.id, mediaPath, 5);
  assert.equal(pending.length, 2, 'the unchanged source must not acquire another grant');
  player.cleanupSource();
});

test('HLS credentials follow each actual request origin, including encrypted keys and segments; native is anonymous', async () => {
  const player = playerHarness(async () => directMediaUrl);
  await player.attach('item', mediaPath, 0);
  const { xhrSetup } = player.instances[0].config;
  for (const path of [mediaPath, mediaPath.replace('index.m3u8', 'key.bin'), mediaPath.replace('index.m3u8', 'segment-000001.ts')]) {
    for (const [url, expected] of [[path, true], [`${appOrigin}${path}`, true],
      [`${directOrigin}/direct${path}?grant=opaque`, false], [`https://elsewhere.example${path}`, false]]) {
      const xhr = { withCredentials: !expected };
      xhrSetup(xhr, url);
      assert.equal(xhr.withCredentials, expected, url);
    }
  }
  assert.match(playerSource, /<video\b[^>]*\bcrossorigin="anonymous"/);
  player.cleanupSource();
});

test('fallback URLs are validated before use and are optional for older or local servers', async () => {
  let fallbackUrl;
  const client = createDeliveryClient({origin: () => appOrigin, request: async path => path === '/api/config'
    ? {bareMetalOrigin: directOrigin} : {url: mediaPath, fallbackUrl}});
  for (fallbackUrl of invalidDestinations(`/direct${mediaPath}`).filter(value => value != null)) {
    await assert.rejects(client.resolveMediaAccess(mediaPath), DeliveryError);
  }
  fallbackUrl = directMediaUrl;
  assert.deepEqual(await client.resolveMediaAccess(mediaPath), {
    url: `${appOrigin}${mediaPath}`, fallbackUrl: directMediaUrl, route: 'cloudflare'});
  fallbackUrl = undefined;
  assert.equal((await client.resolveMediaAccess(mediaPath)).fallbackUrl, null);
});

test('automatic metal recovery reuses the validated grant, aligns to the room, and stays direct on retry', async () => {
  for (const native of [false, true]) {
    let requests = 0;
    const player = playerHarness(async () => {
      requests++;
      return {url: `${appOrigin}${mediaPath}`, fallbackUrl: directMediaUrl, route: 'cloudflare'};
    }, native);
    const {id} = player.room.current;
    await player.attach(id, mediaPath, 5);
    const revision = player.room.playback.revision;
    const oldInstance = player.instances[0];
    if (native) {
      player.video.error = {code: 2};
      player.nativePlaybackError();
    } else {
      oldInstance.events.get('error')(null, {details: 'fragLoadTimeOut', type: 'network',
        frag: {url: `${appOrigin}${mediaPath.replace('index.m3u8', 'segment-000001.ts')}`}});
    }
    assert.equal(requests, 1, 'Recovery must not request another grant through the stalled proxy.');
    assert.equal(player.state().mediaAccess.route, 'metal');
    assert.match(player.state().fallbackNotice, /Switched to metal/);
    assert.equal(native ? player.video.src : player.instances.at(-1).source, directMediaUrl);
    if (!native) {
      assert.equal(oldInstance.destroyed, true);
      assert.equal(player.instances.at(-1).config.startPosition, 25);
      oldInstance.events.get('error')(null, {fatal: true, type: 'network'});
      assert.equal(player.state().playerError, '', 'Late old-loader errors cannot replace the new source.');
    }
    assert.equal(player.room.playback.revision, revision);
    assert.equal(player.switchToMetal('Another failure'), false, 'No retry loop after switching.');
    player.retryPlayback();
    await tick();
    assert.equal(requests, 2);
    assert.equal(player.state().mediaAccess.route, 'metal');
    await player.attach(null, null, 0);
    assert.equal(player.state().fallbackNotice, '');
    await player.attach(id, mediaPath, 5);
    assert.equal(player.state().mediaAccess.route, 'cloudflare', 'A new viewing starts on the default route.');
    player.cleanupSource();
  }
});

test('failed direct playback exposes the existing retry UI instead of cycling through routes', async () => {
  const player = playerHarness(async () => ({url: `${appOrigin}${mediaPath}`, fallbackUrl: directMediaUrl, route: 'cloudflare'}));
  await player.attach(player.room.current.id, mediaPath, 5);
  player.switchToMetal('Buffer stayed low');
  player.instances.at(-1).events.get('error')(null, {details: 'fragLoadError', type: 'network', fatal: true,
    frag: {url: directMediaUrl.replace('index.m3u8', 'segment-000001.ts')}, response: {code: 502}});
  assert.match(player.state().playerError, /could not be loaded/);
  assert.equal(player.instances.length, 2);
  player.cleanupSource();
});
