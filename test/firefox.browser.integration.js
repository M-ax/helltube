import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {firefox} from 'playwright';
import {start, until} from './helpers.js';
import {targetPosition} from '../src/lib/format.js';
import {observeVideoRendering, hasWebglOverlay} from './player-rendering-helpers.js';

test('Firefox plays native HLS video with CRT, seek previews and reactions', {timeout: 60000}, async t => {
  const {instance, url, dir} = await start(t);
  const browser = await firefox.launch({headless: true});
  t.after(() => browser.close());
  const page = await browser.newPage({viewport: {width: 1280, height: 900}});
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(observeVideoRendering);
  await page.goto(url);
  await page.getByLabel('Username', {exact: true}).fill('admin');
  await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
  await page.getByRole('button', {name: 'Enter Helltube'}).click();
  await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
  await page.getByRole('heading', {name: 'NO SIGNAL'}).waitFor();
  const canvas = page.locator('.video-canvas');
  assert.equal(await canvas.evaluate(canvas => {
    window.dispatchEvent(new Event('resize'));
    const gl = canvas.getContext('webgl');
    if (!gl) return false;
    const pixels = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    return gl.getError() === gl.NO_ERROR && pixels.some((value, i) => i % 4 === 3 && value > 0);
  }), true, 'Firefox still draws the idle CRT with WebGL.');

  const sample = path.join(dir, 'firefox-motion.mp4');
  await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '45', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '60', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-movflags', '+faststart', sample]);
  await page.getByRole('button', {name: 'Your files', exact: true}).click();
  await page.getByLabel('Select a local video to upload', {exact: true}).setInputFiles(sample);
  const room = instance.rooms.get('lobby');
  const video = page.locator('.video-viewport > video');
  await until(async () => {
    assert.notEqual(room.current?.status, 'error', room.current?.error);
    const enable = page.getByRole('button', {name: 'Enable playback', exact: true});
    if (await enable.isVisible()) await enable.click();
    return video.evaluate(v => !v.paused && !v.seeking && v.currentTime > 1 && v.readyState >= 3);
  }, 25000);
  const viewport = page.locator('.video-viewport');
  assert.equal(await viewport.getAttribute('data-renderer'), 'native');
  assert.equal(await viewport.getAttribute('data-effects-renderer'), 'webgl');
  assert.equal(await video.evaluate(v => getComputedStyle(v).opacity), '1');
  assert.equal(await canvas.evaluate(c => getComputedStyle(c).opacity), '1');
  assert.equal(await canvas.evaluate(c => getComputedStyle(c).backgroundColor), 'rgba(0, 0, 0, 0)');
  assert.equal(await canvas.evaluate(hasWebglOverlay), false, 'The WebGL overlay is transparent without effects.');
  const progress = await video.evaluate(async video => {
    const before = video.getVideoPlaybackQuality();
    const position = video.currentTime;
    let seeks = 0;
    const seeking = () => seeks++;
    video.addEventListener('seeking', seeking);
    await new Promise(resolve => setTimeout(resolve, 2000));
    video.removeEventListener('seeking', seeking);
    const after = video.getVideoPlaybackQuality();
    return {elapsed: video.currentTime - position, seeks,
      frames: after.totalVideoFrames - before.totalVideoFrames,
      dropped: after.droppedVideoFrames - before.droppedVideoFrames,
      uploads: window.videoTextureUploads, requests: window.videoFrameRequests};
  });
  assert.ok(progress.elapsed > 1.5, JSON.stringify(progress));
  assert.ok(progress.frames > 30, JSON.stringify(progress));
  assert.equal(progress.seeks, 0, 'Steady playback does not repeatedly seek.');
  assert.equal(progress.uploads, 0, 'Native playback does not copy video into WebGL.');
  assert.equal(progress.requests, 0, 'Native playback does not depend on frame callbacks.');
  const actual = await video.evaluate(v => v.currentTime);
  assert.ok(Math.abs(actual + (room.current.media.baseTime || 0) - targetPosition(room)) < 1);
  t.diagnostic(`Firefox ${browser.version()}: ${JSON.stringify(progress)}`);

  await viewport.hover();
  await page.getByRole('button', {name: 'Pause for everyone', exact: true}).click();
  await until(async () => room.playback.paused && await video.evaluate(v => v.paused));
  await page.getByRole('slider', {name: 'Seek shared video', exact: true}).evaluate(slider => {
    slider.value = '12';
    slider.dispatchEvent(new Event('input', {bubbles: true}));
    slider.dispatchEvent(new Event('change', {bubbles: true}));
  });
  await until(async () => await video.evaluate(v => !v.seeking && Math.abs(v.currentTime - 12) < .1 &&
    v.buffered.length && v.buffered.end(v.buffered.length - 1) > 15));
  const revision = room.playback.revision;
  const hasOverlay = () => canvas.evaluate(hasWebglOverlay);
  const joystick = page.getByRole('slider', {name: 'Relative seek joystick', exact: true});
  await joystick.focus();
  await page.keyboard.down('ArrowRight');
  await page.locator('.seek-preview-label').waitFor();
  assert.equal(await hasOverlay(), true, 'The preview overlays native video.');
  assert.ok(Math.abs(await video.evaluate(v => v.currentTime) - 12) < .1);
  assert.equal(room.playback.revision, revision, 'Preview does not seek the shared player.');
  await page.keyboard.press('Escape');
  await page.keyboard.up('ArrowRight');
  await page.locator('.seek-preview-label').waitFor({state: 'hidden'});
  assert.equal(await hasOverlay(), false);
  const ball = page.getByRole('button', {name: 'Beach ball', exact: true});
  await ball.click();
  await until(hasOverlay);
  assert.equal(room.playback.revision, revision);
  await canvas.evaluate(canvas => {
    const extension = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
    return new Promise(resolve => {
      canvas.addEventListener('webglcontextrestored', resolve, {once: true});
      canvas.addEventListener('webglcontextlost', () => setTimeout(() => extension.restoreContext(), 100), {once: true});
      extension.loseContext();
    });
  });
  assert.equal(await viewport.getAttribute('data-renderer'), 'native');
  assert.equal(await viewport.getAttribute('data-effects-renderer'), 'webgl');
  assert.equal(await hasOverlay(), true, 'Context restoration keeps native-video effects visible.');
  assert.equal(await page.locator('.player-effects').evaluate(canvas =>
    canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.every(value => value === 0)), true,
    'Context restoration clears the fallback overlay.');
  await page.setViewportSize({width: 390, height: 844});
  await until(hasOverlay);
  assert.equal(await video.evaluate(v => getComputedStyle(v).opacity), '1');
  await ball.click();
  await until(async () => !await hasOverlay());
  await page.getByRole('button', {name: 'Play for everyone', exact: true}).click();
  await until(async () => await video.evaluate(v => !v.paused && v.currentTime > 13));
  assert.equal(await page.evaluate(() => window.videoTextureUploads), 0);
  assert.deepEqual(errors, []);
});
