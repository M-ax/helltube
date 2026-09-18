import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { start, until } from './helpers.js';
import { createApp } from '../server/app.js';
import { targetPosition } from '../src/lib/format.js';
import { makeItem } from '../server/rooms.js';
import { create4kFixture } from './media-4k-fixture.js';
import { createSeekFixture } from './media-seek-fixture.js';
import { marshmallowPose } from '../src/lib/crt-marshmallow.js';
import { observeVideoRendering } from './player-rendering-helpers.js';

async function chooseQuality(page, value) {
  await page.getByRole('combobox', {name: 'Video quality on this device'}).click();
  await page.locator(`.quality-option[value="${value}"]`).click();
}

for (const codec of ['vp9', 'h264']) {
  test(`Original remains aligned across quality changes, far seeks and backend restarts (${codec})`, {timeout: 60000}, async t => {
    const context = await start(t);
    const {instance, url, dir} = context;
    const {resolved} = await createSeekFixture(t, context, codec, {hls: codec === 'h264'});
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.getByRole('button', {name: 'Your files', exact: true}).waitFor();
    let room = instance.rooms.get('lobby');
    await until(() => room.members.size);
    const item = makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw', startAt: 63.3}, {duration: 80, startAt: 63.3});
    instance.rooms.add(room, [item]);
    instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
    const select = page.locator('.quality-select');
    const aligned = async (qualityId, target, color) => {
      const quality = room.current.media?.qualities.find(quality => quality.id === qualityId);
      if (!quality || await select.getAttribute('value').catch(() => '') !== qualityId) return false;
      return page.locator('video').evaluate((video, expected) => {
        if (video.readyState < 2 || video.videoWidth !== expected.width ||
          Math.abs(video.currentTime + expected.baseTime - expected.target) > 0.15) return false;
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d');
        context.drawImage(video, 0, 0, 1, 1);
        const pixel = context.getImageData(0, 0, 1, 1).data;
        return pixel[expected.color] > 180 && pixel[(expected.color + 1) % 3] < 60 && pixel[(expected.color + 2) % 3] < 60;
      }, {width: qualityId === 'original' ? 1440 : 1280, baseTime: quality.baseTime, target, color});
    };
    await until(() => aligned('original', 63.3, 0), 15000);
    const firstJob = instance.media.jobs.get(item.id);
    assert.ok(firstJob.original.baseTime > 54);
    const revision = room.playback.revision;
    await chooseQuality(page, 'standard');
    await until(() => aligned('standard', 63.3, 0));
    await chooseQuality(page, 'original');
    await until(() => aligned('original', 63.3, 0));
    assert.equal(room.playback.revision, revision);
    instance.rooms.control(room, {action: 'seek', position: 15.3, revision: room.playback.revision});
    await until(() => aligned('original', 15.3, 2), 15000);
    assert.notEqual(instance.media.jobs.get(item.id), firstJob);
    assert.ok(instance.media.jobs.get(item.id).original.baseTime > 0);
    instance.rooms.control(room, {action: 'seek', position: 65.3, revision: room.playback.revision});
    await until(() => aligned('original', 65.3, 1), 15000);
    await instance.close();
    const restarted = await createApp({dataDir: dir, port: Number(new URL(url).port)});
    try {
      restarted.app.get(`/seek-${codec}/:file`, (req, res) => res.sendFile(req.params.file, {root: dir, dotfiles: 'allow'}));
      t.mock.method(restarted.youtube, 'resolve', async () => resolved);
      room = restarted.rooms.get('lobby');
      await restarted.listen();
      await until(() => aligned('original', 65.3, 1), 15000);
      assert.ok(restarted.media.jobs.get(item.id).original.baseTime > 55);
      await chooseQuality(page, 'standard');
      await until(() => aligned('standard', 65.3, 1));
      assert.deepEqual(errors, []);
    } finally { await restarted.close(); }
  });
}

test('4K VP9 survives startup buffering and sustained stalls fall back only for the affected viewer', {timeout: 90000}, async t => {
  const context = await start(t);
  const {instance, url} = context;
  await create4kFixture(t, context, {duration: 40});
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  const gate = Promise.withResolvers();
  t.after(async () => {gate.resolve(); await browser.close();});
  const pages = [await browser.newPage(), await browser.newPage()];
  const errors = [];
  let delayed = 0;
  await pages[0].route('**/media/*/segment-*.m4s', async route => {
    if (Number(/segment-(\d+)/.exec(route.request().url())[1]) >= 3) {
      delayed++;
      await gate.promise;
    }
    await route.continue().catch(() => {});
  });
  for (const page of pages) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.getByRole('button', {name: 'Your files', exact: true}).waitFor();
  }
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const item = makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw'}, {duration: 40});
  instance.rooms.add(room, [item]);
  instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
  await until(() => instance.media.jobs.get(item.id)?.done, 15000);
  const width = page => page.locator('video').evaluate(video => video.readyState >= 2 ? video.videoWidth : 0);
  await until(async () => (await Promise.all(pages.map(width))).every(width => width === 3840), 15000)
    .catch(async error => {t.diagnostic(await pages[0].locator('body').innerText()); throw error;});
  for (const page of pages) assert.equal(await page.getByRole('combobox', {name: 'Video quality on this device'}).getAttribute('value'), 'original');
  instance.rooms.control(room, {action: 'play', revision: room.playback.revision});
  const revision = room.playback.revision;
  await until(async () => {
    for (const page of pages) {
      const enable = page.getByRole('button', {name: 'Enable playback', exact: true});
      if (await enable.isVisible()) await enable.click();
    }
    return targetPosition(room) >= 9;
  }, 15000);
  const select = pages[0].getByRole('combobox', {name: 'Video quality on this device'});
  assert.equal(await select.getAttribute('value'), 'original', 'Startup buffering must not latch a Standard fallback.');
  await until(async () => await width(pages[0]) === 1280, 20000);
  assert.ok(delayed > 0, 'Original fragment delivery was starved.');
  assert.equal(room.playback.revision, revision);
  assert.equal(await width(pages[1]), 3840);
  assert.equal(await select.getAttribute('value'), 'standard');
  assert.match(await pages[0].locator('.delivery-notice').textContent(), /Buffer|Playback stalled/);
  assert.equal(room.playback.paused, false);
  gate.resolve();
  instance.rooms.control(room, {action: 'seek', position: 9, revision: room.playback.revision});
  await until(async () => pages[0].locator('video').evaluate(video => video.currentTime >= 9 && video.readyState >= 3));
  assert.equal(await select.getAttribute('value'), 'standard', 'Recovery and seeking do not automatically return to Original.');
  await pages[0].locator('.player-shell').focus();
  await chooseQuality(pages[0], 'original');
  await until(async () => await width(pages[0]) === 3840);
  assert.equal(await pages[0].locator('.delivery-notice').count(), 0);
  assert.deepEqual(errors, []);
});

test('quality selection switches encrypted renditions locally and keeps the shared clock', {timeout: 45000}, async t => {
  const {instance, url, dir} = await start(t);
  const sample = path.join(dir, 'quality.m3u8');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=1440x810:rate=30', '-t', '12', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', sample]);
  instance.app.get('/quality/:file', (req, res) => res.sendFile(req.params.file, {root: dir, dotfiles: 'allow'}));
  t.mock.method(instance.twitch, 'resolve', async () => ({duration: 12, copyQuality: {label: 'Original (810p)'},
    inputs: [{url: `${url}/quality/quality.m3u8`, headers: {}}]}));
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  t.after(() => browser.close());
  const pages = [await browser.newPage({viewport: {width: 1440, height: 1000}}), await browser.newPage()];
  const errors = [];
  for (const page of pages) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.getByRole('button', {name: 'Your files', exact: true}).waitFor();
  }
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const item = makeItem({kind: 'twitch', url: 'https://twitch.tv/videos/12345', startAt: 3}, {duration: 12, startAt: 3});
  instance.rooms.add(room, [item]);
  instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
  await until(() => instance.media.jobs.get(item.id)?.done, 15000);
  const revision = room.playback.revision;
  const target = instance.rooms.position(room);
  const quality = pages[0].getByRole('combobox', {name: 'Video quality on this device'});
  const aligned = async (page, width, baseTime) => page.locator('video').evaluate((video, expected) =>
    video.readyState >= 2 && video.videoWidth === expected.width &&
    Math.abs(video.currentTime + expected.baseTime - expected.target) < 0.3, {width, baseTime, target});
  await until(async () => (await Promise.all(pages.map(page => aligned(page, 1440, 0)))).every(Boolean));
  assert.equal(await quality.getAttribute('value'), 'original');
  await quality.press('ArrowDown');
  await quality.press('End');
  await quality.press('Escape');
  assert.equal(await quality.getAttribute('aria-expanded'), 'false');
  assert.equal(await quality.getAttribute('value'), 'original', 'Escape cancels without changing quality.');
  await quality.press('ArrowDown');
  await quality.press('End');
  await quality.press('Enter');
  assert.equal(await quality.getAttribute('aria-expanded'), 'false');
  await until(() => aligned(pages[0], 1280, 3));
  assert.equal(await pages[1].getByRole('combobox', {name: 'Video quality on this device'}).getAttribute('value'), 'original');
  assert.equal(await aligned(pages[1], 1440, 0), true);
  assert.equal(room.playback.revision, revision, 'Quality changes never send shared playback commands.');
  await quality.click();
  const menu = pages[0].getByRole('listbox', {name: 'Video quality', exact: true});
  assert.equal(await menu.getByRole('option', {selected: true}).getAttribute('value'), 'standard');
  assert.equal(await menu.evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(25, 25, 29)');
  await pages[0].screenshot({path: 'test-artifacts/quality-desktop.png'});
  await pages[0].locator('.now-playing h2').click();
  assert.equal(await quality.getAttribute('aria-expanded'), 'false', 'Clicking outside closes the menu.');
  await pages[0].setViewportSize({width: 375, height: 850});
  await chooseQuality(pages[0], 'original');
  await until(() => aligned(pages[0], 1440, 0));
  assert.ok(await quality.evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.right <= window.innerWidth;
  }));
  await quality.click();
  assert.ok(await menu.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const viewport = element.closest('.video-viewport').getBoundingClientRect();
    return rect.left >= viewport.left && rect.right <= viewport.right && rect.top >= viewport.top;
  }), 'The open menu fits inside the mobile player.');
  await pages[0].screenshot({path: 'test-artifacts/quality-mobile.png'});
  assert.deepEqual(errors, []);
});

