import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {createBeachBall, ballArena} from '../shared/beach-ball.js';
import {FLASH_DETONATE_MS, FLASH_LIFETIME_MS} from '../src/lib/flashbang.js';
import {BIDEN_LIFETIME_MS, bidenSound} from '../src/lib/biden.js';

test('pointing fingers track locally, stream at 60Hz, tap and slide together, and clean up', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 1000, height: 900}});
    const errors = [];
    const outgoing = [];
    a.on('websocket', ws => ws.on('framesent', frame => {
        const message = JSON.parse(frame.payload);
        if (message.type === 'reaction:pointer') outgoing.push({at: Date.now(), ...message});
    }));
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.fingerAudio = {taps: 0, slides: 0, active: 0};
            const active = new Set();
            const start = AudioBufferSourceNode.prototype.start;
            const stop = AudioBufferSourceNode.prototype.stop;
            AudioBufferSourceNode.prototype.start = function (...args) {
                if (this.loop) { window.fingerAudio.slides++; active.add(this); window.fingerAudio.active = active.size; }
                else if (this.buffer?.duration > .104 && this.buffer.duration < .106) window.fingerAudio.taps++;
                return start.apply(this, args);
            };
            AudioBufferSourceNode.prototype.stop = function (...args) {
                active.delete(this); window.fingerAudio.active = active.size;
                return stop.apply(this, args);
            };
        });
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
        await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
    }
    const finger = page => page.locator('.pointing-fingers');
    const fingerButton = page => page.getByRole('button', {name: 'Pointing finger', exact: true});
    await fingerButton(a).click();
    await a.locator('.video-viewport').scrollIntoViewIfNeeded();
    const rect = await a.locator('.video-viewport').boundingBox();
    const at = (x, y) => ({x: rect.x + x * rect.width, y: rect.y + y * rect.height});
    await a.mouse.move(rect.x - 5, at(0, .3).y);
    await a.mouse.move(at(.002, .3).x, at(0, .3).y);
    await a.mouse.move(at(.65, .4).x, at(.65, .4).y, {steps: 12});
    await until(async () => await finger(b).getAttribute('data-finger-count') === '1');
    const pivot = outgoing.find(value => value.finger)?.finger.pivot;
    assert.ok(pivot.x < 0, 'The pivot is just off the entry edge.');
    assert.ok(Math.abs(Number(await finger(a).getAttribute('data-local-x')) - .65) < .003);
    const begin = Date.now();
    await a.waitForTimeout(1600);
    const stream = outgoing.filter(value => value.at >= begin && value.finger);
    assert.ok(stream.length >= 76 && stream.length <= 110, `60Hz stationary stream produced ${stream.length} samples in 1.6s`);
    assert.ok(stream.every(value => value.finger.pivot.x === pivot.x && value.finger.pivot.y === pivot.y));
    assert.equal(await finger(a).getAttribute('data-finger-count'), '1', 'The sender does not draw a duplicate network echo.');
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/pointing-finger.png'});
    await b.locator('.video-viewport').screenshot({path: 'test-artifacts/pointing-finger-shared.png'});
    await a.mouse.down();
    await until(async () => await b.evaluate(() => window.fingerAudio.taps) === 1);
    assert.equal(await a.evaluate(() => window.fingerAudio.taps), 1, 'Local tap plays once without its echoed sound.');
    assert.equal(await a.evaluate(() => window.fingerAudio.slides), 0, 'Holding still never slides.');
    for (let i = 0; i < 12; i++) {
        await a.mouse.move(at(.65 + i * .015, .4 + i * .008).x, at(.65 + i * .015, .4 + i * .008).y);
        await a.waitForTimeout(18);
    }
    await until(async () => await b.evaluate(() => window.fingerAudio.slides) > 0);
    assert.ok(await a.evaluate(() => window.fingerAudio.slides) > 0);
    await until(async () => await a.evaluate(() => window.fingerAudio.active) === 0 && await b.evaluate(() => window.fingerAudio.active) === 0);
    await a.mouse.up();
    await until(async () => await finger(a).getAttribute('data-pressed') === 'false');
    // Mute applies only to this viewer; moving a held finger still streams to everyone.
    await b.getByRole('button', {name: 'Mute reaction sounds', exact: true}).click();
    const mutedTaps = await b.evaluate(() => window.fingerAudio.taps);
    await a.mouse.click(at(.6, .35).x, at(.6, .35).y);
    await until(async () => await a.evaluate(() => window.fingerAudio.taps) === 2);
    await a.waitForTimeout(150);
    assert.equal(await b.evaluate(() => window.fingerAudio.taps), mutedTaps);
    await a.keyboard.press('Escape');
    await until(async () => await finger(b).count() === 0);
    assert.equal(await fingerButton(a).getAttribute('aria-pressed'), 'false');
    assert.ok(!instance.reactions.rooms.has('lobby'));

    // Each viewer owns a separate finger; switching reactions off withdraws just that finger.
    await fingerButton(a).click();
    await a.mouse.move(at(.4, .25).x, at(.4, .25).y);
    await fingerButton(b).click();
    const other = await b.locator('.video-viewport').boundingBox();
    await b.mouse.move(other.x + other.width * .7, other.y + other.height * .2);
    await until(async () => await finger(a).getAttribute('data-finger-count') === '2');
    await b.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    await until(async () => await finger(a).getAttribute('data-finger-count') === '1');
    assert.equal(await finger(b).count(), 0);
    await a.mouse.move(rect.x - 5, rect.y + 10);
    await until(() => !instance.reactions.rooms.has('lobby'));
    assert.equal(instance.rooms.get('lobby').playback.revision, 0);
    assert.deepEqual(errors, []);
});

