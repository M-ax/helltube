import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';
import {JPEG_LIFETIME_MS, JPEG_AUDIO_MS} from '../src/lib/jpeg.js';

test('Hank JPEG shares audio and progressively compresses live video without changing playback', {timeout: 60000}, async t => {
    const {instance, url, dir} = await start(t);
    instance.rooms.create('Quiet room');
    const sample = path.join(dir, 'jpeg.mp4');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-t', '60', '-c:v', 'libx264',
        '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', sample]);
    instance.app.get('/jpeg-fixture.mp4', (req, res) => res.sendFile(sample, {dotfiles: 'allow'}));
    t.mock.method(instance.twitch, 'resolve', async () => ({duration: 60,
        inputs: [{url: `${url}/jpeg-fixture.mp4`, headers: {}}]}));
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 900, height: 800}});
    const errors = [];
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.jpegSounds = [];
            window.jpegStops = 0;
            window.jpegEncodes = [];
            const start = AudioBufferSourceNode.prototype.start;
            const stop = AudioBufferSourceNode.prototype.stop;
            AudioBufferSourceNode.prototype.start = function (...args) {
                window.jpegSounds.push({at: Date.now(), duration: this.buffer.duration});
                return start.apply(this, args);
            };
            AudioBufferSourceNode.prototype.stop = function (...args) {
                window.jpegStops++;
                return stop.apply(this, args);
            };
            const encode = HTMLCanvasElement.prototype.toBlob;
            HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
                if (type === 'image/jpeg') window.jpegEncodes.push({width: this.width, height: this.height, quality});
                return encode.call(this, callback, type, quality);
            };
        });
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
        await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
        assert.equal(await page.evaluate(() => performance.getEntriesByType('resource')
            .some(entry => entry.name.endsWith('/sounds/hank-jpeg.mp3'))), false);
    }
    const room = instance.rooms.get('lobby');
    const item = makeItem({kind: 'twitch', url: 'https://twitch.tv/videos/12345'}, {duration: 60, title: 'JPEG test picture'});
    instance.rooms.add(room, [item]);
    await until(async () => (await Promise.all([a, b].map(page => page.locator('.video-viewport > video')
        .evaluate(video => video.readyState >= 2 && !video.paused)))).every(Boolean), 15000);
    const revision = room.playback.revision;
    const effect = page => page.locator('[data-reaction="jpeg"]');
    const button = page => page.getByRole('button', {name: 'do i look like i know what a jpeg is', exact: true});
    const enabled = page => page.getByRole('switch', {name: 'Enable reactions on this device'});
    const mute = page => page.getByRole('button', {name: 'Mute reaction sounds', exact: true});
    const position = () => a.locator('.video-viewport > video').evaluate(video => video.currentTime);
    const before = await position();
    await button(a).click();
    await effect(b).waitFor();
    assert.equal(await effect(a).getAttribute('data-reaction-id'), await effect(b).getAttribute('data-reaction-id'));
    await until(async () => await a.evaluate(() => window.jpegSounds.length) === 1
        && await b.evaluate(() => window.jpegSounds.length) === 1);
    const sounds = await Promise.all([a, b].map(page => page.evaluate(() => window.jpegSounds[0])));
    assert.ok(Math.abs(sounds[0].at - sounds[1].at) < 250);
    assert.ok(Math.abs(sounds[0].duration * 1000 - JPEG_AUDIO_MS) < 100, 'The bundled clip matches the visual timeline.');
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/jpeg-start.png'});
    await until(async () => await effect(a).evaluate(node => Number(node.dataset.progress) >= .9));
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/jpeg-destroyed.png'});
    for (const page of [a, b]) {
        const encodes = await page.evaluate(() => window.jpegEncodes);
        assert.ok(encodes.length > 15, 'Compression keeps sampling moving video.');
        assert.ok(encodes[0].width > encodes.at(-1).width * 8);
        assert.ok(encodes[0].quality > encodes.at(-1).quality * 20, 'Real JPEG quality degrades alongside resolution.');
        const pixels = await effect(page).evaluate(node => {
            const data = node.getContext('2d').getImageData(0, 0, node.width, node.height).data;
            return {colored: data.filter((value, i) => i % 4 !== 3 && value > 30).length,
                pointerEvents: getComputedStyle(node).pointerEvents};
        });
        assert.ok(pixels.colored > 100, 'The canvas contains the decoded video frame.');
        assert.equal(pixels.pointerEvents, 'none');
    }
    await until(async () => await effect(a).count() === 0 && await effect(b).count() === 0);
    assert.ok(await position() > before + 4, 'Video keeps advancing under the overlay.');
    assert.equal(room.playback.revision, revision);

    await mute(b).click();
    await button(a).click();
    await until(async () => await a.evaluate(() => window.jpegSounds.length) === 2);
    await effect(b).waitFor();
    assert.equal(await b.evaluate(() => window.jpegSounds.length), 1, 'Mute is local and preserves the effect.');
    const previousId = await effect(a).getAttribute('data-reaction-id');
    await button(a).click();
    await until(async () => await effect(a).getAttribute('data-reaction-id') !== previousId);
    assert.equal(await effect(a).count(), 1, 'Repeated clicks replace the active compressor.');
    assert.ok(await a.evaluate(() => window.jpegStops) >= 1);
    await until(async () => await a.evaluate(() => window.jpegSounds.length) === 3);
    await enabled(a).click();
    assert.equal(await effect(a).count(), 0);
    assert.ok(await a.evaluate(() => window.jpegStops) >= 2);
    await button(b).click();
    await effect(b).waitFor();
    assert.equal(await effect(a).count(), 0);
    await enabled(a).click();
    assert.equal(await effect(a).count(), 0, 'Re-enabling never replays ignored reactions.');
    await b.setViewportSize({width: 320, height: 844});
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    const emit = (id, age) => instance.reactions.broadcast('lobby', {type: 'reaction', roomId: 'lobby', id,
        kind: 'jpeg', userId: instance.accounts.users[0].id, x: .5, y: .65, serverTime: Date.now() - age});
    emit('late-jpeg', JPEG_LIFETIME_MS - 900);
    await effect(a).waitFor();
    await until(async () => await effect(a).count() === 0);
    assert.equal(await a.evaluate(() => window.jpegSounds.length), 3, 'Late events do not replay the line.');
    await button(a).click();
    await until(async () => await a.evaluate(() => window.jpegSounds.length) === 4);
    const stops = await a.evaluate(() => window.jpegStops);
    await a.evaluate(() => {
        Object.defineProperty(document, 'hidden', {configurable: true, value: true});
        document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.ok(await a.evaluate(() => window.jpegStops) > stops);
    const encodes = await a.evaluate(() => window.jpegEncodes.length);
    await a.waitForTimeout(200);
    assert.equal(await a.evaluate(() => window.jpegEncodes.length), encodes, 'Hidden tabs stop encoding.');
    await a.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    await a.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^Quiet room/}).click();
    await until(async () => await effect(a).count() === 0);
    assert.equal(room.playback.revision, revision);
    assert.deepEqual(errors, []);
});