test('deployment hashes show mismatch indicators and recover without reloading the frontend', { timeout: 30000 }, async t => {
  const version = JSON.parse(await readFile('dist/version.json', 'utf8'));
  assert.ok(version.commit);
  const differing = version.commit.slice(0, 7) + (version.commit[7] === 'a' ? 'b' : 'a').repeat(version.commit.length - 7);
  const { url } = await start(t, { backendCommit: differing });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
  await page.getByRole('button', { name: 'Enter Helltube' }).click();
  const label = page.locator('.deployment-label');
  const status = label.getByRole('status');
  await status.waitFor();
  assert.match(await label.textContent(), new RegExp(`Web ${version.commit.slice(0, 7)}`));
  assert.match(await label.textContent(), new RegExp(`Metal ${differing.slice(0, 7)}`));
  assert.equal(await label.locator('[title="Backend commit: ' + differing + '"]').count(), 1);
  assert.equal(await status.locator('svg').count(), 1);
  assert.equal(await status.locator('.spinner').evaluate(element => getComputedStyle(element).animationName), 'spin');
  await page.screenshot({ path: 'test-artifacts/deployment-mismatch.png' });
  await page.setViewportSize({ width: 375, height: 850 });
  await page.getByRole('button', { name: 'Open room navigation' }).click();
  assert.equal(await label.evaluate(element => element.scrollWidth <= element.clientWidth), true);
  await page.route('**/api/version', route => route.fulfill({ json: { commit: version.commit } }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await status.waitFor({ state: 'detached' });
  assert.equal(await label.locator('[title="Backend commit: ' + version.commit + '"]').count(), 1);
  await page.unroute('**/api/version');
  await page.route('**/api/version', route => route.fulfill({ json: { commit: null } }));
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(async () => (await label.textContent()).includes('Metal unknown'));
  assert.equal(await status.count(), 0);
  assert.deepEqual(errors, []);
});

test('CRT startup shows metadata, measured progress, failures, and yields to real video on desktop and mobile', { timeout: 45000 }, async t => {
  const { instance, url, dir } = await start(t, { maxTranscoders: 0 });
  instance.capabilities.youtube = true;
  const metadata = Promise.withResolvers();
  const source = Promise.withResolvers();
  t.after(() => { metadata.resolve(); source.resolve(); });
  const sample = path.join(dir, 'crt-fixture.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30', '-t', '12', '-c:v', 'libx264',
    '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sample]);
  instance.app.get('/crt-fixture.mp4', (_req, res) => res.sendFile(sample, { dotfiles: 'allow' }));
  t.mock.method(instance.youtube, 'items', async () => {
    await metadata.promise;
    return [makeItem({kind: 'youtube', url: 'https://youtu.be/jNQXAC9IVRw'}, {title: 'CRT playback fixture', duration: 12})];
  });
  t.mock.method(instance.youtube, 'resolve', async () => {
    await source.promise;
    return {duration: 12, inputs: [{url: `${url}/crt-fixture.mp4`, headers: {}}]};
  });
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Username', {exact: true}).fill('admin');
  await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
  await page.getByRole('button', {name: 'Enter Helltube'}).click();
  await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
  await page.getByRole('heading', {name: 'NO SIGNAL'}).waitFor();
  const flameFrame = () => page.locator('.video-canvas').evaluate(canvas => {
    // Force a draw before reading a WebGL buffer that is discarded after compositing.
    window.dispatchEvent(new Event('resize'));
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    let hash = 0;
    let orange = 0;
    let highest = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      hash = (Math.imul(hash, 31) + pixels[i] + pixels[i + 1] + pixels[i + 3]) | 0;
      if (pixels[i + 3] > 15) {
        highest = Math.floor(i / 4 / canvas.width);
        if (pixels[i] > pixels[i + 1] * 1.3 && pixels[i + 1] > pixels[i + 2] * 2) orange++;
      }
    }
    const bounds = canvas.getBoundingClientRect();
    const seek = document.querySelector('.seek-track').getBoundingClientRect();
    return {hash, orange, top: bounds.bottom - highest * bounds.height / canvas.height,
      seek: seek.top + seek.height / 2, error: gl.getError()};
  });
  const initialFlames = await flameFrame();
  assert.ok(initialFlames.orange > 100, 'The existing WebGL canvas draws orange flames before video loads.');
  assert.equal(initialFlames.error, 0);
  assert.ok(initialFlames.top >= initialFlames.seek - 42, 'Flames stay in a shallow band above the seek bar.');
  await until(async () => (await flameFrame()).hash !== initialFlames.hash);
  // Exercise the actual linked shader at desktop/4K distances. Merely checking
  // for orange pixels misses collapsed flame noise and a missing long stick.
  for (const width of [1560, 3840]) {
    const height = 256;
    const poses = [1, -1].map(side => marshmallowPose({
      side, burns: false, reach: 0.26, time: 3, duration: 14,
    }, width, height, 71));
    const precision = await page.locator('.video-canvas').evaluate((canvas, {width, height, poses}) => {
      window.dispatchEvent(new Event('resize'));
      const gl = canvas.getContext('webgl');
      const program = gl.getParameter(gl.CURRENT_PROGRAM);
      const uniform = name => gl.getUniformLocation(program, name);
      gl.uniformMatrix4fv(uniform('u_projection'), false, new Float32Array([
        2 / width, 0, 0, 0, 0, -2 / height, 0, 0, 0, 0, -1, 0, -1, 1, 0, 1,
      ]));
      gl.uniform4f(uniform('u_rect'), 0, 0, width, height);
      gl.uniform1f(uniform('u_rotation'), 0);
      gl.uniform1f(uniform('u_flameTime'), 9.4);
      gl.uniform1f(uniform('u_effect'), 1);
      gl.uniform2f(uniform('u_flameSize'), width, 95);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      const row = new Uint8Array(canvas.width * 4);
      gl.readPixels(0, Math.floor(canvas.height / 2), canvas.width, 1, gl.RGBA, gl.UNSIGNED_BYTE, row);
      let flames = 0;
      for (let i = 3; i < row.length; i += 4) if (row[i] > 30) flames++;

      gl.uniform1f(uniform('u_effect'), 2);
      gl.uniform2f(uniform('u_flameSize'), width, height);
      gl.uniform4f(uniform('u_toasting'), 0, 0, 0, 0);
      const sticks = poses.map(mallow => {
        gl.uniform4f(uniform('u_marshmallow'), mallow.x, mallow.y, mallow.size, mallow.angle);
        gl.uniform4f(uniform('u_stick'), mallow.side, mallow.shaft, 0, 0);
        gl.uniform4f(uniform('u_breathPath'), mallow.breathOriginX, mallow.breathOriginY,
          mallow.breathTargetX, mallow.breathTargetY);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        const covered = (x, y) => {
          const px = Math.floor(x / width * canvas.width);
          const py = Math.floor((1 - y / height) * canvas.height);
          // Allow for the deliberately pixelated outline and raster rounding.
          const radius = Math.ceil(3 * canvas.height / height);
          for (let dy = -radius; dy <= radius; dy++) {
            if (pixels[((py + dy) * canvas.width + px) * 4 + 3] > 200) return true;
          }
          return false;
        };
        const shaft = [0.2, 0.4, 0.6, 0.8].map(fraction => covered(
          mallow.x - mallow.side * mallow.shaft * Math.cos(mallow.angle) * fraction,
          mallow.y - mallow.side * mallow.shaft * Math.sin(mallow.angle) * fraction));
        return {body: covered(mallow.x, mallow.y), shaft};
      });
      const error = gl.getError();
      // Restore the renderer's own viewport and uniforms before its next frame.
      window.dispatchEvent(new Event('resize'));
      return {flameCoverage: flames / canvas.width, sticks, error};
    }, {width, height, poses});
    assert.equal(precision.error, 0);
    assert.ok(precision.flameCoverage > 0.55, `Flame noise retains detail at ${width}px: ${JSON.stringify(precision)}`);
    for (const stick of precision.sticks) {
      assert.ok(stick.body && stick.shaft.every(Boolean),
        `The marshmallow stays attached to a continuous stick at ${width}px: ${JSON.stringify(stick)}`);
    }
  }
  await page.emulateMedia({reducedMotion: 'reduce'});
  const stillFlames = await flameFrame();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal((await flameFrame()).hash, stillFlames.hash, 'Reduced motion keeps a static flame frame.');
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.locator('.video-canvas').evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    canvas.addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 100), {once: true});
    extension.loseContext();
  });
  await until(async () => (await flameFrame()).orange > 100);
  const viewport = page.locator('.video-viewport');
  const assertWidescreen = async () => {
    const bounds = await viewport.boundingBox();
    assert.ok(Math.abs(bounds.height - bounds.width * 9 / 16) < 1, `Player should stay 16:9: ${JSON.stringify(bounds)}`);
  };
  await assertWidescreen();
  await page.setViewportSize({width: 375, height: 850});
  await assertWidescreen();
  const mobileFlames = await flameFrame();
  assert.ok(mobileFlames.orange > 20 && mobileFlames.top >= mobileFlames.seek - 42,
    'Mobile flames track the wrapped controls without covering the terminal.');
  const addButton = page.getByRole('button', {name: 'Add something good'});
  assert.equal(await addButton.evaluate(button => {
    const bounds = button.getBoundingClientRect();
    const controls = document.querySelector('.player-controls').getBoundingClientRect();
    const screen = document.querySelector('.crt-screen').getBoundingClientRect();
    return bounds.top >= screen.top && bounds.bottom <= controls.top;
  }), true, 'The compact idle action stays above the controls.');
  await page.screenshot({path: 'test-artifacts/crt-idle-mobile.png'});
  await page.setViewportSize({width: 1440, height: 1000});
  await page.getByRole('button', {name: 'Add something good'}).click();
  assert.equal(await page.locator('#youtube-url').evaluate(input => input === document.activeElement), true);
  await page.locator('#youtube-url').fill('https://youtu.be/jNQXAC9IVRw');
  await page.getByRole('button', {name: 'Add to queue', exact: true}).click();
  await page.getByRole('heading', {name: 'BOOTING STREAM'}).waitFor();
  await page.locator('.crt-running').filter({hasText: 'Fetching source metadata'}).waitFor();
  metadata.resolve();
  const room = instance.rooms.get('lobby');
  await until(() => room.current);
  room.resumeWhenReady = false;
  room.current.preparation = {stage: 'transcoding', seconds: 3, baseTime: 0};
  room.current.uploadProgress = {received: 512, total: 1024, complete: false};
  instance.rooms.emit('state', room);
  const progress = page.getByRole('progressbar', {name: 'FFmpeg transcoding', exact: true});
  await until(async () => await progress.getAttribute('aria-valuenow') === '25');
  assert.equal(await page.getByRole('progressbar', {name: 'Receiving video upload'}).getAttribute('aria-valuenow'), '50');
  await page.setViewportSize({width: 375, height: 850});
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.crt-screen').evaluate(screen => screen.scrollWidth <= screen.clientWidth), true);
  await assertWidescreen();
  await page.emulateMedia({reducedMotion: 'reduce'});
  assert.equal(await page.locator('.crt-sweep').evaluate(sweep => getComputedStyle(sweep).display), 'none');
  room.current.status = 'error';
  room.current.error = 'Fixture conversion failed';
  instance.rooms.emit('state', room);
  await page.getByRole('heading', {name: 'SIGNAL FAILED'}).waitFor();
  await page.locator('.crt-error').filter({hasText: 'Fixture conversion failed'}).waitFor();
  assert.equal(await page.locator('.crt-running').count(), 0);
  await page.emulateMedia({reducedMotion: 'no-preference'});
  await page.evaluate(() => {
    const screen = document.querySelector('.crt-screen');
    const viewport = document.querySelector('.video-viewport');
    window.crtExit = {frames: [], started: false, ended: false, height: viewport.clientHeight};
    screen.addEventListener('outrostart', () => {
      window.crtExit.started = true;
      function sample() {
        if (!screen.isConnected) return;
        const style = getComputedStyle(screen);
        const transform = new DOMMatrixReadOnly(style.transform);
        window.crtExit.frames.push({opacity: Number(style.opacity), x: transform.a, y: transform.d,
          height: viewport.clientHeight, frameReady: document.querySelector('video').readyState >= 2});
        requestAnimationFrame(sample);
      }
      requestAnimationFrame(sample);
    });
    screen.addEventListener('outroend', () => window.crtExit.ended = true);
  });
  room.current.status = 'queued';
  room.current.error = null;
  room.current.uploadProgress = null;
  instance.media.config.maxTranscoders = 1;
  instance.media.schedule();
  await until(() => room.current.preparation?.stage === 'metadata');
  source.resolve();
  await until(() => room.current.media?.complete, 15000);
  assert.ok(room.current.preparation.seconds > 0, 'Real FFmpeg stdout produces progress.');
  await page.locator('.crt-screen').waitFor({state: 'detached'});
  assert.equal(await page.locator('.video-canvas.crt-flames').count(), 0, 'Flames leave when the decoded video appears.');
  const exit = await page.evaluate(() => window.crtExit);
  assert.equal(exit.started && exit.ended, true, 'The CRT runs its exit before it is removed.');
  assert.ok(exit.frames.some(frame => frame.opacity > 0 && frame.opacity < .9), 'The overlay becomes transparent over the video.');
  assert.ok(exit.frames.some(frame => frame.y < .1 && frame.x > .8), 'The screen collapses to a horizontal line first.');
  assert.ok(exit.frames.some(frame => frame.x < .7), 'The line rapidly contracts before disappearing.');
  assert.ok(exit.frames.every(frame => frame.frameReady && frame.height === exit.height), 'Decoded video is underneath throughout, without resizing.');
  await assertWidescreen();
  assert.ok(await page.locator('video').first().evaluate(video => video.readyState >= 2));
  assert.equal(room.playback.paused, true, 'A paused video still shows its decoded frame.');
  await page.emulateMedia({reducedMotion: 'reduce'});
  await page.addInitScript(() => {
    window.reducedCrtExit = {started: false, ended: false, frames: 0};
    let frame;
    document.addEventListener('outrostart', event => {
      if (!event.target.matches('.crt-screen')) return;
      window.reducedCrtExit.started = true;
      frame = requestAnimationFrame(() => window.reducedCrtExit.frames++);
    }, true);
    document.addEventListener('outroend', event => {
      if (!event.target.matches('.crt-screen')) return;
      cancelAnimationFrame(frame);
      window.reducedCrtExit.ended = true;
    }, true);
  });
  await page.reload();
  await until(() => page.evaluate(() => window.reducedCrtExit?.ended));
  assert.deepEqual(await page.evaluate(() => window.reducedCrtExit), {started: true, ended: true, frames: 0},
    'Reduced motion reveals video immediately without a collapse or flash.');
  assert.deepEqual(errors, []);
});