test('Biden wanders in sync with local audio controls, reduced motion and no stale replay', {timeout: 60000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    instance.rooms.create('Quiet room');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 900, height: 800}});
    const errors = [];
    const messages = [];
    a.on('websocket', ws => ws.on('framereceived', frame => {
        try { messages.push(JSON.parse(frame.payload)); } catch { /* Ignore non-JSON frames. */ }
    }));
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.bidenSounds = [];
            window.bidenStops = 0;
            window.decodedSounds = 0;
            const start = AudioBufferSourceNode.prototype.start;
            const stop = AudioBufferSourceNode.prototype.stop;
            AudioBufferSourceNode.prototype.start = function (...args) {
                window.bidenSounds.push({at: Date.now(), duration: this.buffer.duration});
                return start.apply(this, args);
            };
            AudioBufferSourceNode.prototype.stop = function (...args) {
                window.bidenStops++;
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
        await until(async () => await page.evaluate(() => window.decodedSounds === 6));
    }
    const joe = page => page.locator('[data-reaction="biden"]');
    const button = page => page.getByRole('button', {name: 'Joe wander', exact: true});
    const mute = page => page.getByRole('button', {name: 'Mute reaction sounds', exact: true});
    const enabled = page => page.getByRole('switch', {name: 'Enable reactions on this device'});
    await button(a).click();
    await joe(b).waitFor();
    const id = await joe(a).getAttribute('data-reaction-id');
    assert.equal(await joe(b).getAttribute('data-reaction-id'), id);
    await until(async () => await a.evaluate(() => window.bidenSounds.length) === 1
        && await b.evaluate(() => window.bidenSounds.length) === 1);
    const sounds = await Promise.all([a, b].map(page => page.evaluate(() => window.bidenSounds[0])));
    assert.equal(sounds[0].duration, sounds[1].duration, 'Everyone hears the same selected clip.');
    assert.ok(Math.abs(sounds[0].at - sounds[1].at) < 180);
    assert.equal(sounds[0].duration > 7, bidenSound(id) === 'bidenWord');
    const geometry = await joe(a).evaluate(node => {
        const image = node.querySelector('img');
        const canvas = document.createElement('canvas');
        canvas.width = 100;
        canvas.height = 200;
        canvas.getContext('2d').drawImage(image, 0, 0, 100, 200);
        const alpha = canvas.getContext('2d').getImageData(0, 0, 100, 200).data.filter((_, index) => index % 4 === 3);
        const viewport = node.parentElement;
        return {pointerEvents: getComputedStyle(node).pointerEvents,
            transparent: alpha.filter(value => value === 0).length / alpha.length,
            opaque: alpha.filter(value => value >= 240).length / alpha.length,
            bottom: image.getBoundingClientRect().bottom,
            floor: viewport.getBoundingClientRect().bottom - parseFloat(getComputedStyle(viewport).getPropertyValue('--controls-height'))};
    });
    assert.equal(geometry.pointerEvents, 'none');
    assert.ok(geometry.transparent > .2 && geometry.opaque > .2, 'The asset has a real transparent cutout.');
    assert.ok(geometry.bottom < geometry.floor + 2, 'The feet stay above the transport controls.');
    const before = await a.locator('.biden-walker').evaluate(node => node.style.left);
    await until(async () => await a.locator('.biden-walker').evaluate(node => node.style.left) !== before);
    await a.screenshot({path: 'test-artifacts/biden-desktop.png', fullPage: true});
    await b.emulateMedia({reducedMotion: 'reduce'});
    await until(async () => await b.locator('.biden-walker').getAttribute('data-walking') === 'false');
    assert.equal(await b.locator('.biden-cutout').evaluate(node => node.style.transform),
        'translateY(0px) scaleX(1) rotate(0deg) scaleY(1)');
    await b.setViewportSize({width: 320, height: 844});
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.ok((await b.locator('.biden-cutout').boundingBox()).height >= 65, 'The mobile cutout stays recognizable.');
    await b.screenshot({path: 'test-artifacts/biden-mobile.png', fullPage: true});
    await mute(b).click();
    assert.ok(await b.evaluate(() => window.bidenStops) > 0, 'Muting stops an active voice clip.');
    assert.equal(await joe(b).count(), 1, 'Mute keeps the cutout visible.');
    await enabled(a).click();
    assert.equal(await joe(a).count(), 0);
    assert.ok(await a.evaluate(() => window.bidenStops) > 0);
    await button(b).click();
    await until(async () => await joe(b).count() === 2);
    await until(async () => await b.locator('.biden-walker').last().evaluate(node => Number(node.style.opacity)) === 1);
    assert.equal(await joe(a).count(), 0, 'Disabled reactions ignore incoming walkers.');
    await enabled(a).click();
    assert.equal(await joe(a).count(), 0, 'Re-enabling does not replay ignored events.');
    await enabled(b).click();
    assert.equal(await joe(b).count(), 0);

    const emit = (id, age) => instance.reactions.broadcast('lobby', {type: 'reaction', roomId: 'lobby', id,
        kind: 'biden', userId: instance.accounts.users[0].id, x: .5, y: .65, serverTime: Date.now() - age});
    emit('late-biden', 4000);
    await joe(a).waitFor();
    await until(async () => await joe(a).count() === 0);
    assert.equal(await a.evaluate(() => window.bidenSounds.length), 1, 'A late walker expires without replaying its line.');
    assert.equal(await b.evaluate(() => window.bidenSounds.length), 1, 'Muted reactions never play queued audio.');
    emit('expired-biden', BIDEN_LIFETIME_MS + 1000);
    await until(() => messages.some(message => message.id === 'expired-biden'));
    assert.equal(await joe(a).count(), 0);
    await button(a).click();
    await until(async () => await a.evaluate(() => window.bidenSounds.length) === 2);
    const stops = await a.evaluate(() => window.bidenStops);
    await a.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^Quiet room/}).click();
    await until(async () => await joe(a).count() === 0);
    assert.ok(await a.evaluate(() => window.bidenStops) > stops, 'Leaving stops the voice and removes the walker.');
    assert.equal(instance.rooms.get('lobby').playback.revision, 0);
    assert.deepEqual(errors, []);
});

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
        await until(async () => await page.evaluate(() => window.decodedSounds === 6));
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
        await until(async () => await page.evaluate(() => window.decodedSounds === 6));
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
