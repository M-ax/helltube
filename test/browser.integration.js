import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { start, until } from './helpers.js';
import { targetPosition } from '../src/lib/format.js';

async function assertCanvasFrame(page) {
  await until(async () => await page.locator('video').evaluate(video => !video.seeking && video.readyState >= 2));
  await page.locator('.video-viewport[data-renderer="webgl"]').waitFor();
  const result = await page.locator('.video-canvas').evaluate(canvas => {
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
    const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let difference = 0;
    let lit = 0;
    let samples = 0;
    for (let y = 10; y < canvas.height; y += 23) {
      for (let x = 10; x < canvas.width; x += 23) {
        const actualIndex = ((canvas.height - y - 1) * canvas.width + x) * 4;
        const expectedIndex = (y * canvas.width + x) * 4;
        for (let channel = 0; channel < 3; channel++) {
          difference += Math.abs(pixels[actualIndex + channel] - expected[expectedIndex + channel]);
          if (pixels[actualIndex + channel] > 80) lit++;
          samples++;
        }
      }
    }
    const shell = document.querySelector('.player-shell').getBoundingClientRect();
    const bounds = canvas.getBoundingClientRect();
    return { error: gl.getError(), difference: difference / samples, lit, samples,
      contained: bounds.left >= shell.left && bounds.right <= shell.right,
      bounds: { width: bounds.width, shellWidth: shell.width },
      videoOpacity: getComputedStyle(video).opacity, canvasOpacity: getComputedStyle(canvas).opacity,
      width: canvas.width, expectedWidth: Math.round(canvas.clientWidth * Math.min(devicePixelRatio, 2)) };
  });
  assert.equal(result.error, 0, 'WebGL draws without GPU errors.');
  assert.ok(result.lit > result.samples / 10, 'The canvas must contain decoded video, not a blank frame.');
  assert.ok(result.difference < 12, `WebGL pixels must match the native frame, upright and letterboxed: ${JSON.stringify(result)}`);
  assert.equal(result.videoOpacity, '0', 'Native video is only the decoder while WebGL is active.');
  assert.equal(result.canvasOpacity, '1');
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
    document.querySelector('video').dispatchEvent(new Event('seeked'));
    const gl = canvas.getContext('webgl');
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    const samples = [];
    for (let y = 10; y < canvas.height; y += 31) {
      for (let x = 10; x < canvas.width; x += 31) {
        const index = (y * canvas.width + x) * 4;
        samples.push(...pixels.slice(index, index + 3));
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
  await assertCanvasFrame(admin);
  await assertCanvasFrame(viewer);
  await assertJoystickLayout(viewer);
  await viewer.getByRole('button', { name: 'Toggle fullscreen' }).click();
  await until(async () => await viewer.evaluate(() => !!document.fullscreenElement));
  await assertCanvasFrame(viewer);
  await viewer.getByRole('button', { name: 'Toggle fullscreen' }).click();
  await until(async () => await viewer.evaluate(() => !document.fullscreenElement));
  await viewer.locator('.video-canvas').evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    window.restoreTestContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await viewer.locator('.video-viewport[data-renderer="native"]').waitFor();
  assert.equal(await viewer.locator('video').evaluate(video => getComputedStyle(video).opacity), '1');
  await viewer.evaluate(() => { window.restoreTestContext(); delete window.restoreTestContext; });
  await assertCanvasFrame(viewer);
  await viewer.getByRole('slider', { name: 'Seek shared video', exact: true }).evaluate(slider => {
    slider.value = '12';
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    slider.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await until(async () => Math.abs(room.playback.position - 12) < 0.1 &&
    await admin.locator('video').evaluate(v => Math.abs(v.currentTime - 12) < 0.4));
  await assertCanvasFrame(admin);
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
  const ball = viewer.getByRole('button', { name: 'Beach ball test', exact: true });
  const withoutBall = await canvasSamples(viewer);
  await ball.click();
  assert.equal(await ball.getAttribute('aria-pressed'), 'true');
  const withBall = await canvasSamples(viewer);
  assert.ok(withBall.some((value, i) => Math.abs(value - withoutBall[i]) > 20), 'The beach ball renders over paused video.');
  await until(async () => {
    const moved = await canvasSamples(viewer);
    return moved.some((value, i) => Math.abs(value - withBall[i]) > 50);
  });
  assert.equal(room.playback.revision, previewRevision + 1, 'The test effect does not change shared playback.');
  assert.equal(await admin.getByRole('button', { name: 'Beach ball test', exact: true }).getAttribute('aria-pressed'), 'false');
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
  assert.equal(uploadsDuringAnimation, 0, 'Ball-only animation reuses the paused video texture.');
  await viewer.locator('.video-canvas').evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    window.restoreBallContext = () => extension.restoreContext();
    extension.loseContext();
  });
  await viewer.locator('.video-viewport[data-renderer="native"]').waitFor();
  assert.equal(await viewer.locator('.player-effects').evaluate(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) =>
      index % 4 === 3 && value > 100)), true, 'An active effect survives context loss.');
  await viewer.evaluate(() => { window.restoreBallContext(); delete window.restoreBallContext; });
  await viewer.locator('.video-viewport[data-renderer="webgl"]').waitFor();
  assert.equal(await viewer.locator('.player-effects').evaluate(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.every(value => value === 0)), true,
    'Restoring WebGL clears the fallback so effects are not drawn twice.');
  await viewer.screenshot({ path: path.resolve('test-artifacts', 'beach-ball.png') });
  await ball.click();
  assert.deepEqual(await canvasSamples(viewer), withoutBall, 'Toggling off restores clean video.');
  await viewer.emulateMedia({ reducedMotion: 'reduce' });
  await ball.click();
  const reducedBall = await canvasSamples(viewer);
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.deepEqual(await canvasSamples(viewer), reducedBall, 'Reduced motion keeps the test ball stationary.');
  await ball.click();
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
  await assertCanvasFrame(viewer);
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
  await viewer.screenshot({ path: path.resolve('test-artifacts', 'mobile.png'), fullPage: true });
  assert.equal(await viewer.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, 'Mobile layout must not overflow horizontally.');
  await ball.click();
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
  const fallbackBall = fallback.getByRole('button', { name: 'Beach ball test', exact: true });
  await fallbackBall.click();
  const effectAlpha = () => fallback.locator('.player-effects').evaluate(canvas => {
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let max = 0;
    for (let index = 3; index < data.length; index += 4) max = Math.max(max, data[index]);
    return max;
  });
  const ballAlpha = await effectAlpha();
  assert.ok(ballAlpha > 100 && ballAlpha < 220, `Fallback ball is semi-transparent, alpha ${ballAlpha}.`);
  await fallbackBall.click();
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
  t.diagnostic('Verified WebGL pixels, paused seeks, fullscreen/HiDPI/mobile sizing, context recovery, native fallback, and the 380ms joystick spring.');
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

test('YouTube start-time editor and joystick feed timestamped playback to two browsers', { timeout: 90000 }, async t => {
  const { instance, url, dir } = await start(t);
  instance.capabilities.youtube = true;
  const sample = path.join(dir, 'timestamp-sample.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', sample]);
  instance.app.get('/timestamp-source.mp4', (_req, res) => res.sendFile(sample));
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
  const input = editor.getByLabel('YouTube video or playlist URL', { exact: true });
  const checkbox = editor.getByRole('checkbox', { name: 'Start at', exact: true });
  const timeInput = editor.getByRole('textbox', { name: 'Video start time', exact: true });
  const joystick = editor.getByRole('slider', { name: 'Start time joystick', exact: true });
  const submissions = [];
  editor.on('request', request => {
    if (request.url().endsWith('/api/rooms/lobby/youtube') && request.method() === 'POST') submissions.push(request.postDataJSON());
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
    const response = editor.waitForResponse(response => response.url().endsWith('/api/rooms/lobby/youtube') && response.request().method() === 'POST');
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
  await page.mouse.move(0, 0);
  await until(async () => await shell.getAttribute('data-controls-visible') === 'false', 6000);
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