test('SponsorBlock fetches post-ad HLS first and skips a long sponsor window for two viewers', { timeout: 60000 }, async t => {
  const { instance, url, dir, api } = await start(t, { youtubeProxy: '' });
  const sample = path.join(dir, 'sponsor-fixture.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '64', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-movflags', '+faststart', sample]);
  instance.app.get('/sponsor-fixture.mp4', (_req, res) => res.sendFile(sample, { dotfiles: 'allow' }));
  instance.capabilities.youtube = true;
  t.mock.method(instance.youtube, 'extract', async () => ({ id: 'jNQXAC9IVRw', title: 'Sponsor fixture',
    duration: 64, url: 'https://fixture.googlevideo.com/video' }));
  let lookups = 0;
  instance.youtube.sponsorBlock.fetch = async () => {
    lookups++;
    return Response.json([{ videoID: 'jNQXAC9IVRw', segments: [
      { category: 'sponsor', actionType: 'skip', segment: [6.5, 48.5], videoDuration: 64 },
    ] }]);
  };
  const resolve = instance.youtube.resolve.bind(instance.youtube);
  t.mock.method(instance.youtube, 'resolve', async value => ({ ...await resolve(value),
    inputs: [{ url: `${url}/sponsor-fixture.mp4`, headers: {} }] }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const pages = [await browser.newPage(), await browser.newPage()];
  const requests = pages.map(() => []);
  const errors = [];
  for (const [index, page] of pages.entries()) {
    // Exercise a growing EVENT playlist whose first response ends inside the ad.
    let firstPlaylist = true;
    await page.route('**/media/*/index.m3u8', async route => {
      if (!firstPlaylist) return route.continue();
      firstPlaylist = false;
      await until(() => instance.rooms.get('lobby').current?.media?.complete, 15000);
      const response = await route.fetch();
      const text = await response.text();
      const last = 'segment-000012.ts\n';
      await route.fulfill({ response, body: text.slice(0, text.indexOf(last) + last.length) });
    });
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
      const match = /segment-(\d+)\.ts/.exec(request.url());
      if (match) requests[index].push(Number(match[1]));
    });
    await page.goto(url);
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await page.getByRole('button', { name: 'Enter Helltube' }).click();
    await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
    await page.getByRole('button', { name: 'Your files', exact: true }).waitFor();
  }
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  assert.equal((await api('/api/rooms/lobby/youtube', { method: 'POST', body: {
    url: 'https://youtu.be/jNQXAC9IVRw?t=2',
  } })).status, 201);
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  await until(() => {
    assert.notEqual(room.current?.status, 'error', room.current?.error);
    return room.current?.media?.complete;
  }, 20000);
  const media = room.current.media;
  assert.equal(media.baseTime, 2);
  assert.deepEqual(room.current.sponsorSegments, [[6.5, 48.5]]);
  assert.equal(lookups, 1, 'One server lookup serves both viewers.');
  await until(() => requests.every(list => list.includes(23)), 15000).catch(async error => {
    t.diagnostic(JSON.stringify({ requests, errors, media, playback: room.playback,
      players: await Promise.all(pages.map(page => page.locator('video').first().evaluate(video => ({
        time: video.currentTime, ready: video.readyState, paused: video.paused,
        buffered: Array.from({ length: video.buffered.length }, (_, i) => [video.buffered.start(i), video.buffered.end(i)]),
        error: video.error?.message,
      })))),
    }));
    throw error;
  });
  assert.equal(room.playback.paused, true, 'Post-ad data is prefetched before playback reaches the ad.');
  for (const list of requests) {
    assert.ok(list.includes(2), 'The leading boundary fragment contains ordinary content.');
    assert.ok(!list.some(sn => sn >= 3 && sn <= 22), `Wholly blocked fragments were requested: ${list}`);
  }
  for (const page of pages) await page.getByRole('link', { name: 'SponsorBlock', exact: true }).waitFor();
  instance.rooms.control(room, { action: 'seek', position: 6, revision: room.playback.revision });
  instance.rooms.control(room, { action: 'play', revision: room.playback.revision });
  await until(async () => {
    const positions = await Promise.all(pages.map(page => page.locator('video').first().evaluate(video =>
      ({ position: video.currentTime + 2, paused: video.paused, ready: video.readyState }))));
    return positions.every(value => !value.paused && value.ready >= 3 && value.position >= 48.5 &&
      Math.abs(value.position - instance.rooms.position(room)) < 0.8);
  }, 10000);
  assert.equal(room.current.media.url, media.url, 'Skipping already generated content keeps the shared HLS job.');
  assert.ok(instance.rooms.position(room) < 58, 'Playback did not wait out the sponsor window.');
  for (const list of requests) assert.ok(!list.some(sn => sn >= 3 && sn <= 22));

  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  assert.equal((await api('/api/rooms/lobby/youtube', { method: 'POST', body: {
    url: 'https://youtu.be/jNQXAC9IVRw?t=7',
  } })).status, 201);
  await until(() => room.queue[0]?.media?.complete, 15000);
  const next = room.queue[0];
  assert.equal(next.media.baseTime, 48.5, 'Preparation starts after an ad containing the chosen start.');
  const nextUrl = next.media.url;
  instance.rooms.control(room, { action: 'skip', revision: room.playback.revision });
  await until(async () => (await Promise.all(pages.map(page => page.locator('video').first().evaluate(video =>
    video.readyState >= 3 && !video.paused && video.currentTime < 5)))).every(Boolean), 10000);
  assert.equal(room.current.id, next.id);
  assert.equal(room.current.media.url, nextUrl, 'Queue advancement retains the prepared post-ad job.');
  assert.equal(lookups, 1, 'Reusing a video also reuses the SponsorBlock cache.');
  assert.deepEqual(errors, []);
});

test('uploads survive a metal restart without reselecting files and defer frontend deployment reloads', { timeout: 60000 }, async t => {
  let restarted;
  let browser;
  const allowResume = Promise.withResolvers();
  t.after(async () => { allowResume.resolve(); await browser?.close(); await restarted?.close(); });
  const { instance, url, dir } = await start(t, { maxTranscoders: 0 });
  instance.media.config.bareMetalOrigin = url;
  const sample = path.join(dir, 'restart-upload.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-t', '15',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sample]);
  const original = await readFile(sample);
  assert.ok(original.length > 524288 * 2);
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const version = JSON.parse(await readFile(path.resolve('dist/version.json'), 'utf8'));
  let newDeployment = false;
  let versionChecks = 0;
  let navigations = 0;
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
  await page.route('**/version.json?*', route => {
    versionChecks++;
    return route.fulfill({ json: { buildId: newDeployment ? '22222222-2222-4222-8222-222222222222' : version.buildId } });
  });
  let saved;
  let interrupted = false;
  const offsets = [];
  await page.route('**/direct/uploads/**', async route => {
    if (route.request().method() !== 'PUT') return route.continue();
    offsets.push(Number(new URL(route.request().url()).searchParams.get('offset')));
    if (!interrupted) {
      interrupted = true;
      const response = await route.fetch();
      assert.equal(response.status(), 200);
      saved = await response.json();
      return route.abort('failed'); // The backend saved the chunk, but deployment lost its response.
    }
    await allowResume.promise;
    await route.continue();
  });
  await page.goto(url);
  await page.getByLabel('Username', { exact: true }).fill('admin');
  await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
  await page.getByRole('button', { name: 'Enter Helltube' }).click();
  await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
  await page.getByRole('button', { name: 'Your files', exact: true }).click();
  await page.getByLabel('Select a local video to upload', { exact: true }).setInputFiles(sample);
  await until(() => saved, 10000);
  assert.equal(saved.received, 524288);
  const uploadId = instance.rooms.get('lobby').current.source.uploadId;
  await instance.close();
  await page.getByText('Reconnecting automatically', { exact: false }).waitFor();
  const before = versionChecks;
  newDeployment = true;
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => versionChecks > before);
  assert.equal(navigations, 1, 'A changed frontend must not discard the selected upload file.');
  restarted = await createApp({ dataDir: dir, port: 0, maxTranscoders: 0, bareMetalOrigin: url });
  await restarted.listen(Number(new URL(url).port));
  assert.equal(restarted.uploads.get(uploadId).received, saved.received);
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await until(() => offsets.length > 1, 10000).catch(async error => {
    t.diagnostic(await page.locator('.uploads-panel').innerText());
    t.diagnostic(JSON.stringify({ navigations, errors, received: restarted.uploads.get(uploadId).received }));
    throw error;
  });
  assert.deepEqual(offsets, [0, saved.received], 'Recovery rechecks the durable offset before the next PUT.');
  assert.equal(navigations, 1);
  allowResume.resolve();
  await page.getByText('Upload complete', { exact: false }).waitFor();
  const upload = restarted.uploads.get(uploadId);
  assert.equal(upload.complete, true);
  assert.deepEqual(await readFile(upload.file), original, 'No duplicate or missing bytes after restart.');
  assert.equal(restarted.rooms.get('lobby').queue.length, 0, 'Recovery must not create another queue entry.');
  const reloaded = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
  await page.evaluate(() => window.dispatchEvent(new Event('online')));
  await reloaded;
  newDeployment = false;
  assert.equal(navigations, 2, 'The deferred deployment reload runs after the upload finishes.');
  assert.deepEqual(errors, []);
});

