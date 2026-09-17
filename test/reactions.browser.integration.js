import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {createBeachBall, ballArena} from '../shared/beach-ball.js';
import {FLASH_DETONATE_MS, FLASH_LIFETIME_MS} from '../src/lib/flashbang.js';

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
            window.pipeImpacts = [];
            window.decodedSounds = 0;
            const start = AudioBufferSourceNode.prototype.start;
            AudioBufferSourceNode.prototype.start = function (...args) {
                window.reactionSounds++;
                if (this.buffer?.duration > .5) {
                    const pipe = document.querySelector('.falling-metal-pipe');
                    const viewport = document.querySelector('.video-viewport');
                    window.pipeImpacts.push({at: Date.now(), bottom: pipe?.getBoundingClientRect().bottom,
                        floor: viewport?.getBoundingClientRect().bottom});
                }
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
        await until(async () => await page.evaluate(() => window.decodedSounds === 4));
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

    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    const pipeButton = a.getByRole('button', {name: 'Metal pipe', exact: true});
    await pipeButton.click();
    await b.locator('[data-reaction="metalpipe"]').waitFor();
    for (const page of [a, b]) {
        assert.equal(await page.evaluate(() => window.pipeImpacts.length), 0, 'A falling pipe is silent before impact.');
    }
    await until(async () => await a.evaluate(() => window.pipeImpacts.length) === 1 && await b.evaluate(() => window.pipeImpacts.length) === 1);
    const impacts = await Promise.all([a, b].map(page => page.evaluate(() => window.pipeImpacts[0])));
    for (const impact of impacts) assert.ok(Math.abs(impact.bottom - impact.floor) < 1, 'The sound starts with the pipe touching the player bottom.');
    assert.ok(Math.abs(impacts[0].at - impacts[1].at) < 120, 'Both viewers hear the same shared impact.');
    const pipeMessage = messages.get(a).filter(message => message.kind === 'metalpipe').at(-1);
    assert.ok(impacts[0].at - pipeMessage.serverTime >= 850, 'The clang is delayed until the end of the fall.');
    await b.screenshot({path: 'test-artifacts/metal-pipe-impact.png', fullPage: true});
    await until(async () => await b.locator('[data-reaction="metalpipe"]').count() === 0);
    assert.equal(await a.evaluate(() => window.pipeImpacts.length), 1, 'Each drop makes exactly one sound.');

    await pipeButton.click();
    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    await until(async () => await a.evaluate(() => window.pipeImpacts.length) === 2);
    assert.equal(await b.evaluate(() => window.pipeImpacts.length), 1, 'Muting during the fall silences the upcoming impact.');
    await until(async () => await a.locator('[data-reaction="metalpipe"]').count() === 0);

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

test('flashbang bounces and rings in sync, fades over the player, and obeys local controls', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 900, height: 800}});
    const errors = [];
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.flashSounds = [];
            window.flashStops = 0;
            window.decodedSounds = 0;
            const start = AudioBufferSourceNode.prototype.start;
            const stop = AudioBufferSourceNode.prototype.stop;
            AudioBufferSourceNode.prototype.start = function (...args) {
                const grenade = document.querySelector('.flying-flashbang');
                const viewport = document.querySelector('.video-viewport');
                window.flashSounds.push({kind: this.buffer.duration < .5 ? 'bounce' : 'ring', at: Date.now(),
                    bottom: grenade?.getBoundingClientRect().bottom, floor: viewport?.getBoundingClientRect().bottom,
                    whiteout: Number(document.querySelector('.flashbang-whiteout')?.style.opacity)});
                return start.apply(this, args);
            };
            AudioBufferSourceNode.prototype.stop = function (...args) {
                window.flashStops++;
                return stop.apply(this, args);
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
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
        await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
        await until(async () => await page.evaluate(() => window.decodedSounds === 4));
    }
    const throwFlash = a.getByRole('button', {name: 'Flashbang', exact: true});
    const flash = page => page.locator('[data-reaction="flashbang"]');
    const opacity = page => page.locator('.flashbang-whiteout').evaluate(node => Number(node.style.opacity));
    await throwFlash.click();
    await flash(b).waitFor();
    const id = await flash(a).getAttribute('data-reaction-id');
    assert.equal(await flash(b).getAttribute('data-reaction-id'), id);
    assert.equal(await opacity(a), 0);
    assert.equal(await a.evaluate(() => window.flashSounds.length), 0, 'The throw is silent until floor contact.');
    await until(async () => await a.evaluate(() => window.flashSounds.length) === 4
        && await b.evaluate(() => window.flashSounds.length) === 4);
    const sounds = await Promise.all([a, b].map(page => page.evaluate(() => window.flashSounds)));
    for (const events of sounds) {
        assert.deepEqual(events.map(event => event.kind), ['bounce', 'bounce', 'bounce', 'ring']);
        for (const event of events.slice(0, 3)) {
            assert.ok(Math.abs(event.bottom - event.floor) < 1, 'Each collision sounds while the grenade touches the floor.');
            assert.equal(event.whiteout, 0);
        }
        assert.equal(events[3].whiteout, 1, 'Ringing starts on the whiteout frame.');
    }
    for (let index = 0; index < 4; index++) {
        assert.ok(Math.abs(sounds[0][index].at - sounds[1][index].at) < 150, 'Both viewers share the same effect timing.');
    }
    assert.equal(await a.locator('.flashbang-reaction').evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    await a.screenshot({path: 'test-artifacts/flashbang-whiteout.png', fullPage: true});
    await until(async () => await opacity(a) < .7);
    assert.ok(await opacity(a) > 0);
    await a.screenshot({path: 'test-artifacts/flashbang-fade.png', fullPage: true});
    await until(async () => await flash(a).count() === 0 && await flash(b).count() === 0);

    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    await throwFlash.click();
    await until(async () => await a.evaluate(() => window.flashSounds.length) === 8);
    assert.equal(await b.evaluate(() => window.flashSounds.length), 4, 'Reaction mute silences bounces and ringing locally.');
    assert.ok(await opacity(b) > .9, 'Muting sound keeps the shared whiteout visible.');
    await a.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    assert.ok(await a.evaluate(() => window.flashStops) >= 1, 'Muting stops ringing that is already playing.');
    await a.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    assert.equal(await flash(a).count(), 0, 'Turning reactions off immediately clears the whiteout.');
    await until(async () => await flash(b).count() === 0);
    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    await b.getByRole('button', {name: 'Flashbang', exact: true}).click();
    await flash(b).waitFor();
    assert.equal(await flash(a).count(), 0, 'Disabled reactions ignore incoming flashbangs.');
    await a.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    assert.equal(await flash(a).count(), 0, 'Enabling reactions never replays an ignored flashbang.');
    await b.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    assert.equal(await flash(b).count(), 0);

    // An old network event must resume its fade without replaying collisions or the bang.
    await a.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    const before = await a.evaluate(() => window.flashSounds.length);
    instance.reactions.broadcast('lobby', {type: 'reaction', roomId: 'lobby', id: 'late-flash', kind: 'flashbang',
        userId: instance.accounts.users[0].id, x: .5, y: .65,
        serverTime: Date.now() - FLASH_DETONATE_MS - 1500});
    await flash(a).waitFor();
    assert.ok(await opacity(a) > 0 && await opacity(a) < .8);
    assert.equal(await a.evaluate(() => window.flashSounds.length), before);
    await until(async () => await flash(a).count() === 0);
    instance.reactions.broadcast('lobby', {type: 'reaction', roomId: 'lobby', id: 'expired-flash', kind: 'flashbang',
        userId: instance.accounts.users[0].id, x: .5, y: .65,
        serverTime: Date.now() - FLASH_LIFETIME_MS - 1000});
    await a.getByRole('heading', {name: 'Reactions', exact: true}).click();
    assert.equal(await flash(a).count(), 0);
    assert.equal(instance.rooms.get('lobby').playback.revision, 0);
    assert.deepEqual(errors, []);
});
