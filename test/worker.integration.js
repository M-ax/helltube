import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { chromium } from 'playwright';
import { unstable_dev } from 'wrangler';
import { createApp } from '../server/app.js';
import { makeItem } from '../server/rooms.js';
import { until } from './helpers.js';
import { notifyPublishedWorker } from '../scripts/deploy-worker.mjs';

async function availablePorts(count) {
  const servers = [];
  try {
    for (let i = 0; i < count; i++) {
      const server = createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

async function login(page, origin) {
  page.setDefaultTimeout(15000);
  const response = await page.goto(origin);
  assert.equal(response.status(), 200, 'The actual Worker serves the built frontend.');
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
  await page.getByRole('button', { name: 'Enter Helltube' }).click();
  await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button', {name: /^The living room(?: |$)/}).click();
  await page.getByRole('button', { name: 'Your files', exact: true }).waitFor();
}

async function sessionCookie(context, origin) {
  const cookie = (await context.cookies(origin)).find(value => value.name === 'session');
  assert.ok(cookie, 'UI login creates a session cookie on the Worker origin.');
  return `${cookie.name}=${cookie.value}`;
}

async function decodedPlayback(page, item, previousSource = '') {
  await until(async () => {
    assert.notEqual(item.status, 'error', item.error);
    const enable = page.getByRole('button', { name: 'Enable playback', exact: true });
    if (await enable.isVisible()) await enable.click();
    return page.locator('video').evaluate((video, previous) => video.currentSrc !== previous &&
      !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.currentTime > 1 &&
      video.getVideoPlaybackQuality().totalVideoFrames > 0, previousSource);
  }, 35000);
  const state = await page.locator('video').evaluate(video => ({ source: video.currentSrc, time: video.currentTime }));
  await until(() => page.locator('video').evaluate((video, time) => !video.paused && video.currentTime > time + 0.3, state.time));
  return state.source;
}

test('real Worker shares encrypted HLS cache with per-hit auth while uploads and keys bypass it', { timeout: 180000 }, async t => {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'worker-'));
  let instance;
  let worker;
  let browser;
  const backendRequests = [];
  const browserRequests = [];
  const browserResponses = [];
  const browserSockets = [];
  const headerReads = [];
  let pageErrors = 0;
  try {
    const [backendPort, workerPort, inspectorPort] = await availablePorts(3);
    const origin = `http://127.0.0.1:${workerPort}`;
    const directOrigin = `http://localhost:${backendPort}`;
    const secret = randomBytes(32).toString('hex');
    instance = await createApp({ dataDir: path.join(dir, 'backend'), host: '127.0.0.1', port: backendPort,
      bareMetalOrigin: directOrigin, edgeProxySecret: secret, origins: [origin] });
    instance.server.on('request', req => backendRequests.push({ method: req.method,
      pathname: new URL(req.url, directOrigin).pathname }));
    const backendOrigin = await instance.listen(backendPort);
    assert.equal(instance.capabilities.ffmpeg, true, 'Real FFmpeg is required.');
    const sample = path.join(dir, 'split-delivery.mp4');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
      '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
      '-t', '16', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-movflags', '+faststart', sample], { timeout: 20000 });
    instance.app.get('/worker-test-source.mp4', (_req, res) => res.sendFile(sample));
    t.mock.method(instance.youtube, 'resolve', async () => ({ duration: 16,
      inputs: [{ url: `${backendOrigin}/worker-test-source.mp4`, headers: {} }] }));
    worker = await unstable_dev(path.resolve('worker.js'), {
      config: path.resolve('wrangler.jsonc'), ip: '127.0.0.1', port: workerPort, inspectorPort,
      local: true, persist: false, persistTo: path.join(dir, 'worker-state'), logLevel: 'none',
      vars: { BARE_METAL_ORIGIN: directOrigin, EDGE_PROXY_SECRET: secret, SEGMENT_CACHE_TTL: 120 },
      experimental: { disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true,
        watch: false, liveReload: false, showInteractiveDevSession: false },
    });
    const health = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(10000) });
    assert.equal(health.status, 200, 'The real Worker must reach bare metal before browser login.');
    await health.arrayBuffer();
    const version = JSON.parse(await readFile('dist/version.json', 'utf8'));
    await notifyPublishedWorker([origin], version, { attempts: 1 });
    assert.equal(instance.store.load('deployment').find(record => record.id === 'worker')?.commit, version.commit,
      'The real Worker acknowledges deployment only after metal persists its manifest commit.');
    const backendVersion = await fetch(`${origin}/api/version`);
    assert.equal((await backendVersion.json()).commit, instance.store.load('deployment').find(record => record.id === 'backend').commit);
    browser = await chromium.launch({ channel: 'chrome', headless: true,
      args: ['--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
    const watch = page => {
      page.on('pageerror', () => pageErrors++);
      page.on('websocket', socket => {
        const url = new URL(socket.url());
        browserSockets.push({ origin: url.origin, pathname: url.pathname });
      });
      page.on('request', request => {
        const url = new URL(request.url());
        const record = { origin: url.origin, pathname: url.pathname, method: request.method() };
        browserRequests.push(record);
        headerReads.push(request.allHeaders().then(headers => {
          record.hasCookie = Boolean(headers.cookie);
          record.site = headers['sec-fetch-site'];
        }));
      });
      page.on('response', response => {
        const url = new URL(response.url());
        const headers = response.headers();
        browserResponses.push({ origin: url.origin, pathname: url.pathname, status: response.status(),
          allowOrigin: headers['access-control-allow-origin'], credentials: headers['access-control-allow-credentials'],
          cacheControl: headers['cache-control'] });
      });
    };
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = await context.newPage();
    watch(page);
    await login(page, origin);
    const room = instance.rooms.get('lobby');
    await until(() => room.members.size === 1);
    const firstCookie = await sessionCookie(context, origin);
    await page.getByRole('button', { name: 'Your files', exact: true }).click();
    await page.getByLabel('Select a local video to upload', { exact: true }).setInputFiles(sample);
    const upload = await until(() => room.current?.kind === 'upload' && room.current);
    const uploadedSource = await decodedPlayback(page, upload);
    instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
    await until(() => upload.media?.complete, 25000);
    const uploadJob = instance.media.jobs.get(upload.id);
    const uploadPath = `/direct/media/${uploadJob.id}/`;
    await Promise.all(headerReads);
    const puts = browserRequests.filter(request => request.method === 'PUT');
    assert.ok(puts.length > 0, 'The UI actually transfers upload bytes.');
    for (const request of puts) {
      assert.equal(request.origin, directOrigin);
      assert.match(request.pathname, /^\/direct\/uploads\//);
      assert.equal(request.hasCookie, false, 'Cross-site upload PUTs must not use cookies.');
      assert.equal(request.site, 'cross-site');
    }
    assert.ok(browserRequests.some(request => request.method === 'POST' &&
      request.pathname.startsWith('/api/rooms/lobby/uploads') && request.origin === origin));
    for (const file of [/index\.m3u8$/, /segment-\d+\.ts$/, /key\.bin$/]) {
      assert.ok(browserRequests.some(request => request.origin === directOrigin &&
        request.pathname.startsWith(uploadPath) && file.test(request.pathname)), 'Uploaded HLS uses direct delivery.');
    }
    assert.equal(browserRequests.some(request => request.pathname.startsWith(`/media/${uploadJob.id}/`)), false);
    assert.equal(backendRequests.some(request => request.pathname.startsWith(`/api/edge/media/${uploadJob.id}/`)), false);
    t.diagnostic('Chrome decoded the UI upload; cross-site upload PUTs and all uploaded HLS bytes bypassed the Worker.');

    const youtube = makeItem({ kind: 'youtube', url: 'https://www.youtube.com/watch?v=BaW_jenozKc' },
      { title: 'Synthetic YouTube delivery', duration: 16 });
    instance.rooms.add(room, [youtube]);
    await until(() => {
      assert.notEqual(youtube.status, 'error', youtube.error);
      return youtube.media?.complete;
    }, 30000);
    const job = instance.media.jobs.get(youtube.id);
    const contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
    assert.match(contents, /#EXT-X-KEY:METHOD=AES-128,/);
    assert.equal(instance.youtube.resolve.mock.callCount(), 1, 'Only external source resolution is mocked.');
    assert.ok(backendRequests.some(request => request.pathname === '/worker-test-source.mp4'));
    instance.rooms.advance(room);
    assert.equal(room.current.id, youtube.id);
    await decodedPlayback(page, youtube, uploadedSource);
    await Promise.all(headerReads);
    for (const file of [/index\.m3u8$/, /segment-\d+\.ts$/]) {
      assert.ok(browserRequests.some(request => request.origin === origin &&
        request.pathname.startsWith(`/media/${job.id}/`) && file.test(request.pathname)), 'YouTube HLS travels through the Worker.');
    }
    assert.ok(browserRequests.some(request => request.origin === directOrigin &&
      request.pathname === `/direct/media/${job.id}/key.bin`));
    assert.equal(browserRequests.some(request => request.pathname.startsWith(`/direct/media/${job.id}/`) &&
      !request.pathname.endsWith('/key.bin')), false, 'YouTube playlists and segments must not bypass the Worker.');
    t.diagnostic('Chrome decoded AES-128 YouTube HLS with Worker playlists/segments and a cross-site direct key.');

    for (const {stalledFile, fail} of [{stalledFile: 'index.m3u8'}, {stalledFile: 'segment-*.ts'},
      {stalledFile: 'segment-*.ts', fail: true}]) {
      instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
      instance.rooms.control(room, {action: 'seek', position: 0, revision: room.playback.revision});
      const pending = [];
      const pattern = `${origin}/media/${job.id}/${stalledFile}`;
      await page.route(pattern, route => {
        pending.push(route);
        if (fail) return route.fulfill({status: 503, body: 'Proxy unavailable'});
      });
      try {
        await page.reload();
        await until(() => pending.length > 0);
        instance.rooms.control(room, {action: 'play', revision: room.playback.revision});
        const revision = room.playback.revision;
        await page.locator('.playback-health[data-delivery="metal"]').waitFor({timeout: 12000});
        await decodedPlayback(page, youtube);
        assert.equal(room.playback.revision, revision, 'Local failover must not send shared playback controls.');
        assert.ok(room.current.id === youtube.id && !room.playback.paused);
        assert.match(await page.locator('.delivery-notice').textContent(), /Switched to metal/);
        await until(() => page.locator('.playback-health').textContent().then(text => /\d+\.\d+s buffered/.test(text)));
        for (const file of [/index\.m3u8$/, /segment-\d+\.ts$/]) {
          assert.ok(browserRequests.some(request => request.origin === directOrigin &&
            request.pathname.startsWith(`/direct/media/${job.id}/`) && file.test(request.pathname)));
        }
        t.diagnostic(`Chrome recovered automatically from ${fail ? 'failed' : 'stalled'} ${stalledFile} via metal and resumed decoded playback.`);
      } finally {
        await page.unroute(pattern);
        await Promise.all(pending.map(route => route.abort().catch(() => {})));
      }
    }

    instance.rooms.advance(room);
    assert.equal(room.current, null);
    await until(() => page.locator('video').evaluate(video => !video.getAttribute('src')));
    const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const viewer = await viewerContext.newPage();
    watch(viewer);
    await login(viewer, origin);
    await until(() => room.members.size === 2);
    const secondCookie = await sessionCookie(viewerContext, origin);
    assert.ok(firstCookie !== secondCookie, 'Two UI logins have distinct sessions.');
    assert.ok(browserSockets.length >= 2, 'Both browsers open real Worker WebSockets.');
    for (const socket of browserSockets) {
      assert.equal(socket.origin, origin.replace('http:', 'ws:'));
      assert.equal(socket.pathname, '/ws');
    }
    const segment = contents.split(/\r?\n/).find(line => /^segment-\d+\.ts$/.test(line));
    assert.ok(segment);
    const segmentPath = `/media/${job.id}/${segment}`;
    const authPath = `/api/edge/media/${job.id}/${segment}`;
    const count = pathname => backendRequests.filter(request => request.method === 'GET' && request.pathname === pathname).length;
    const requestSegment = cookie => fetch(origin + segmentPath, { headers: cookie ? { Cookie: cookie } : {},
      signal: AbortSignal.timeout(10000) });
    const priming = await requestSegment(firstCookie);
    assert.equal(priming.status, 200);
    const encrypted = Buffer.from(await priming.arrayBuffer());
    assert.deepEqual(encrypted, await readFile(path.join(job.dir, segment)));
    assert.equal(encrypted.length % 16, 0);
    await sleep(150);
    const originReads = count(segmentPath);
    const authorizations = count(authPath);
    assert.ok(originReads > 0, 'The real backend supplied the segment before it was cached.');
    for (const [index, cookie] of [firstCookie, secondCookie].entries()) {
      const response = await requestSegment(cookie);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('x-helltube-encrypted'), 'aes-128');
      assert.match(response.headers.get('cache-control'), /no-store/);
      assert.equal(response.headers.has('set-cookie'), false);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), encrypted);
      assert.equal(count(authPath), authorizations + index + 1, 'Every cache hit calls backend authorization.');
      assert.equal(count(segmentPath), originReads, 'Distinct sessions share the real Worker Cache API entry.');
    }
    t.diagnostic('Two distinct sessions hit the same warm Cache API entry: two authorization calls, zero segment-origin calls.');

    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    await page.getByRole('button', { name: 'Enter Helltube' }).waitFor();
    await until(() => room.members.size === 1);
    const revoked = await requestSegment(firstCookie);
    assert.equal(revoked.status, 401, 'Logout revokes access even when the segment is cached.');
    await revoked.arrayBuffer();
    assert.equal(count(authPath), authorizations + 3);
    assert.equal(count(segmentPath), originReads);
    const allowed = await requestSegment(secondCookie);
    assert.equal(allowed.status, 200, 'Logging out one session preserves the other viewer.');
    assert.deepEqual(Buffer.from(await allowed.arrayBuffer()), encrypted);
    assert.equal(count(authPath), authorizations + 4);
    assert.equal(count(segmentPath), originReads);
    await viewer.goto('about:blank');
    await until(() => room.members.size === 0);
    const me = await fetch(origin + '/api/me', { headers: { Cookie: secondCookie }, signal: AbortSignal.timeout(10000) });
    assert.equal(me.status, 200, 'The departed viewer still has a valid session.');
    await me.arrayBuffer();
    const departed = await requestSegment(secondCookie);
    assert.equal(departed.status, 403, 'Leaving the room denies a warm cached segment despite a valid session.');
    await departed.arrayBuffer();
    assert.equal(count(authPath), authorizations + 5);
    assert.equal(count(segmentPath), originReads);
    const anonymous = await requestSegment();
    assert.equal(anonymous.status, 401);
    await anonymous.arrayBuffer();
    assert.equal(count(authPath), authorizations + 6);
    assert.equal(count(segmentPath), originReads);

    await Promise.all(headerReads);
    for (const request of browserRequests.filter(request => request.pathname.startsWith('/direct/'))) {
      assert.equal(request.origin, directOrigin);
      assert.equal(request.hasCookie, false, 'All direct browser requests are cookie-free.');
    }
    for (const response of browserResponses.filter(response => response.origin === directOrigin && response.status === 200)) {
      assert.equal(response.allowOrigin, origin, 'The real browser receives the exact permitted CORS origin.');
      assert.notEqual(response.credentials, 'true');
      if (response.pathname.endsWith('/key.bin')) assert.match(response.cacheControl, /no-store/);
    }
    for (const request of browserRequests.filter(request => request.pathname.startsWith('/api/'))) assert.equal(request.origin, origin);
    assert.deepEqual(await context.cookies(directOrigin), [], 'No backend cookies are needed for direct delivery.');
    assert.deepEqual(await viewerContext.cookies(directOrigin), []);
    assert.equal(pageErrors, 0, 'Both real browser clients run without uncaught errors.');
    t.diagnostic('Warm cached ciphertext was denied after logout, room departure, and without a session; direct delivery used no backend cookies.');
  } catch (error) {
    t.diagnostic(JSON.stringify({ backendRequests: backendRequests.slice(-30), browserResponses: browserResponses.slice(-30), pageErrors }));
    throw error;
  } finally {
    try { await browser?.close(); }
    finally {
      try { await worker?.stop(); }
      finally {
        try { await instance?.close(); }
        finally { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
      }
    }
  }
});