async function assertNativeVideo(page) {
  await until(async () => await page.locator('video').evaluate(video => !video.seeking && video.readyState >= 2));
  await page.locator('.video-viewport[data-renderer="native"][data-effects-renderer="webgl"]').waitFor();
  const result = await page.locator('.video-canvas').evaluate(canvas => {
    const video = document.querySelector('video');
    video.dispatchEvent(new Event('seeked'));
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const shell = document.querySelector('.player-shell').getBoundingClientRect();
    const bounds = canvas.getBoundingClientRect();
    const videoBounds = video.getBoundingClientRect();
    return { error: gl.getError(), transparent: pixels.every(value => value === 0),
      contained: bounds.left >= shell.left && bounds.right <= shell.right,
      aligned: ['x', 'y', 'width', 'height'].every(key => bounds[key] === videoBounds[key]),
      bounds: { width: bounds.width, shellWidth: shell.width },
      videoOpacity: getComputedStyle(video).opacity, canvasOpacity: getComputedStyle(canvas).opacity,
      background: getComputedStyle(canvas).backgroundColor, fit: getComputedStyle(video).objectFit,
      uploads: window.videoTextureUploads, requests: window.videoFrameRequests,
      width: canvas.width, expectedWidth: Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)) };
  });
  assert.equal(result.error, 0, 'WebGL draws without GPU errors.');
  assert.equal(result.transparent, true, 'Without effects every canvas pixel is transparent.');
  assert.equal(result.background, 'rgba(0, 0, 0, 0)', 'The CSS canvas background must also be transparent.');
  assert.equal(result.videoOpacity, '1', 'The native video remains visible under WebGL.');
  assert.equal(result.canvasOpacity, '1');
  assert.equal(result.fit, 'contain', 'Native video preserves aspect ratio and letterboxing.');
  assert.equal(result.aligned, true, 'Effects cover the native video viewport exactly.');
  assert.equal(result.uploads, 0, 'Playback never uploads video frames into WebGL.');
  assert.equal(result.requests, 0, 'Playback never schedules video-frame callbacks.');
  assert.equal(result.width, result.expectedWidth, 'Canvas resolution follows layout and device pixel ratio.');
  assert.equal(result.contained, true, `The canvas must not be cropped by its player shell: ${JSON.stringify(result.bounds)}`);
}

async function assertJoystickLayout(page) {
  const bounds = await page.locator('.seek-joystick').evaluate(element => {
    const track = element.querySelector('.joystick-track').getBoundingClientRect();
    const label = element.querySelector('.joystick-offset').getBoundingClientRect();
    const play = document.querySelector('.play-button').getBoundingClientRect();
    return { labelRight: label.left >= track.right, labelDelta: label.top + label.height / 2 - track.top - track.height / 2,
      playDelta: play.top + play.height / 2 - track.top - track.height / 2 };
  });
  assert.equal(bounds.labelRight, true, 'Seek offset belongs to the right of the track.');
  assert.ok(Math.abs(bounds.labelDelta) < 1 && Math.abs(bounds.playDelta) < 1, 'Joystick aligns vertically with timing and playback controls.');
}

async function canvasSamples(page) {
  return page.locator('.video-canvas').evaluate(canvas => {
    const video = document.querySelector('video');
    video.dispatchEvent(new Event('seeked'));
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const reference = document.createElement('canvas');
    reference.width = canvas.width;
    reference.height = canvas.height;
    const context = reference.getContext('2d');
    context.fillStyle = 'rgb(5, 5, 6)';
    context.fillRect(0, 0, canvas.width, canvas.height);
    const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
    const width = video.videoWidth * scale;
    const height = video.videoHeight * scale;
    context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
    const native = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const samples = [];
    for (let y = 10; y < canvas.height; y += 31) {
      for (let x = 10; x < canvas.width; x += 31) {
        const index = ((canvas.height - y - 1) * canvas.width + x) * 4;
        const nativeIndex = (y * canvas.width + x) * 4;
        // WebGL's drawing buffer contains premultiplied RGB. Compose it over
        // the native frame just as the browser does, preserving the old visual checks.
        for (let channel = 0; channel < 3; channel++) {
          samples.push(Math.round(pixels[index + channel] + native[nativeIndex + channel] * (1 - pixels[index + 3] / 255)));
        }
      }
    }
    return samples;
  });
}

test('local videos can be dropped or multi-selected as shared named playlists', { timeout: 90000 }, async t => {
  const { instance, url, dir } = await start(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const viewer = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  for (const client of [page, viewer]) {
    client.setDefaultTimeout(10000);
    client.on('pageerror', error => errors.push(error.message));
    await client.goto(url);
    await client.getByLabel('Username', { exact: true }).fill('admin');
    await client.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await client.getByRole('button', { name: 'Enter Helltube' }).click();
    await client.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
    await client.getByRole('button', { name: 'Your files', exact: true }).waitFor();
  }
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const sample = path.join(dir, 'batch-sample.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=44100',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', sample]);
  const buffer = await readFile(sample);
  const names = ['Night Walk - 01.mp4', 'Night Walk - 02.mov', 'Night Walk - 03.m4v'];
  const posted = [];
  page.on('request', request => {
    if (request.method() === 'POST' && request.url().includes('/uploads')) posted.push(request);
  });
  const transfer = async entries => page.evaluateHandle(entries => {
    const data = new DataTransfer();
    for (const entry of entries) data.items.add(new File([Uint8Array.from(atob(entry.base64), c => c.charCodeAt(0))], entry.name,
      { type: entry.type, lastModified: 123 }));
    return data;
  }, entries);
  const videoEntries = names.map(name => ({ name, type: 'video/mp4', base64: buffer.toString('base64') }));
  const dropped = await transfer(videoEntries);
  const source = page.getByRole('button', { name: 'Your files', exact: true });
  assert.equal(await source.getAttribute('aria-pressed'), 'false');
  const idleClass = await source.getAttribute('class');
  await source.dispatchEvent('dragenter', { dataTransfer: dropped });
  assert.notEqual(await source.getAttribute('class'), idleClass, 'File drags highlight Your files even from the YouTube tab.');
  await source.dispatchEvent('dragover', { dataTransfer: dropped });
  await source.dispatchEvent('drop', { dataTransfer: dropped });
  await dropped.dispose();
  await until(() => room.current && room.queue.length === 2);
  assert.deepEqual([room.current, ...room.queue].map(item => item.title), names);
  assert.equal(room.current.playlistTitle, 'Night Walk');
  assert.equal(posted.length, 1);
  assert.ok(posted[0].url().endsWith('/uploads/batch'));
  await viewer.locator('.playlist-heading strong', { hasText: 'Night Walk' }).waitFor();
  await until(() => room.current.media?.bufferedUntil >= 4 && room.queue[0].media?.bufferedUntil >= 4, 20000);
  instance.rooms.control(room, { action: 'pause', revision: room.playback.revision });
  await until(async () => page.locator('.video-viewport video').evaluate(video => video.readyState >= 2));
  const first = room.current;
  const last = instance.uploads.get(room.queue[1].source.uploadId);
  assert.equal(last.received, 0, 'Later playlist files wait for their turn rather than flooding the server.');
  const picker = page.getByLabel('Select a local video to upload', { exact: true });
  assert.equal(await picker.getAttribute('multiple'), '');
  await page.locator('#insert-position').selectOption('0');
  await picker.setInputFiles([
    { name: '01 - Park Day.mp4', mimeType: 'video/mp4', buffer },
    { name: '02 - Park Day.mov', mimeType: 'video/mp4', buffer },
  ]);
  await until(() => room.queue.length === 4);
  assert.deepEqual(room.queue.slice(0, 2).map(item => item.title), ['01 - Park Day.mp4', '02 - Park Day.mov']);
  assert.equal(room.queue[0].playlistTitle, 'Park Day');
  assert.equal(posted.length, 2, 'Multi-select creates one request, not one submission per file.');
  await page.getByRole('button', { name: 'Choose videos', exact: true }).waitFor();
  const invalid = await transfer([videoEntries[0], { name: 'notes.txt', type: 'text/plain', base64: 'bm90ZXM=' }]);
  await page.locator('.upload-dropzone').dispatchEvent('drop', { dataTransfer: invalid });
  await invalid.dispose();
  await page.locator('.composer .form-error').waitFor();
  assert.match(await page.locator('.composer .form-error').innerText(), /video|notes\.txt/i);
  assert.equal(posted.length, 2, 'A mixed non-video drop is rejected without partial additions.');
  assert.equal(room.queue.length, 4);
  const single = await transfer([{ ...videoEntries[0], name: 'Standalone.mp4' }]);
  await page.locator('.upload-dropzone strong').dispatchEvent('drop', { dataTransfer: single });
  await single.dispose();
  await until(() => room.queue.length === 5);
  assert.equal(posted.length, 3, 'A drop on a child of the dropzone uploads exactly once.');
  assert.equal(room.queue.find(item => item.title === 'Standalone.mp4').playlistId, null);
  await viewer.getByRole('button', { name: 'Remove all queued videos from Night Walk', exact: true }).click();
  await until(() => room.queue.length === 3);
  assert.equal(room.current.id, first.id);
  assert.ok(room.queue.every(item => item.playlistId !== first.playlistId));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('.composer').scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'test-artifacts/upload-playlist-mobile.png', fullPage: true });
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `No overflow at ${width}px.`);
  }
  assert.deepEqual(errors, []);
  t.diagnostic('Dropped and picked playlists retained order, inferred names, prepared current/next media, shared group removal, and fit mobile.');
});

