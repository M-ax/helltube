import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('audio-only HLS uses the player WebGL, switches MilkDrop presets, and keeps Spotify local', {timeout: 90000}, async t => {
    const {instance, dir, url} = await start(t);
    const fixture = path.join(dir, 'audio.mp3');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=45', '-y', fixture]);
    instance.app.get('/audio-fixture.mp3', (_req, res) => res.sendFile(fixture, {dotfiles: 'allow'}));
    t.mock.method(instance.soundcloud, 'extract', async () => ({title: 'Audio test', duration: 45, uploader: 'Test artist', webpage_url: 'https://soundcloud.com/test/audio'}));
    t.mock.method(instance.soundcloud, 'resolve', async () => ({inputs: [{url: `${url}/audio-fixture.mp3`, headers: {}}], duration: 45}));
    instance.capabilities.soundcloud = true;
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1280, height: 1000}});
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
        window.audioSourcesCreated = 0;
        const original = AudioContext.prototype.createMediaElementSource;
        AudioContext.prototype.createMediaElementSource = function (...args) {
            window.audioSourcesCreated++;
            return original.apply(this, args);
        };
    });
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.locator('#youtube-url').fill('https://soundcloud.com/test/audio');
    await page.getByRole('button', {name: 'Add to queue', exact: true}).click();
    const room = instance.rooms.get('lobby');
    await until(() => room.current?.status === 'ready', 20000);
    const library = page.getByLabel('Audio visualization library');
    await library.waitFor();
    await page.waitForFunction(() => document.querySelector('.video-viewport').dataset.effectsRenderer === 'webgl');
    await page.waitForFunction(() => { const video = document.querySelector('.video-viewport > video'); return video.readyState >= 2 && !video.paused && video.currentTime > 0; });
    assert.equal(await page.locator('video').evaluate(video => video.videoWidth), 0);
    for (const name of ['Spectrum · fire', 'Spectrum · line', 'Oscilloscope · lines', 'Oscilloscope · dots', 'Oscilloscope · solid', 'Spectrum · normal']) {
        await library.getByRole('button', {name, exact: true}).click();
        assert.equal(await library.getByRole('button', {name, exact: true}).getAttribute('aria-pressed'), 'true');
    }
    await page.waitForFunction(() => window.audioSourcesCreated === 1);
    await library.locator('summary').click();
    const presets = library.getByLabel('MilkDrop preset', {exact: true});
    await presets.waitFor();
    assert.ok(await presets.locator('option').count() > 300);
    const name = await presets.locator('option').first().getAttribute('value');
    await page.evaluate(async () => {
        const resource = performance.getEntriesByType('resource').find(entry => /\/butterchurn-[^/]+\.js/.test(entry.name));
        const module = await import(resource.name);
        const engine = Object.values(module).map(value => value.default || value).find(value => value.createVisualizer);
        const create = engine.createVisualizer;
        window.milkdropFrames = [];
        engine.createVisualizer = function (...args) {
            const visualizer = create.apply(this, args);
            const render = visualizer.render;
            visualizer.render = function (options) {
                const result = render.call(this, options);
                window.milkdropFrames.push({at: performance.now(), time: this.renderer.time});
                return result;
            };
            return visualizer;
        };
    });
    await presets.selectOption(name);
    await library.locator('.preset-name').filter({hasText: name}).waitFor();
    await page.waitForTimeout(1200);
    assert.deepEqual(await library.locator('.form-error').allTextContents(), []);
    const measureMilkdrop = async () => {
        await page.evaluate(() => { window.milkdropFrames.length = 0; });
        await page.waitForTimeout(1800);
        return page.evaluate(() => {
            const frames = window.milkdropFrames;
            const first = frames[0], last = frames.at(-1);
            const seconds = (last.at - first.at) / 1000;
            return {fps: (frames.length - 1) / seconds, speed: (last.time - first.time) / seconds};
        });
    };
    const baseline = await measureMilkdrop();
    await page.getByRole('button', {name: 'Beach ball', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('.video-viewport').dataset.beachBall === 'true');
    // Extra invalidations mimic incoming ball snapshots and other overlay updates.
    await page.evaluate(() => { window.reactionRedraws = setInterval(() => window.dispatchEvent(new Event('resize')), 5); });
    const withBall = await measureMilkdrop();
    await page.evaluate(() => clearInterval(window.reactionRedraws));
    await page.getByRole('button', {name: 'Beach ball', exact: true}).click();
    const afterBall = await measureMilkdrop();
    for (const [label, metrics] of Object.entries({baseline, withBall, afterBall})) {
        assert.ok(metrics.fps <= 31, `${label}: MilkDrop stays near 30 fps, got ${metrics.fps}`);
        assert.ok(metrics.speed > 0.4 && metrics.speed < 1.35, `${label}: preset clock tracks real time, got ${metrics.speed}x`);
    }
    assert.ok(Math.abs(withBall.speed - baseline.speed) < 0.3, 'The beachball cannot accelerate the visualizer');
    assert.equal(await page.locator('video').evaluate(video => video.paused), false);
    t.diagnostic(`MilkDrop speed before/during/after beachball: ${[baseline, withBall, afterBall].map(value => value.speed.toFixed(2) + 'x').join(', ')}`);
    await library.getByRole('button', {name: 'Random preset', exact: true}).click();
    await page.waitForTimeout(500);
    assert.deepEqual(await library.locator('.form-error').allTextContents(), []);
    await page.screenshot({path: 'test-artifacts/audio-visualizations.png', fullPage: true});
    await library.getByRole('button', {name: 'Spectrum · normal', exact: true}).click();
    const colored = await page.locator('.video-canvas').evaluate(canvas => {
        window.dispatchEvent(new Event('resize'));
        const gl = canvas.getContext('webgl');
        const pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        return pixels.some((value, i) => i % 4 === 1 && value > 100);
    });
    assert.equal(colored, true, 'Real audio produces lit spectrum bars in the existing player canvas.');
    await page.locator('.video-canvas').evaluate(canvas => {
        const context = canvas.getContext('webgl').getExtension('WEBGL_lose_context');
        context.loseContext();
        setTimeout(() => context.restoreContext(), 150);
    });
    await page.waitForFunction(() => document.querySelector('.video-viewport').dataset.effectsRenderer === 'webgl');
    await library.getByRole('button', {name: 'Turn off', exact: true}).click();
    assert.equal(await page.locator('video').evaluate(video => video.paused), false);
    await page.getByRole('button', {name: 'Pause for everyone', exact: true}).click();
    await page.waitForFunction(() => document.querySelector('video').paused);
    await library.getByRole('button', {name: 'Turn on', exact: true}).click();
    await page.getByRole('button', {name: 'Play for everyone', exact: true}).click();
    await page.waitForFunction(() => !document.querySelector('video').paused);
    assert.equal(await page.evaluate(() => window.audioSourcesCreated), 1);
    await page.setViewportSize({width: 390, height: 844});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({path: 'test-artifacts/audio-visualizations-mobile.png', fullPage: true});
    await page.route('https://open.spotify.com/embed/**', route => route.fulfill({contentType: 'text/html', body: '<p>Spotify embed fixture</p>'}));
    const item = (await instance.spotify.items('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', {displayName: 'Test'}))[0];
    instance.rooms.add(room, [item]);
    instance.rooms.advance(room);
    await page.getByTitle('Spotify player', {exact: true}).waitFor();
    await page.waitForFunction(() => {
        const player = document.querySelector('.spotify-player').getBoundingClientRect();
        const controls = document.querySelector('.player-controls').getBoundingClientRect();
        return player.bottom <= controls.top;
    });
    assert.equal(instance.media.jobs.has(item.id), false);
    assert.equal(await page.getByRole('button', {name: 'Play for everyone', exact: true}).count(), 0);
    assert.equal(await page.getByLabel('Volume on this device', {exact: true}).count(), 0);
    assert.equal(await page.getByText('Spotify keeps its audio private. Effects are ambient, without beat detection.', {exact: true}).count(), 1);
    await page.screenshot({path: 'test-artifacts/spotify-player-mobile.png', fullPage: true});
    assert.deepEqual(errors, []);
});
