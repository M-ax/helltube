import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('spray and MLG are shared, audible, keyed, persistent, locally muted, and bounded by the player lifecycle', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    instance.rooms.create('Quiet room');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 1000, height: 850}});
    const errors = [];
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.newSounds = {loops: 0, voices: 0};
            const start = AudioBufferSourceNode.prototype.start;
            const stop = AudioBufferSourceNode.prototype.stop;
            AudioBufferSourceNode.prototype.start = function (...args) {
                if (this.loop) window.newSounds.loops++;
                else if (this.buffer?.duration > 5.8) window.newSounds.voices++;
                return start.apply(this, args);
            };
            AudioBufferSourceNode.prototype.stop = function (...args) {
                if (this.loop) window.newSounds.loops--;
                return stop.apply(this, args);
            };
        });
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room/}).click();
        await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
    }
    const openTools = async () => {
        const tools = a.getByRole('region', {name: 'Whiteboard controls'});
        if (!await tools.isVisible()) await a.getByRole('button', {name: 'Whiteboard tools', exact: true}).click();
        return tools;
    };
    const tools = await openTools();
    await tools.getByRole('button', {name: 'Spray paint', exact: true}).click();
    for (const cap of ['Skinny cap', 'Fat cap', 'Soft cap', 'Chisel cap']) {
        await tools.getByRole('button', {name: cap, exact: true}).click();
        assert.equal(await tools.getByRole('button', {name: cap}).getAttribute('aria-pressed'), 'true');
    }
    await tools.getByRole('button', {name: 'Fat cap', exact: true}).click();
    await a.locator('.whiteboard-canvas').scrollIntoViewIfNeeded();
    const bounds = await a.locator('.whiteboard-canvas').boundingBox();
    await a.mouse.move(bounds.x + bounds.width * .65, bounds.y + bounds.height * .35);
    await a.mouse.down();
    await until(async () => await b.locator('[data-spray-drip]').count() > 0);
    const drip = () => instance.whiteboards.snapshot('lobby').shapes[0];
    const firstLength = await b.locator('[data-spray-drip]').first().getAttribute('d');
    await until(() => drip().points.length > 40);
    assert.notEqual(await b.locator('[data-spray-drip]').first().getAttribute('d'), firstLength);
    for (const page of [a, b]) assert.equal(await page.evaluate(() => window.newSounds.loops), 1);
    assert.equal(await a.locator('.spray-can').count(), 1);
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/spray-paint.png'});
    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    await until(async () => await b.evaluate(() => window.newSounds.loops) === 0);
    assert.equal(await a.evaluate(() => window.newSounds.loops), 1);
    await a.mouse.up();
    await until(async () => await a.evaluate(() => window.newSounds.loops) === 0 && drip().complete);
    const expected = await a.locator('[data-spray-drip]').first().getAttribute('d');
    assert.equal(await b.locator('[data-spray-drip]').first().getAttribute('d'), expected);
    await a.getByRole('button', {name: 'Finish drawing', exact: true}).click();
    await b.reload();
    await until(async () => await b.locator('[data-spray-drip]').count() === 1);
    assert.equal(await b.locator('[data-spray-drip]').first().getAttribute('d'), expected);
    assert.equal(await b.evaluate(() => window.newSounds.loops), 0, 'Reloading completed paint stays silent.');
    await b.getByRole('heading', {name: 'Reactions', exact: true}).click();
    await a.getByRole('button', {name: 'MLG Intervention', exact: true}).click();
    await until(async () => await b.locator('.mlg-reaction').evaluate(canvas => Number(canvas.dataset.frameTime) > .1));
    assert.equal(await a.locator('.mlg-reaction').getAttribute('data-reaction-id'), await b.locator('.mlg-reaction').getAttribute('data-reaction-id'));
    for (const page of [a, b]) {
        const pixels = await page.locator('.mlg-reaction').evaluate(canvas => {
            const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
            let clear = 0, opaque = 0;
            for (let i = 3; i < data.length; i += 4) { if (!data[i]) clear++; else if (data[i] > 240) opaque++; }
            return {clear, opaque};
        });
        assert.ok(pixels.clear > 10000 && pixels.opaque > 1000, 'Green is transparent and the rifle is visible.');
        assert.equal(await page.evaluate(() => window.newSounds.voices), 1);
    }
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/mlg-intervention.png'});
    await a.getByRole('button', {name: 'MLG Intervention', exact: true}).click();
    assert.equal(await a.locator('.mlg-reaction').count(), 1, 'Repeated MLG replaces rather than stacks.');
    await a.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    assert.equal(await a.locator('.mlg-reaction').count(), 0);
    assert.equal(await a.locator('[data-whiteboard-id]').count(), 0);
    assert.equal(await b.locator('.mlg-reaction').count(), 1);
    await until(async () => await b.locator('.mlg-reaction').count() === 0);
    await a.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    await (await openTools()).getByRole('button', {name: 'Undo mine'}).click();
    await until(async () => await b.locator('[data-whiteboard-id]').count() === 0);
    await a.setViewportSize({width: 390, height: 844});
    await openTools();
    assert.equal(await a.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
});