test('two Chrome users upload, watch in sync, pause, seek, reconnect and manage accounts', { timeout: 120000 }, async t => {
  const { instance, url, dir } = await start(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const errors = [];
  const adminContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const viewerContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 2 });
  const admin = await adminContext.newPage();
  const viewer = await viewerContext.newPage();
  for (const page of [admin, viewer]) {
    await page.addInitScript(observeVideoRendering);
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' && message.text().includes('Content Security Policy')) errors.push(message.text());
    });
  }
  const login = async (page, username, password) => {
    await page.goto(url);
    await page.getByLabel('Username', { exact: true }).fill(username);
    await page.getByLabel('Password', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Enter Helltube' }).click();
    await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
    await page.getByRole('region', { name: 'Synchronized room player' }).waitFor();
  };
  await login(admin, 'admin', 'garbageTime_');
  assert.equal(await admin.getByRole('slider', { name: 'Relative seek joystick' }).isDisabled(), true);
  await admin.getByRole('button', { name: 'Manage users', exact: true }).click();
  await admin.getByRole('button', { name: 'Create user', exact: true }).click();
  await admin.getByLabel('Username', { exact: true }).fill('watcher');
  await admin.getByLabel('Display name', { exact: true }).fill('Second viewer');
  await admin.getByLabel('Password', { exact: true }).fill('watcher-password');
  await admin.getByRole('button', { name: 'Create account', exact: true }).click();
  await admin.getByRole('button', { name: 'Edit watcher', exact: true }).waitFor();
  await admin.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await login(viewer, 'watcher', 'watcher-password');
  assert.equal(await viewer.getByRole('button', { name: 'Manage users', exact: true }).count(), 0);
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const sample = path.join(dir, 'browser-sample.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', sample]);
  await admin.getByRole('button', { name: 'Your files', exact: true }).click();
  await admin.getByLabel('Select a local video to upload', { exact: true }).setInputFiles(sample);
  const playing = async page => {
    const enable = page.getByRole('button', { name: 'Enable playback', exact: true });
    if (await enable.isVisible()) await enable.click();
    return page.locator('video').evaluate(video => !video.paused && video.currentTime > 1 && video.videoWidth > 0);
  };
  await until(async () => {
    assert.notEqual(room.current?.status, 'error', room.current?.error);
    return await playing(admin) && await playing(viewer);
  }, 35000).catch(async error => {
    t.diagnostic((await admin.locator('body').innerText()).slice(-5000));
    t.diagnostic(JSON.stringify(errors));
    throw error;
  });
  const positions = await Promise.all([admin, viewer].map(page => page.locator('video').evaluate(video => video.currentTime)));
  assert.ok(Math.abs(positions[0] - positions[1]) < 1, `Two-viewer drift: ${positions}`);
  t.diagnostic(`Two real Chrome players decoded video with ${Math.abs(positions[0] - positions[1]).toFixed(3)}s drift.`);
  await viewer.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await until(async () => room.playback.paused && await admin.locator('video').evaluate(v => v.paused));
  await until(() => room.current.media?.complete, 20000);
  await until(async () => await viewer.locator('video').evaluate(video => video.paused && !video.seeking));
  await assertNativeVideo(admin);
  await assertNativeVideo(viewer);
  await assertJoystickLayout(viewer);
  await viewer.getByRole('button', { name: 'Toggle fullscreen' }).click();
  await until(async () => await viewer.evaluate(() => !!document.fullscreenElement));
  await assertNativeVideo(viewer);
  await viewer.getByRole('button', { name: 'Toggle fullscreen' }).click();
  await until(async () => await viewer.evaluate(() => !document.fullscreenElement));
  await viewer.locator('.video-canvas').evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    window.restoreTestContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await viewer.locator('.video-viewport[data-effects-renderer="2d"]').waitFor();
  assert.equal(await viewer.locator('video').evaluate(video => getComputedStyle(video).opacity), '1');
  await viewer.evaluate(() => { window.restoreTestContext(); delete window.restoreTestContext; });
  await assertNativeVideo(viewer);
  await viewer.getByRole('slider', { name: 'Seek shared video', exact: true }).evaluate(slider => {
    slider.value = '12';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(async () => Math.abs(room.playback.position - 12) < 0.1 &&
    await admin.locator('video').evaluate(v => Math.abs(v.currentTime - 12) < 0.4));
  await assertNativeVideo(admin);
  const joystick = viewer.getByRole('slider', { name: 'Relative seek joystick' });
  const seekCommands = [];
  viewer.on('websocket', socket => socket.on('framesent', ({ payload }) => {
    const message = JSON.parse(String(payload));
    if (message.type === 'control' && message.action === 'seek') seekCommands.push(message);
  }));
  const dragJoystick = async offset => {
    const bounds = await joystick.boundingBox();
    await viewer.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await viewer.mouse.down();
    await viewer.mouse.move(bounds.x + bounds.width / 2 + offset, bounds.y + bounds.height / 2, { steps: 5 });
  };
  const assertPosition = async expected => {
    await until(() => Math.abs(room.playback.position - expected) < 0.1);
    await until(async () => !await joystick.isDisabled()).catch(error => {
      t.diagnostic(JSON.stringify({ expected, current: room.current, playback: room.playback }));
      throw error;
    });
    assert.equal(await joystick.getAttribute('aria-valuenow'), '0');
  };
  await until(async () => await viewer.locator('video').evaluate(v =>
    Math.abs(v.currentTime - 12) < .1 && !v.seeking && v.buffered.end(v.buffered.length - 1) - v.currentTime >= 30));
  const previewLabel = viewer.locator('.seek-preview-label');
  const localRequests = [];
  viewer.on('request', request => { if (/\/segment-\d+\.ts/.test(request.url())) localRequests.push(request.url()); });
  const beforePreview = await canvasSamples(viewer);
  const previewRevision = room.playback.revision;
  const requestCount = localRequests.length;
  await dragJoystick(40 / 3);
  await previewLabel.waitFor();
  assert.match(await previewLabel.innerText(), /0:22/);
  const ghostSamples = await canvasSamples(viewer);
  assert.equal(room.playback.revision, previewRevision, 'A ghost is local, not a shared seek.');
  assert.ok(Math.abs(await viewer.locator('video').evaluate(v => v.currentTime) - 12) < .1,
    'The main decoder stays at the shared position during preview.');
  assert.equal(localRequests.length, requestCount,
    `Preview uses received bytes without additional segment requests: ${localRequests.slice(requestCount)}`);
  await viewer.screenshot({ path: path.resolve('test-artifacts', 'seek-ghost.png') });
  await viewer.mouse.up();
  await assertPosition(22);
  await previewLabel.waitFor({ state: 'hidden' });
  await until(async () => await viewer.locator('video').evaluate(v => !v.seeking && Math.abs(v.currentTime - 22) < .1));
  const afterPreview = await canvasSamples(viewer);
  const ghostError = ghostSamples.reduce((sum, value, i) => sum + Math.abs(value -
    (beforePreview[i] * .55 + afterPreview[i] * .45)), 0) / ghostSamples.length;
  assert.ok(ghostError < 8, `Ghost pixels blend the real target frame at 45% opacity (error ${ghostError}).`);
  assert.ok(ghostSamples.some((value, i) => Math.abs(value - beforePreview[i]) > 30), 'Ghost must not be the currently playing frame.');
  await dragJoystick(-40 / 3);
  await previewLabel.waitFor();
  await viewer.keyboard.press('Escape');
  await viewer.mouse.up();
  await previewLabel.waitFor({ state: 'hidden' });
  assert.equal(room.playback.revision, previewRevision + 1, 'Cancelling a preview sends no seek.');
  await joystick.focus();
  await viewer.keyboard.down('ArrowRight');
  await previewLabel.waitFor();
  await joystick.blur();
  await viewer.keyboard.up('ArrowRight');
  await previewLabel.waitFor({ state: 'hidden' });
  await dragJoystick(-40 / 3);
  await previewLabel.waitFor();
  await joystick.dispatchEvent('pointercancel', { pointerId: 1 });
  await viewer.mouse.up();
  await previewLabel.waitFor({ state: 'hidden' });
  assert.equal(room.playback.revision, previewRevision + 1);
  await dragJoystick(40 / 3);
  await viewer.keyboard.press('Escape');
  await viewer.mouse.up();
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await previewLabel.count(), 0, 'An abandoned decoder must not publish a late ghost.');
  const ball = viewer.getByRole('button', { name: 'Beach ball', exact: true });
  const withoutBall = await canvasSamples(viewer);
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'true');
  assert.equal(await ball.getAttribute('aria-pressed'), 'true');
  const withBall = await canvasSamples(viewer);
  assert.ok(withBall.some((value, i) => Math.abs(value - withoutBall[i]) > 20), 'The beach ball renders over paused video.');
  await until(async () => {
    const moved = await canvasSamples(viewer);
    return moved.some((value, i) => Math.abs(value - withBall[i]) > 50);
  });
  assert.equal(room.playback.revision, previewRevision + 1, 'The test effect does not change shared playback.');
  await until(async () => await admin.getByRole('button', { name: 'Beach ball', exact: true }).getAttribute('aria-pressed') === 'true');
  const uploadsDuringAnimation = await viewer.locator('.video-canvas').evaluate(async canvas => {
    const gl = canvas.getContext('webgl');
    const upload = gl.texImage2D;
    let count = 0;
    gl.texImage2D = function (...args) {
      if (args.at(-1) instanceof HTMLVideoElement) count++;
      return upload.apply(this, args);
    };
    try {
      for (let index = 0; index < 6; index++) await new Promise(requestAnimationFrame);
      return count;
    } finally { gl.texImage2D = upload; }
  });
  assert.equal(uploadsDuringAnimation, 0, 'Ball animation never uploads the native video.');
  await viewer.locator('.video-canvas').evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    window.restoreBallContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await viewer.locator('.video-viewport[data-effects-renderer="2d"]').waitFor();
  assert.equal(await viewer.locator('.player-effects').evaluate(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) =>
      index % 4 === 3 && value > 100)), true, 'An active effect survives context loss.');
  await viewer.evaluate(() => { window.restoreBallContext(); delete window.restoreBallContext; });
  await viewer.locator('.video-viewport[data-effects-renderer="webgl"]').waitFor();
  assert.equal(await viewer.locator('.player-effects').evaluate(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.every(value => value === 0)), true,
    'Restoring WebGL clears the fallback so effects are not drawn twice.');
  await viewer.screenshot({ path: path.resolve('test-artifacts', 'beach-ball.png') });
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'false');
  assert.deepEqual(await canvasSamples(viewer), withoutBall, 'Toggling off restores clean video.');
  await viewer.emulateMedia({ reducedMotion: 'reduce' });
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'true');
  const reducedBall = await canvasSamples(viewer);
  await until(async () => (await canvasSamples(viewer)).some((value, i) => Math.abs(value - reducedBall[i]) > 50));
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'false');
  await viewer.emulateMedia({ reducedMotion: 'no-preference' });
  await dragJoystick(-40 / 3);
  await viewer.mouse.up();
  await assertPosition(12);
  const revision = room.playback.revision;
  await dragJoystick(150);
  assert.equal(await joystick.getAttribute('aria-valuenow'), '30');
  assert.equal(room.playback.revision, revision, 'Dragging must not seek before release.');
  await viewer.mouse.up();
  const spring = await joystick.locator('.joystick-knob').evaluate(knob => {
    const animation = knob.getAnimations()[0];
    if (!animation) return null;
    animation.pause();
    const duration = animation.effect.getTiming().duration;
    const offsets = [0, .25, .5, .73, .9, 1].map(fraction => {
      animation.currentTime = duration * fraction;
      return new DOMMatrixReadOnly(getComputedStyle(knob).transform).m41;
    });
    animation.currentTime = 0;
    animation.play();
    return { duration, offsets };
  });
  assert.ok(spring && spring.duration <= 400, 'The spring returns faster than the previous 600ms.');
  assert.ok(spring.offsets[0] > 0 && spring.offsets[1] < 0 && spring.offsets[2] > 0 &&
    spring.offsets[3] < 0 && spring.offsets[4] > 0 && Math.abs(spring.offsets[5]) < .1, 'Return oscillates across center before settling.');
  for (let index = 1; index < spring.offsets.length; index++) {
    assert.ok(Math.abs(spring.offsets[index]) < Math.abs(spring.offsets[index - 1]), 'Spring oscillation is damped.');
  }
  await assertPosition(42);
  assert.equal(room.playback.revision, revision + 1, 'Release sends exactly one shared seek.');
  await until(async () => room.current.media && await admin.locator('video').evaluate((v, baseTime) =>
    Math.abs(v.currentTime + baseTime - 42) < 0.4, room.current.media.baseTime || 0));
  await until(async () => await joystick.locator('.joystick-knob').evaluate(knob =>
    Math.abs(new DOMMatrixReadOnly(getComputedStyle(knob).transform).m41) < 0.1));
  await dragJoystick(-150);
  assert.equal(await joystick.getAttribute('aria-valuenow'), '-30');
  await viewer.mouse.up();
  await assertPosition(12);
  await dragJoystick(-150);
  await viewer.mouse.up();
  await assertPosition(0);
  await joystick.press('End');
  await assertPosition(30);
  await joystick.press('End');
  await assertPosition(60);
  await joystick.press('End');
  await assertPosition(60);
  await joystick.press('Home');
  await assertPosition(30);
  await joystick.press('Shift+ArrowLeft');
  await assertPosition(25);
  const cancelRevision = room.playback.revision;
  await dragJoystick(30);
  await viewer.keyboard.press('Escape');
  await viewer.mouse.up();
  await assertPosition(25);
  await dragJoystick(-30);
  await joystick.dispatchEvent('pointercancel', { pointerId: 1 });
  await viewer.mouse.up();
  await assertPosition(25);
  await joystick.focus();
  await viewer.keyboard.down('ArrowRight');
  assert.equal(await joystick.getAttribute('aria-valuenow'), '1');
  await joystick.blur();
  await viewer.keyboard.up('ArrowRight');
  await assertPosition(25);
  assert.equal(room.playback.revision, cancelRevision, 'Cancelled gestures must not seek.');
  await viewer.emulateMedia({ reducedMotion: 'reduce' });
  await dragJoystick(20);
  await viewer.keyboard.press('Escape');
  await viewer.mouse.up();
  assert.equal(await joystick.locator('.joystick-knob').evaluate(knob => knob.getAnimations().length), 0);
  await assertPosition(25);
  await viewer.emulateMedia({ reducedMotion: 'no-preference' });
  await admin.screenshot({ path: path.resolve('test-artifacts', 'desktop.png'), fullPage: true });
  await dragJoystick(30);
  await viewerContext.setOffline(true);
  await until(() => room.members.size === 1);
  await until(async () => await joystick.isDisabled());
  assert.equal(await joystick.getAttribute('aria-valuenow'), '0');
  await viewer.mouse.up();
  await viewerContext.setOffline(false);
  await until(() => room.members.size === 2, 15000);
  await until(async () => !await joystick.isDisabled());
  await joystick.press('ArrowRight');
  await assertPosition(26);
  assert.equal(seekCommands.length, 1, 'Reconnect must not replay the abandoned drag.');
  await viewer.getByRole('button', { name: 'Account settings', exact: true }).click();
  await viewer.getByLabel('Display name', { exact: true }).fill('Renamed viewer');
  await viewer.getByRole('button', { name: 'Save display name', exact: true }).click();
  await until(() => [...room.members.values()].some(u => u.displayName === 'Renamed viewer'));
  await viewer.getByRole('button', { name: 'Close dialog', exact: true }).click();
  await viewer.setViewportSize({ width: 390, height: 844 });
  await assertJoystickLayout(viewer);
  await assertNativeVideo(viewer);
  const touch = await viewerContext.newCDPSession(viewer);
  const touchBounds = await joystick.boundingBox();
  const touchPoint = { x: touchBounds.x + touchBounds.width / 2, y: touchBounds.y + touchBounds.height / 2 };
  await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint] });
  await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...touchPoint, x: touchPoint.x + 20 }] });
  assert.equal(await joystick.getAttribute('aria-valuenow'), '15');
  assert.equal(room.playback.position, 26, 'Touch dragging must wait for release.');
  await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await assertPosition(41);
  await touch.detach();
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'true');
  await viewer.screenshot({ path: path.resolve('test-artifacts', 'mobile.png'), fullPage: true });
  assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Mobile layout must not overflow horizontally.');
  await ball.click();
  await until(async () => await ball.getAttribute('aria-pressed') === 'false');
  const fallbackContext = await browser.newContext();
  await fallbackContext.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...options) {
      return type.startsWith('webgl') ? null : getContext.call(this, type, ...options);
    };
  });
  const fallback = await fallbackContext.newPage();
  fallback.on('pageerror', error => errors.push(error.message));
  await login(fallback, 'admin', 'garbageTime_');
  await until(async () => await fallback.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0));
  assert.equal(await fallback.locator('.video-viewport').getAttribute('data-renderer'), 'native');
  assert.equal(await fallback.locator('video').evaluate(video => getComputedStyle(video).opacity), '1');
  const fallbackBall = fallback.getByRole('button', { name: 'Beach ball', exact: true });
  await fallbackBall.click();
  await until(async () => await fallbackBall.getAttribute('aria-pressed') === 'true');
  const effectAlpha = () => fallback.locator('.player-effects').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let max = 0;
    for (let index = 3; index < data.length; index += 4) max = Math.max(max, data[index]);
    return max;
  });
  const ballAlpha = await effectAlpha();
  assert.ok(ballAlpha >= 240 && ballAlpha < 255, `Fallback ball is nearly opaque, alpha ${ballAlpha}.`);
  await fallbackBall.click();
  await until(async () => await fallbackBall.getAttribute('aria-pressed') === 'false');
  assert.equal(await effectAlpha(), 0, 'Fallback effects clear when disabled.');
  const fallbackStick = fallback.getByRole('slider', { name: 'Relative seek joystick', exact: true });
  await until(async () => await fallback.locator('video').evaluate(v => v.buffered.length &&
    v.buffered.end(v.buffered.length - 1) > v.currentTime + 2));
  await fallbackStick.focus();
  await fallback.keyboard.down('ArrowRight');
  await fallback.locator('.seek-preview-label').waitFor();
  assert.ok(await effectAlpha() > 100, 'Ghost renders even without WebGL.');
  await fallback.keyboard.press('Escape');
  await fallback.keyboard.up('ArrowRight');
  await fallback.locator('.seek-preview-label').waitFor({ state: 'hidden' });
  assert.equal(await effectAlpha(), 0);
  await fallbackContext.close();
  t.diagnostic('Verified native video, transparent WebGL effects and preview blending, paused seeks, fullscreen/HiDPI/mobile sizing, context recovery, 2D fallback, and the 380ms joystick spring.');
  await viewer.setViewportSize({ width: 1280, height: 900 });
  await viewer.getByRole('slider', { name: 'Seek shared video', exact: true }).evaluate(slider => {
    slider.value = '12';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await assertPosition(12);
  await until(async () => await viewer.locator('video').evaluate((video, baseTime) => !video.seeking &&
    Math.abs(video.currentTime + baseTime - 12) < .1 && video.buffered.length &&
    video.buffered.end(video.buffered.length - 1) + baseTime > 30, room.current.media?.baseTime || 0));
  await viewer.getByRole('button', { name: 'Play for everyone', exact: true }).click();
  await until(async () => !room.playback.paused && await playing(viewer));
  const previewTime = () => viewer.locator('.video-viewport').getAttribute('data-preview-time');
  const assertSteadyPreview = async () => {
    const observed = await viewer.locator('.video-viewport').evaluate(async viewport => {
      const video = viewport.querySelector('video');
      const start = video.currentTime;
      const times = [viewport.getAttribute('data-preview-time')];
      const observer = new MutationObserver(() => times.push(viewport.getAttribute('data-preview-time')));
      observer.observe(viewport, { attributes: true, attributeFilter: ['data-preview-time'] });
      await new Promise(resolve => setTimeout(resolve, 1100));
      observer.disconnect();
      return { times, elapsed: video.currentTime - start };
    });
    assert.ok(observed.elapsed > .7, 'Playback keeps advancing while the joystick is held.');
    assert.deepEqual(observed.times, [observed.times[0]], 'A stationary joystick must not clear or change the ghost on playback ticks.');
  };
  const bounds = await joystick.boundingBox();
  const moveStick = offset => viewer.mouse.move(bounds.x + bounds.width / 2 + offset, bounds.y + bounds.height / 2);
  await moveStick(0);
  const beforeHold = targetPosition(room);
  await viewer.mouse.down();
  const afterHold = targetPosition(room);
  const heldRevision = room.playback.revision;
  await new Promise(resolve => setTimeout(resolve, 800));
  await moveStick(40 / 3);
  await previewLabel.waitFor();
  const heldTarget = Number(await previewTime());
  await assertSteadyPreview();
  assert.ok(heldTarget >= beforeHold + 10 - .15 && heldTarget <= afterHold + 10 + .15,
    'The center is captured on press, even if the first movement is delayed.');
  await moveStick(0);
  await previewLabel.waitFor({ state: 'hidden' });
  await new Promise(resolve => setTimeout(resolve, 350));
  await moveStick(20 / 3);
  await previewLabel.waitFor();
  const releasedTarget = Number(await previewTime());
  assert.ok(Math.abs(releasedTarget - (heldTarget - 5)) < .001, 'Crossing center preserves the original seek anchor.');
  assert.equal(room.playback.revision, heldRevision, 'Holding and moving the joystick sends no shared seeks.');
  await viewer.mouse.up();
  await assertPosition(releasedTarget);
  await previewLabel.waitFor({ state: 'hidden' });
  assert.equal(room.playback.revision, heldRevision + 1, 'Release seeks once to the displayed target, not the advancing playback time.');
  await until(async () => await playing(viewer) && await viewer.locator('video').evaluate(video => !video.seeking));
  await joystick.focus();
  const beforeKey = targetPosition(room);
  await viewer.keyboard.down('ArrowLeft');
  const afterKey = targetPosition(room);
  await previewLabel.waitFor();
  const keyboardTarget = Number(await previewTime());
  assert.ok(keyboardTarget >= beforeKey - 1 - .15 && keyboardTarget <= afterKey - 1 + .15,
    'A new keyboard hold captures a fresh playback center.');
  await assertSteadyPreview();
  await viewer.keyboard.up('ArrowLeft');
  await assertPosition(keyboardTarget);
  await previewLabel.waitFor({ state: 'hidden' });
  await viewer.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  t.diagnostic('Verified press-time seek anchoring, stable ghosts during playback, center crossing, release targets, and fresh keyboard holds.');
  await admin.getByRole('button', { name: 'Manage users', exact: true }).click();
  await admin.getByRole('button', { name: 'Delete watcher', exact: true }).click();
  await admin.getByRole('button', { name: 'Yes, delete account', exact: true }).click();
  await viewer.getByRole('button', { name: 'Enter Helltube', exact: true }).waitFor();
  assert.deepEqual(errors, []);
});

