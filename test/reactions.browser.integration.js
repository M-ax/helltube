import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {createBeachBall, ballArena} from '../shared/beach-ball.js';

test('two browsers share positioned reactions, audio, cursor physics and late-join state', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 1100, height: 900}});
    const errors = [];
    const messages = new Map([[a, []], [b, []]]);
    const join = async page => {
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
        await page.getByRole('region', {name: 'Reactions', exact: true}).waitFor();
    };
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        page.on('websocket', ws => ws.on('framereceived', frame => {
            try { messages.get(page).push(JSON.parse(frame.payload)); } catch { /* Ignore non-JSON frames. */ }
        }));
        await page.addInitScript(() => {
            window.reactionSounds = 0;
            window.decodedSounds = 0;
            const start = AudioBufferSourceNode.prototype.start;
            AudioBufferSourceNode.prototype.start = function (...args) {
                window.reactionSounds++;
                return start.apply(this, args);
            };
            const decode = BaseAudioContext.prototype.decodeAudioData;
            BaseAudioContext.prototype.decodeAudioData = function (...args) {
                return decode.apply(this, args).then(buffer => { window.decodedSounds++; return buffer; });
            };
        });
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await join(page);
        await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
        await until(async () => await page.evaluate(() => window.decodedSounds > 0));
    }
    const geometry = await a.locator('.reactions-panel').evaluate(panel => ({
        outside: !panel.closest('.player-shell'),
        below: panel.getBoundingClientRect().top >= document.querySelector('.player-shell').getBoundingClientRect().bottom,
    }));
    assert.deepEqual(geometry, {outside: true, below: true});
    const ballA = a.getByRole('button', {name: 'Beach ball', exact: true});
    const ballB = b.getByRole('button', {name: 'Beach ball', exact: true});
    await ballA.click();
    await until(async () => await ballB.getAttribute('aria-pressed') === 'true');
    const ballState = instance.reactions.rooms.get('lobby');
    assert.ok(ballState);
    assert.equal(await b.locator('.player-effects').evaluate(canvas => {
        const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        return pixels.some((value, index) => index % 4 === 3 && value >= 240);
    }), true, 'The shared ball is visible and nearly opaque even without playing video.');

    const marker = a.getByRole('button', {name: 'MW2 hit marker', exact: true});
    await marker.click();
    assert.equal(await marker.getAttribute('aria-pressed'), 'true');
    const target = a.locator('.hitmarker-target');
    const targetBounds = await target.boundingBox();
    await target.click({position: {x: targetBounds.width * .31, y: targetBounds.height * .28}});
    await until(async () => await b.locator('[data-reaction="hitmarker"]').count() === 1);
    const hitA = messages.get(a).find(message => message.type === 'reaction' && message.kind === 'hitmarker');
    const hitB = messages.get(b).find(message => message.type === 'reaction' && message.kind === 'hitmarker');
    assert.deepEqual(hitA, hitB);
    assert.ok(Math.abs(hitA.x - .31) < .005 && Math.abs(hitA.y - .28) < .005);
    const rendered = await b.locator('[data-reaction="hitmarker"]').evaluate(node => ({left: parseFloat(node.style.left), top: parseFloat(node.style.top)}));
    assert.ok(Math.abs(rendered.left - 31) < .5 && Math.abs(rendered.top - 28) < .5);
    await until(async () => await a.evaluate(() => window.reactionSounds) === 1 && await b.evaluate(() => window.reactionSounds) === 1);
    assert.equal(await marker.getAttribute('aria-pressed'), 'false');
    await a.screenshot({path: 'test-artifacts/reactions-desktop.png', fullPage: true});
    await until(async () => await b.locator('[data-reaction="hitmarker"]').count() === 0);

    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    await marker.click();
    await target.press('ArrowRight');
    await target.press('Enter');
    await until(async () => await a.evaluate(() => window.reactionSounds) === 2);
    assert.equal(await b.evaluate(() => window.reactionSounds), 1, 'Sound mute is local.');
    const keyboardHit = messages.get(b).filter(message => message.type === 'reaction' && message.kind === 'hitmarker').at(-1);
    assert.equal(keyboardHit.x, .53);
    await marker.click();
    await target.press('Escape');
    assert.equal(await target.count(), 0);
    for (const [label, kind] of [['Love', 'heart'], ['Laugh', 'laugh'], ['Applause', 'clap']]) {
        await a.getByRole('button', {name: label, exact: true}).click();
        await b.locator(`[data-reaction="${kind}"]`).waitFor();
    }

    // Place the real server-owned ball in the path of each user's browser cursor.
    for (const page of [a, b]) {
        ballState.ball = {...createBeachBall(), x: 1100, y: 400, vx: 0, vy: 0};
        ballState.pointers.clear();
        const bounds = await page.locator('.video-viewport').boundingBox();
        const inset = await page.locator('.video-viewport').evaluate(node => parseFloat(getComputedStyle(node).getPropertyValue('--controls-height')));
        const arena = ballArena(bounds.width, bounds.height, inset);
        await page.mouse.move(bounds.x + arena.x + 1100 * arena.scale, bounds.y + arena.y + 580 * arena.scale);
        await until(() => ballState.pointers.size > 0);
        await new Promise(resolve => setTimeout(resolve, 80));
        await page.mouse.move(bounds.x + arena.x + 1100 * arena.scale, bounds.y + arena.y + 300 * arena.scale);
        await until(() => ballState.ball.vy < -300);
        await page.mouse.move(0, 0);
    }
    await until(() => messages.get(b).some(message => message.type === 'reactions:state' && message.ball?.vy < -300));
    assert.equal(instance.rooms.get('lobby').playback.revision, 0, 'Reactions never change video playback.');
    await b.reload();
    await join(b);
    await until(async () => await ballB.getAttribute('aria-pressed') === 'true');
    assert.equal(await b.locator('.player-reaction').count(), 0);
    assert.equal(await b.evaluate(() => window.reactionSounds), 0, 'Reload never replays a sound.');
    await b.setViewportSize({width: 320, height: 844});
    await b.locator('.reactions-panel').scrollIntoViewIfNeeded();
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await b.screenshot({path: 'test-artifacts/reactions-mobile.png', fullPage: true});
    await ballB.click();
    await until(async () => await ballA.getAttribute('aria-pressed') === 'false');
    assert.deepEqual(errors, []);
});