test('Mix playlist switch defaults off and controls the imported queue on desktop and mobile', {timeout: 30000}, async t => {
  const {instance, url} = await start(t);
  instance.capabilities.youtube = true;
  t.mock.method(instance.media, 'schedule', () => {});
  const seed = {id: '5WzswZXTMZQ', title: 'Mix seed video', duration: 90};
  const extracted = [];
  let releaseExtraction;
  t.mock.method(instance.youtube, 'extract', async args => {
    const target = args.at(-1);
    extracted.push(target);
    if (releaseExtraction) await releaseExtraction.promise;
    return new URL(target).searchParams.has('list')
      ? {title: 'Test Mix', entries: [seed, {id: 'jNQXAC9IVRw', title: 'Next video', duration: 19}]} : seed;
  });
  const browser = await chromium.launch({channel: 'chrome', headless: true});
  t.after(async () => {releaseExtraction?.resolve(); await browser.close();});
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  await page.getByLabel('Username', {exact: true}).fill('admin');
  await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
  await page.getByRole('button', {name: 'Enter Helltube'}).click();
  await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const input = page.getByLabel('YouTube, Twitch VOD, or hosted media URL', {exact: true});
  const toggle = page.getByRole('switch', {name: 'Include Mix playlist', exact: true});
  const mix = 'https://www.youtube.com/watch?v=5WzswZXTMZQ&list=RD5WzswZXTMZQ&start_radio=1&t=10';
  const submit = async expected => {
    const response = page.waitForResponse(response => response.url().endsWith('/api/rooms/lobby/media') &&
      response.request().method() === 'POST');
    await page.getByRole('button', {name: 'Add to queue', exact: true}).click();
    const result = await response;
    assert.equal(result.status(), 201);
    assert.equal((await result.json()).added, expected);
    await until(async () => await input.inputValue() === '');
  };
  assert.equal(await toggle.count(), 0);
  await input.fill(mix);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await page.locator('.composer').screenshot({path: 'test-artifacts/mix-playlist-desktop.png'});
  await submit(1);
  assert.equal(extracted.at(-1), 'https://www.youtube.com/watch?v=5WzswZXTMZQ');
  assert.equal(room.current.playlistId, null);
  assert.equal(room.current.startAt, 10, 'Video-only submissions keep the selected start time.');
  assert.equal(room.queue.length, 0);

  await input.fill(mix);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.press('Space');
  assert.equal(await toggle.getAttribute('aria-checked'), 'true');
  await toggle.press('Space');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false');
  await toggle.click();
  for (const width of [390, 320]) {
    await page.setViewportSize({width, height: 844});
    await toggle.scrollIntoViewIfNeeded();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await page.locator('.composer').screenshot({path: 'test-artifacts/mix-playlist-mobile.png'});
  releaseExtraction = Promise.withResolvers();
  const pending = submit(2);
  await until(() => extracted.length === 2);
  assert.equal(await toggle.isDisabled(), true, 'The choice is locked during submission.');
  releaseExtraction.resolve();
  await pending;
  releaseExtraction = null;
  assert.equal(extracted.at(-1), 'https://www.youtube.com/watch?v=5WzswZXTMZQ&list=RD5WzswZXTMZQ');
  assert.deepEqual(room.queue.map(item => item.startAt), [10, 0]);
  assert.ok(room.queue[0].playlistId && room.queue[0].playlistId === room.queue[1].playlistId);

  await input.fill(mix);
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'Each new submission starts with Mix disabled.');
  await toggle.click();
  await input.fill('https://youtu.be/5WzswZXTMZQ?list=RD5WzswZXTMZQ');
  assert.equal(await toggle.getAttribute('aria-checked'), 'false', 'Changing the URL resets the choice.');
  await submit(1);
  assert.equal(room.queue.at(-1).playlistId, null);
  await input.fill('https://www.youtube.com/watch?v=5WzswZXTMZQ&list=PL1234567890123');
  assert.equal(await toggle.count(), 0);
  await submit(2);
  assert.equal(extracted.at(-1), 'https://www.youtube.com/playlist?list=PL1234567890123');
  assert.deepEqual(errors, []);
});

test('YouTube start-time editor and joystick feed timestamped playback to two browsers', { timeout: 90000 }, async t => {
  const { instance, url, dir } = await start(t);
  instance.capabilities.youtube = true;
  const sample = path.join(dir, 'timestamp-sample.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', sample]);
  instance.app.get('/timestamp-source.mp4', (_req, res) => res.sendFile(sample, { dotfiles: 'allow' }));
  t.mock.method(instance.youtube, 'extract', async () => ({ id: 'BaW_jenozKc', title: 'Timestamp video', duration: 60 }));
  t.mock.method(instance.youtube, 'resolve', async () => ({ duration: 60, inputs: [{ url: `${url}/timestamp-source.mp4`, headers: {} }] }));
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const editor = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
  const viewer = await (await browser.newContext()).newPage();
  const errors = [];
  for (const page of [editor, viewer]) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await page.getByRole('button', { name: 'Enter Helltube' }).click();
    await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
    await page.getByRole('region', { name: 'Synchronized room player' }).waitFor();
  }
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size === 2);
  const input = editor.getByLabel('YouTube, Twitch VOD, or hosted media URL', { exact: true });
  const checkbox = editor.getByRole('checkbox', { name: 'Start at', exact: true });
  const timeInput = editor.getByRole('textbox', { name: 'Video start time', exact: true });
  const joystick = editor.getByRole('slider', { name: 'Start time joystick', exact: true });
  const submissions = [];
  editor.on('request', request => {
    if (request.url().endsWith('/api/rooms/lobby/media') && request.method() === 'POST') submissions.push(request.postDataJSON());
  });
  assert.equal(await checkbox.count(), 0);
  await input.fill('https://www.youtube.com/watch?v=BaW_jenozKc&t=90');
  assert.equal(await checkbox.isChecked(), true);
  assert.equal(await timeInput.inputValue(), '1:30');
  const revision = room.playback.revision;
  const drag = async offset => {
    await joystick.scrollIntoViewIfNeeded();
    const bounds = await joystick.boundingBox();
    await editor.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await editor.mouse.down();
    await editor.mouse.move(bounds.x + bounds.width / 2 + offset, bounds.y + bounds.height / 2, { steps: 4 });
  };
  await drag(100);
  assert.equal(await timeInput.inputValue(), '1:30', 'Dragging waits for release.');
  await editor.mouse.up();
  assert.equal(await timeInput.inputValue(), '2:00');
  assert.equal(await joystick.getAttribute('aria-valuenow'), '0');
  await joystick.press('Home');
  assert.equal(await timeInput.inputValue(), '1:30');
  await joystick.press('Shift+ArrowLeft');
  assert.equal(await timeInput.inputValue(), '1:25');
  await timeInput.fill('5');
  await joystick.press('Home');
  assert.equal(await timeInput.inputValue(), '0:00', 'Start time cannot become negative.');
  await drag(40);
  await editor.keyboard.press('Escape');
  await editor.mouse.up();
  assert.equal(await timeInput.inputValue(), '0:00');
  assert.equal(room.playback.revision, revision, 'Editing start time must never send shared controls.');
  await timeInput.fill('bad');
  await editor.getByRole('button', { name: 'Add to queue', exact: true }).click();
  assert.equal(submissions.length, 0);
  assert.match(await editor.locator('.composer').innerText(), /valid start time/i);
  await checkbox.uncheck();
  assert.equal(await timeInput.isDisabled(), true);
  assert.equal(await joystick.isDisabled(), true);
  await checkbox.check();
  assert.equal(await timeInput.inputValue(), 'bad', 'Opt-out preserves the draft for rechecking.');
  await input.fill('https://youtu.be/BaW_jenozKc?t=1h2m3s');
  assert.equal(await timeInput.inputValue(), '1:02:03');
  await input.fill('https://youtu.be/BaW_jenozKc?t=');
  assert.equal(await checkbox.isVisible(), true, 'Malformed timestamps can be corrected.');
  await input.fill('https://youtu.be/BaW_jenozKc');
  assert.equal(await checkbox.count(), 0);
  await input.fill('https://youtu.be/BaW_jenozKc?t=30&si=share');
  assert.equal(await checkbox.isChecked(), true);
  await timeInput.fill('0:15');
  for (const width of [390, 320]) {
    await editor.setViewportSize({ width, height: 844 });
    await joystick.scrollIntoViewIfNeeded();
    const field = await input.boundingBox();
    const clock = await timeInput.boundingBox();
    const stick = await joystick.boundingBox();
    assert.ok(clock.y >= field.y + field.height, 'The option belongs below the URL textbox.');
    assert.ok(stick.x >= clock.x + clock.width, 'The joystick belongs beside the editable time.');
    assert.ok(Math.abs(stick.y + stick.height / 2 - clock.y - clock.height / 2) < 2);
    assert.equal(await editor.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
  }
  await editor.screenshot({ path: path.resolve('test-artifacts', 'start-time-mobile.png'), fullPage: true });
  await editor.setViewportSize({ width: 1280, height: 900 });
  await editor.screenshot({ path: path.resolve('test-artifacts', 'start-time-desktop.png'), fullPage: true });
  const submit = async () => {
    const response = editor.waitForResponse(response => response.url().endsWith('/api/rooms/lobby/media') && response.request().method() === 'POST');
    await editor.getByRole('button', { name: 'Add to queue', exact: true }).click();
    assert.equal((await response).status(), 201);
    await until(async () => await input.inputValue() === '');
  };
  await submit();
  assert.equal(submissions[0].startAt, 15);
  assert.equal(room.current.startAt, 15);
  assert.equal(await checkbox.count(), 0);
  const assertPlaying = async baseTime => {
    await until(async () => {
      assert.notEqual(room.current.status, 'error', room.current.error);
      if (room.current.media?.baseTime !== baseTime) return false;
      for (const page of [editor, viewer]) {
        const enable = page.getByRole('button', { name: 'Enable playback', exact: true });
        if (await enable.isVisible()) await enable.click();
      }
      return (await Promise.all([editor, viewer].map(page => page.locator('video').evaluate((video, position) =>
        !video.paused && video.videoWidth > 0 && Math.abs(video.currentTime - position) < 1,
      instance.rooms.position(room) - baseTime)))).every(Boolean);
    }, 25000);
  };
  await assertPlaying(15);
  const playbackStick = viewer.getByRole('slider', { name: 'Relative seek joystick', exact: true });
  const ghostLabel = viewer.locator('.seek-preview-label');
  await until(async () => await viewer.locator('video').evaluate(v => v.buffered.length &&
    v.buffered.end(v.buffered.length - 1) > v.currentTime + 7));
  const playingRevision = room.playback.revision;
  const playingPosition = await viewer.locator('video').evaluate(v => v.currentTime);
  await playbackStick.focus();
  await viewer.keyboard.down('ArrowRight');
  await ghostLabel.waitFor();
  const ghostTime = Number(await viewer.locator('.video-viewport').getAttribute('data-preview-time'));
  assert.ok(ghostTime > 15 + playingPosition, 'Preview timestamps include the nonzero media base time.');
  await until(async () => await viewer.locator('video').evaluate((v, before) => !v.paused &&
    v.currentTime > before + .4, playingPosition));
  assert.equal(Number(await viewer.locator('.video-viewport').getAttribute('data-preview-time')), ghostTime,
    'The preview stays pinned while playback advances, including streams with a nonzero base time.');
  assert.equal(room.playback.revision, playingRevision, 'Live preview leaves both viewers playing on the shared clock.');
  await viewer.keyboard.press('Escape');
  await viewer.keyboard.up('ArrowRight');
  await ghostLabel.waitFor({ state: 'hidden' });
  await viewer.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await until(() => room.playback.paused);
  const pausedRevision = room.playback.revision;
  await playbackStick.focus();
  await viewer.keyboard.down('Home');
  await new Promise(resolve => setTimeout(resolve, 350));
  assert.equal(await ghostLabel.count(), 0, 'A target before this stream base is not locally buffered; do not show a stale ghost.');
  await viewer.keyboard.press('Escape');
  await viewer.keyboard.up('Home');
  assert.equal(room.playback.revision, pausedRevision);
  await input.fill('https://www.youtube.com/watch?v=BaW_jenozKc&t=45');
  await checkbox.uncheck();
  await submit();
  assert.equal(submissions[1].startAt, 0);
  assert.equal(room.queue[0].startAt, 0);
  await input.fill('https://youtu.be/BaW_jenozKc?t=10');
  await timeInput.fill('25');
  await editor.getByRole('combobox', { name: /^Insert/ }).selectOption('0');
  await submit();
  assert.equal(submissions[2].startAt, 25);
  assert.deepEqual(room.queue.map(item => item.startAt), [25, 0]);
  assert.equal(room.playback.revision, pausedRevision, 'Queue submissions do not seek the current video.');
  await until(() => room.queue[0].media?.bufferedUntil >= 29, 20000);
  const preparedURL = room.queue[0].media.url;
  await playbackStick.focus();
  await viewer.keyboard.down('ArrowRight');
  await ghostLabel.waitFor();
  instance.rooms.advance(room);
  assert.equal(room.current.media.url, preparedURL);
  assert.equal(room.playback.position, 25);
  await assertPlaying(25);
  await ghostLabel.waitFor({ state: 'hidden' });
  await viewer.keyboard.up('ArrowRight');
  assert.deepEqual(errors, []);
  t.diagnostic('Start-time detection, validation, mouse/keyboard joystick, opt-out, mobile layout and timestamped two-browser playback passed with local media.');
});

test('overlay controls autohide accessibly and account volume survives reloads and new sessions', { timeout: 90000 }, async t => {
  const { instance, url, dir } = await start(t);
  const browser = await chromium.launch({ channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const join = async target => {
    await target.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button').first().click();
    await target.locator('.player-shell').waitFor();
  };
  const login = async target => {
    await target.goto(url);
    await target.getByLabel('Username', { exact: true }).fill('admin');
    await target.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await target.getByRole('button', { name: 'Enter Helltube' }).click();
    await join(target);
  };
  await login(page);
  const volume = page.getByRole('slider', { name: 'Volume on this device', exact: true });
  assert.equal(await volume.inputValue(), '0.95');
  assert.equal(await page.locator('video').evaluate(video => video.volume), .8);
  const savedVolume = 1 / 11;
  const changes = [];
  page.on('request', request => {
    if (request.url().endsWith('/api/me/preferences')) changes.push(request.postDataJSON());
  });
  await volume.evaluate(input => {
    for (const value of [.6, .5, .4, .5]) {
      input.value = value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(() => instance.accounts.users[0].preferences.volume === savedVolume);
  assert.deepEqual(changes, [{ volume: savedVolume }], 'A slider gesture coalesces and commits only changed preferences.');
  await page.getByRole('button', { name: 'Mute on this device', exact: true }).click();
  await until(() => instance.accounts.users[0].preferences.muted);
  await page.reload();
  await join(page);
  assert.equal(await volume.inputValue(), '0.5');
  assert.deepEqual(await page.locator('video').evaluate(video => ({ volume: video.volume, muted: video.muted })), { volume: savedVolume, muted: true });
  const secondContext = await browser.newContext({ viewport: { width: 1280, height: 844 }, isMobile: true, hasTouch: true });
  const mobile = await secondContext.newPage();
  await login(mobile);
  await mobile.setViewportSize({ width: 390, height: 844 });
  assert.equal(await mobile.getByRole('slider', { name: 'Volume on this device' }).inputValue(), '0.5');
  assert.equal(await mobile.locator('video').evaluate(video => video.muted), true);
  await secondContext.close();

  const sample = path.join(dir, 'controls-sample.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-g', '60', '-movflags', 'frag_keyframe+empty_moov', sample]);
  const bytes = await readFile(sample);
  const room = instance.rooms.get('lobby');
  const { uploadId, chunkSize } = await instance.uploads.create(room, instance.accounts.users[0], { name: 'Controls test', size: bytes.length, duration: 60 });
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    await instance.uploads.append(instance.uploads.get(uploadId), offset, bytes.subarray(offset, offset + chunkSize), 1);
  }
  const shell = page.locator('.player-shell');
  const viewport = page.locator('.video-viewport');
  const reveal = () => viewport.hover({ position: { x: 30, y: 70 } });
  await until(async () => room.current.media?.complete && await page.locator('video').evaluate(video => !video.paused && video.readyState >= 2), 20000);
  await reveal();
  const layout = await viewport.evaluate(node => {
    const video = node.getBoundingClientRect();
    const controls = node.querySelector('.transport-row').getBoundingClientRect();
    return { video: { top: video.top, bottom: video.bottom }, controls: { top: controls.top, bottom: controls.bottom },
      filters: [...node.querySelectorAll('.controls-blur')].map(layer => ({ blur: getComputedStyle(layer).backdropFilter, mask: getComputedStyle(layer).maskImage })) };
  });
  assert.ok(layout.controls.top > layout.video.top && layout.controls.bottom <= layout.video.bottom + 1);
  assert.deepEqual(layout.filters.map(layer => layer.blur), ['blur(3px)', 'blur(6px)', 'blur(12px)', 'blur(20px)']);
  assert.ok(layout.filters.every(layer => layer.mask.includes('linear-gradient')));
  await page.screenshot({ path: path.resolve('test-artifacts', 'controls-visible.png') });
  const beforeIdle = room.playback.revision;
  const quality = page.getByRole('combobox', {name: 'Video quality on this device'});
  await quality.click();
  await page.getByRole('listbox', {name: 'Video quality', exact: true}).waitFor();
  await shell.evaluate(node => {
    const observer = new MutationObserver(() => {
      if (node.dataset.controlsVisible !== 'false') return;
      window.qualityClosedAtHide = !node.querySelector('.quality-menu')
        && node.querySelector('.quality-select').getAttribute('aria-expanded') === 'false';
      observer.disconnect();
    });
    observer.observe(node, {attributes: true, attributeFilter: ['data-controls-visible']});
  });
  await page.mouse.move(0, 0);
  await until(async () => await shell.getAttribute('data-controls-visible') === 'false', 6000);
  assert.equal(await page.evaluate(() => window.qualityClosedAtHide), true, 'The dropdown closes as autohide starts, before the control transition finishes.');
  await page.waitForTimeout(400);
  const hidden = await viewport.evaluate(node => {
    const track = node.querySelector('.seek-track');
    const input = track.querySelector('input');
    return { height: track.getBoundingClientRect().height, bottom: track.getBoundingClientRect().bottom,
      viewportBottom: node.getBoundingClientRect().bottom, input: getComputedStyle(input).visibility,
      row: getComputedStyle(node.querySelector('.transport-row')).visibility, pointerEvents: getComputedStyle(input).pointerEvents };
  });
  assert.equal(hidden.height, 2);
  assert.ok(Math.abs(hidden.bottom - hidden.viewportBottom) < 1);
  assert.equal(hidden.input, 'hidden');
  assert.equal(hidden.row, 'hidden');
  assert.equal(hidden.pointerEvents, 'none');
  assert.equal(room.playback.revision, beforeIdle);
  await page.screenshot({ path: path.resolve('test-artifacts', 'controls-hidden.png') });
  await viewport.dispatchEvent('pointerdown', { pointerId: 42, pointerType: 'touch', bubbles: true });
  await viewport.dispatchEvent('pointerup', { pointerId: 42, pointerType: 'touch', bubbles: true });
  assert.equal(await shell.getAttribute('data-controls-visible'), 'true');
  assert.equal(await quality.getAttribute('aria-expanded'), 'false', 'Revealing controls does not reopen the dropdown.');
  assert.equal(room.playback.revision, beforeIdle, 'The first hidden touch reveals without changing playback.');

  await page.keyboard.press('Tab');
  const joystick = page.getByRole('slider', { name: 'Relative seek joystick', exact: true });
  await joystick.focus();
  await page.waitForTimeout(3300);
  assert.equal(await shell.getAttribute('data-controls-visible'), 'true', 'Keyboard-focused controls do not disappear.');
  await reveal();
  const stick = await joystick.boundingBox();
  await page.mouse.move(stick.x + stick.width / 2, stick.y + stick.height / 2);
  await page.mouse.down();
  await page.mouse.move(stick.x + stick.width / 2 + 10, stick.y + stick.height / 2);
  await page.waitForTimeout(3300);
  assert.equal(await shell.getAttribute('data-controls-visible'), 'true', 'A held pointer and preview prevent hiding.');
  await page.keyboard.press('Escape');
  await page.mouse.up();
  assert.equal(room.playback.revision, beforeIdle);
  await reveal();
  await page.getByRole('button', { name: 'Pause for everyone', exact: true }).click();
  await until(() => room.playback.paused);
  await page.mouse.move(0, 0);
  await page.waitForTimeout(3300);
  assert.equal(await shell.getAttribute('data-controls-visible'), 'true', 'Paused playback keeps its controls visible.');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.equal(await page.locator('.transport').evaluate(node => parseFloat(getComputedStyle(node).transitionDuration)), .00001);
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(100);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    const geometry = await viewport.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      const row = node.querySelector('.transport-row').getBoundingClientRect();
      return row.left >= bounds.left && row.right <= bounds.right && row.top >= bounds.top && row.bottom <= bounds.bottom + 1;
    });
    assert.equal(geometry, true, `All controls remain on video at ${width}px.`);
  }
  await page.screenshot({ path: path.resolve('test-artifacts', 'controls-mobile.png') });
  assert.deepEqual(errors, []);
  t.diagnostic('Verified SQLite-backed volume/mute on reload and new login, progressive blur, idle line, touch reveal, focus/drag holds, and mobile controls.');
});
