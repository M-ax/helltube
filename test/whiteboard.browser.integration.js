import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('SVG whiteboard streams to viewers, supports every tool, and follows room and player lifecycles', {timeout: 90000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    await instance.accounts.create({username: 'artist', displayName: 'Artist', password: 'artist-password', role: 'user'});
    instance.rooms.create('Quiet room');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 1000, height: 850}, hasTouch: true});
    const errors = [];
    const outgoing = [];
    a.on('websocket', ws => ws.on('framesent', frame => {
        const message = JSON.parse(frame.payload);
        if (message.type === 'whiteboard') outgoing.push(message);
    }));
    for (const [page, username, password] of [[a, 'admin', 'garbageTime_'], [b, 'artist', 'artist-password']]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill(username);
        await page.getByLabel('Password', {exact: true}).fill(password);
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
        await page.getByRole('button', {name: 'Whiteboard', exact: true}).waitFor();
    }
    const marks = page => page.locator('[data-whiteboard-id]');
    const tools = page => page.getByRole('region', {name: 'Whiteboard controls'});
    const open = async page => {
        if (!await tools(page).count()) await page.getByRole('button', {name: 'Whiteboard tools', exact: true}).click();
    };
    const drag = async (page, from, to, release = true) => {
        await page.locator('.whiteboard-canvas').scrollIntoViewIfNeeded();
        const box = await page.locator('.whiteboard-canvas').boundingBox();
        await page.mouse.move(box.x + box.width * from[0], box.y + box.height * from[1]);
        await page.mouse.down();
        await page.mouse.move(box.x + box.width * to[0], box.y + box.height * to[1], {steps: 10});
        if (release) await page.mouse.up();
    };

    await open(a);
    await tools(a).getByRole('button', {name: 'Blue ink'}).click();
    await tools(a).getByRole('button', {name: 'Thick stroke'}).click();
    await drag(a, [.55, .3], [.85, .45], false);
    await until(async () => await marks(b).count() === 1 && instance.whiteboards.snapshot('lobby').shapes[0].points.length > 2);
    assert.equal(await marks(b).first().getAttribute('data-complete'), 'false', 'The viewer sees the stroke before pointer release.');
    assert.equal(await marks(b).locator('path').getAttribute('stroke'), '#73c7ff');
    assert.equal(await marks(b).locator('path').getAttribute('stroke-width'), '8');
    await a.mouse.up();
    await until(async () => await marks(b).first().getAttribute('data-complete') === 'true');
    assert.ok(outgoing.filter(value => value.action === 'draw').every(value => value.points.length <= 32));
    assert.equal(instance.rooms.get('lobby').playback.revision, 0);

    for (const [name, tool] of [['Line', 'line'], ['Arrow', 'arrow'], ['Rectangle', 'rectangle'], ['Circle', 'ellipse']]) {
        await open(a);
        await tools(a).getByRole('button', {name, exact: true}).click();
        await drag(a, [.58, .5], [.87, .65]);
        await until(async () => await b.locator(`[data-tool="${tool}"][data-complete="true"]`).count() === 1);
    }
    assert.equal(await marks(b).count(), 5);
    await open(a);
    await tools(a).hover();
    await a.locator('.player-shell').screenshot({path: 'test-artifacts/whiteboard-desktop.png'});
    await a.getByRole('button', {name: 'Finish drawing', exact: true}).click();
    assert.equal(await marks(a).count(), 5, 'Closing tools retains visible drawings.');
    assert.equal(await a.locator('.whiteboard-canvas').evaluate(node => getComputedStyle(node).pointerEvents), 'none');

    await b.reload();
    await until(async () => await marks(b).count() === 5);
    await open(b);
    assert.equal(await tools(b).getByRole('button', {name: 'Undo mine'}).isDisabled(), true, 'Undo never removes another account’s drawing.');
    await tools(b).getByRole('button', {name: 'Pen', exact: true}).click();
    await drag(b, [.6, .23], [.85, .23]);
    await until(async () => await marks(a).count() === 6);
    await open(b);
    await tools(b).getByRole('button', {name: 'Undo mine'}).click();
    await until(async () => await marks(a).count() === 5 && await marks(b).count() === 5);

    await tools(b).getByRole('button', {name: 'Eraser', exact: true}).click();
    await drag(b, [.7, .33], [.7, .42]);
    await until(async () => await a.locator('[data-tool="pen"]').count() === 0 && await marks(b).count() === 4);
    await b.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    assert.equal(await marks(b).count(), 0);
    await b.getByRole('switch', {name: 'Enable reactions on this device'}).click();
    await until(async () => await marks(b).count() === 4);

    await open(a);
    await a.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await until(() => a.evaluate(() => !!document.fullscreenElement));
    await tools(a).getByRole('button', {name: 'Pen', exact: true}).hover();
    const panel = await tools(a).boundingBox();
    const player = await a.locator('.video-viewport').boundingBox();
    assert.ok(panel.x >= player.x && panel.x + panel.width <= player.x + player.width);
    await a.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await tools(a).getByRole('button', {name: 'Pen', exact: true}).click();
    await drag(a, [.65, .25], [.85, .35], false);
    await until(async () => await marks(b).count() === 5);
    await open(b);
    await tools(b).getByRole('button', {name: 'Clear all'}).click();
    await until(async () => await marks(a).count() === 0 && await marks(b).count() === 0);
    await a.mouse.up();
    assert.equal(instance.whiteboards.snapshot('lobby').shapes.length, 0, 'Finishing an old stroke cannot undo a remote clear.');

    const command = instance.whiteboards.command;
    instance.whiteboards.command = function (roomId, clientId, user, message) {
        if (message.action === 'begin') {
            this.command = command;
            throw Object.assign(new Error('Drawing temporarily unavailable.'), {status: 429});
        }
        return command.call(this, roomId, clientId, user, message);
    };
    await drag(a, [.6, .3], [.8, .4]);
    await until(async () => await marks(a).count() === 0 && await marks(b).count() === 0);
    assert.equal(instance.whiteboards.snapshot('lobby').shapes.length, 0, 'Rejected drawing input leaves no optimistic ghost.');

    await b.setViewportSize({width: 390, height: 844});
    await open(b);
    await tools(b).getByRole('button', {name: 'Rectangle', exact: true}).click();
    const mobilePanel = await tools(b).boundingBox();
    const mobilePicture = await b.locator('.video-viewport').boundingBox();
    assert.ok(mobilePanel.y >= mobilePicture.y + mobilePicture.height - 1, 'Mobile tools sit below the picture.');
    assert.ok(mobilePanel.width > 320 && mobilePanel.height < 250, 'Mobile tools use a compact full-width tray.');
    await b.locator('.whiteboard-canvas').scrollIntoViewIfNeeded();
    const touch = await b.context().newCDPSession(b);
    const rect = await b.locator('.whiteboard-canvas').boundingBox();
    const touchPoint = (x, y) => [{x: rect.x + rect.width * x, y: rect.y + rect.height * y}];
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: touchPoint(.8, .35)});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: touchPoint(.95, .55)});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await until(async () => await a.locator('[data-tool="rectangle"][data-complete="true"]').count() === 1);
    await open(b);
    await b.locator('.player-shell').screenshot({path: 'test-artifacts/whiteboard-mobile.png'});
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await b.setViewportSize({width: 1000, height: 850});
    await b.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /Quiet room/}).click();
    await until(async () => await marks(b).count() === 0);
    assert.equal(await marks(a).count(), 1);
    await open(a);
    await a.keyboard.press('Escape');
    assert.equal(await tools(a).count(), 0);
    assert.deepEqual(errors, []);
});

test('whiteboard tools autohide into the left edge without ending drawing and remain accessible on mobile', {timeout: 60000}, async t => {
    const {url} = await start(t, {maxTranscoders: 0});
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    const toggle = page.getByRole('button', {name: 'Whiteboard tools', exact: true});
    const panel = page.getByRole('region', {name: 'Whiteboard controls'});
    const dock = page.locator('.whiteboard-dock');
    const viewport = page.locator('.video-viewport');
    const canvas = page.locator('.whiteboard-canvas');
    await toggle.click();
    await panel.getByRole('button', {name: 'Blue ink'}).click();
    await panel.getByRole('button', {name: 'Pen', exact: true}).hover();
    await page.waitForTimeout(3300);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'The drawer stays available while the pointer uses its controls.');
    await page.mouse.move(0, 0);
    await until(async () => await toggle.getAttribute('aria-expanded') === 'false', 4500);
    await until(async () => await dock.evaluate(node => getComputedStyle(node).visibility) === 'hidden');
    assert.equal(await dock.evaluate(node => node.inert), true, 'Hidden tools leave the keyboard tab order.');
    assert.equal(await canvas.evaluate(node => getComputedStyle(node).pointerEvents), 'auto', 'Autohide keeps drawing enabled.');
    const picture = await viewport.boundingBox();
    const tucked = await dock.boundingBox();
    assert.ok(tucked.x + tucked.width <= picture.x + 1, 'The desktop drawer retracts through the left edge.');
    assert.ok(Math.abs((await toggle.boundingBox()).x - picture.x) <= 1);
    await page.screenshot({path: 'test-artifacts/whiteboard-collapsed.png'});

    await toggle.click();
    assert.equal(await panel.getByRole('button', {name: 'Blue ink'}).getAttribute('aria-pressed'), 'true');
    await panel.getByRole('button', {name: 'Pen', exact: true}).focus();
    await page.keyboard.press('Tab');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(3300);
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true', 'Keyboard-focused controls do not vanish.');
    await panel.getByRole('button', {name: 'Collapse whiteboard tools'}).click();
    assert.equal(await toggle.evaluate(node => node === document.activeElement), true, 'Manual collapse returns focus to the edge tab.');
    const before = await viewport.boundingBox();
    await page.mouse.move(before.x + before.width * .65, before.y + before.height * .25);
    await page.mouse.down();
    await page.mouse.move(before.x + before.width * .85, before.y + before.height * .4, {steps: 8});
    await page.mouse.up();
    await until(async () => await page.locator('[data-whiteboard-id][data-complete="true"]').count() === 1);
    assert.equal(await page.locator('[data-whiteboard-id] path').getAttribute('stroke'), '#73c7ff');

    await page.setViewportSize({width: 390, height: 844});
    const closedHeight = (await viewport.boundingBox()).height;
    await toggle.click();
    await until(async () => (await panel.boundingBox())?.height > 150);
    const mobilePicture = await viewport.boundingBox();
    const mobileTools = await panel.boundingBox();
    assert.equal(mobilePicture.height, closedHeight, 'Opening the mobile tray preserves the drawing coordinates.');
    assert.ok(mobileTools.y >= mobilePicture.y + mobilePicture.height - 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.locator('.player-shell').screenshot({path: 'test-artifacts/whiteboard-mobile-tray.png'});
    await page.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await until(() => page.evaluate(() => !!document.fullscreenElement));
    await panel.getByRole('button', {name: 'Pen', exact: true}).hover();
    const fullscreenPicture = await viewport.boundingBox();
    const fullscreenTools = await panel.boundingBox();
    assert.ok(fullscreenTools.y >= fullscreenPicture.y && fullscreenTools.y + fullscreenTools.height <= fullscreenPicture.y + fullscreenPicture.height + 1);
    await panel.getByRole('button', {name: 'Collapse whiteboard tools'}).click();
    await until(async () => (await dock.boundingBox()).height < 1);
    assert.equal((await viewport.boundingBox()).height, fullscreenPicture.height, 'Collapsing the fullscreen tray never resizes an active stroke.');
    await page.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await until(() => page.evaluate(() => !document.fullscreenElement));
    await toggle.click();
    await page.mouse.move(0, 0);
    await until(async () => await toggle.getAttribute('aria-expanded') === 'false', 4500);
    await until(async () => (await dock.boundingBox()).height < 1);
    assert.equal((await viewport.boundingBox()).height, closedHeight);
    await page.getByRole('button', {name: 'Finish drawing', exact: true}).click();
    assert.equal(await canvas.evaluate(node => getComputedStyle(node).pointerEvents), 'none');
    await page.emulateMedia({reducedMotion: 'reduce'});
    await toggle.click();
    assert.ok(await dock.evaluate(node => getComputedStyle(node).transitionDuration.split(',').every(value => parseFloat(value) <= .001)));
    await page.keyboard.press('Escape');
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
    assert.deepEqual(errors, []);
});


test('per-video boards follow real video aspect ratios and share styled text across window shapes', {timeout: 90000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    const room = instance.rooms.get('lobby');
    room.desktops = [
        {id: 'landscape', kind: 'desktop', title: 'Landscape stream', addedBy: 'Landscape', status: 'ready'},
        {id: 'portrait', kind: 'desktop', title: 'Portrait stream', addedBy: 'Portrait', status: 'ready'},
    ];
    room.current = room.desktops[0];
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 1000, height: 1000}});
    const errors = [];
    const feedVideos = page => page.locator('video[data-whiteboard-video]').evaluateAll(async videos => {
        for (const video of videos) {
            const canvas = document.createElement('canvas');
            const portrait = video.dataset.whiteboardVideo === 'portrait';
            canvas.width = portrait ? 360 : 640; canvas.height = portrait ? 640 : 360;
            const ctx = canvas.getContext('2d');
            ctx.fillStyle = portrait ? '#164a35' : '#26395a'; ctx.fillRect(0, 0, canvas.width, canvas.height);
            video.srcObject = canvas.captureStream(1); video.muted = true;
            await video.play();
        }
    });
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
        await until(async () => await page.locator('.whiteboard-canvas').count() === 2);
        await feedVideos(page);
    }
    const canvas = (page, id) => page.locator('.whiteboard-canvas[data-video-id="' + id + '"]');
    const marks = (page, id) => canvas(page, id).locator('[data-whiteboard-id]');
    const panel = page => page.getByRole('region', {name: 'Whiteboard controls'});
    const open = async page => {
        if (!await panel(page).isVisible()) await page.getByRole('button', {name: 'Whiteboard tools', exact: true}).click();
    };
    const place = async (page, id, x = .55, y = .4) => {
        await canvas(page, id).scrollIntoViewIfNeeded();
        const rect = await canvas(page, id).boundingBox();
        await page.mouse.click(rect.x + rect.width * x, rect.y + rect.height * y);
    };
    const checkBounds = async page => {
        await until(() => page.locator('.whiteboard-canvas').evaluateAll(boards => boards.every(board => {
            const video = board.parentElement.querySelector('video');
            const rect = video.getBoundingClientRect(), drawing = board.getBoundingClientRect();
            const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
            return Math.abs(drawing.width - video.videoWidth * scale) < 1 && Math.abs(drawing.height - video.videoHeight * scale) < 1
                && Math.abs(drawing.x - rect.x - (rect.width - drawing.width) / 2) < 1
                && Math.abs(drawing.y - rect.y - (rect.height - drawing.height) / 2) < 1;
        })));
    };
    await b.setViewportSize({width: 700, height: 1000});
    await checkBounds(a); await checkBounds(b);
    await open(a);
    await panel(a).getByRole('button', {name: 'Text', exact: true}).click();
    await panel(a).getByRole('textbox', {name: 'Text', exact: true}).fill('Hello <svg onload="bad">');
    await panel(a).getByLabel('Font face').selectOption('Georgia');
    await panel(a).getByLabel('Font size').selectOption('48');
    await place(a, 'landscape');
    await until(async () => await marks(b, 'landscape').count() === 1);
    assert.equal(await marks(b, 'portrait').count(), 0);
    const text = marks(b, 'landscape').locator('text');
    assert.equal(await text.textContent(), 'Hello <svg onload="bad">');
    assert.equal(await text.getAttribute('font-family'), 'Georgia');
    assert.equal(await text.getAttribute('font-size'), '48');
    assert.equal(await marks(b, 'landscape').locator('svg').count(), 0, 'Text is escaped, never interpreted as SVG markup.');
    assert.equal(await canvas(a, 'landscape').getAttribute('viewBox'), await canvas(b, 'landscape').getAttribute('viewBox'));
    await open(a);
    await panel(a).getByLabel('Whiteboard video').selectOption('portrait');
    await panel(a).getByRole('button', {name: 'Pen', exact: true}).click();
    await place(a, 'portrait', .6, .5);
    await until(async () => await marks(b, 'portrait').count() === 1);
    await open(a);
    await panel(a).getByRole('button', {name: 'Clear all'}).click();
    await until(async () => await marks(b, 'portrait').count() === 0);
    assert.equal(await marks(b, 'landscape').count(), 1, 'Clearing a stream leaves other video annotations intact.');
    await panel(a).getByLabel('Whiteboard video').selectOption('landscape');
    await panel(a).getByRole('button', {name: 'Eraser', exact: true}).click();
    await place(a, 'landscape', .56, .42);
    await until(async () => await marks(b, 'landscape').count() === 0);
    await open(a);
    await panel(a).getByRole('button', {name: 'Text', exact: true}).click();
    await panel(a).getByRole('textbox', {name: 'Text', exact: true}).fill('Retained');
    await place(a, 'landscape');
    await until(async () => await marks(b, 'landscape').count() === 1);
    await a.getByRole('button', {name: 'Finish drawing', exact: true}).click();
    await a.getByRole('button', {name: 'Focus on Portrait', exact: true}).click();
    await until(async () => await a.locator('.desktop-tile.focused').getAttribute('data-item-id') === 'portrait');
    await checkBounds(a);
    assert.equal(await marks(a, 'landscape').count(), 1, 'Annotations follow the thumbnail after changing focus.');
    await b.setViewportSize({width: 390, height: 844}); await checkBounds(b);
    await b.reload();
    await until(async () => await marks(b, 'landscape').count() === 1);
    await feedVideos(b); await checkBounds(b);
    await open(b);
    await panel(b).getByRole('button', {name: 'Undo mine'}).click();
    await until(async () => await marks(a, 'landscape').count() === 0);
    assert.deepEqual(errors, []);
});


test('video playback uses letterboxed bounds and restores its own annotations from history', {timeout: 90000}, async t => {
    const {instance, url, dir} = await start(t);
    const sample = path.join(dir, 'whiteboard-video.mp4');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'testsrc2=size=480x360:rate=15', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '30', sample]);
    const bytes = await readFile(sample);
    const room = instance.rooms.get('lobby');
    for (const name of ['First video', 'Second video']) {
        const {uploadId, chunkSize} = await instance.uploads.create(room, instance.accounts.users[0], {name, size: bytes.length, duration: 30});
        for (let offset = 0; offset < bytes.length; offset += chunkSize) {
            await instance.uploads.append(instance.uploads.get(uploadId), offset, bytes.subarray(offset, offset + chunkSize), 1);
        }
    }
    const firstId = room.current.id, secondId = room.queue[0].id;
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    page.setDefaultTimeout(8000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    await until(() => page.locator('video').evaluate(video => video.videoWidth === 480 && video.readyState >= 2), 30000);
    const canvas = page.locator('.whiteboard-canvas');
    const check = async () => {
        await until(() => canvas.evaluate(board => {
            const video = document.querySelector('.video-viewport > video'), box = video.getBoundingClientRect(), rect = board.getBoundingClientRect();
            const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
            return Math.abs(rect.width - video.videoWidth * scale) < 1 && Math.abs(rect.height - video.videoHeight * scale) < 1
                && Math.abs(rect.x - box.x - (box.width - rect.width) / 2) < 1 && Math.abs(rect.y - box.y - (box.height - rect.height) / 2) < 1;
        }));
    };
    await check();
    await page.getByRole('button', {name: 'Whiteboard tools', exact: true}).click();
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + box.width * .6, box.y + box.height * .4);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * .8, box.y + box.height * .55, {steps: 5});
    await page.mouse.up();
    await until(async () => await canvas.locator('[data-complete="true"]').count() === 1);
    const mark = instance.whiteboards.snapshot(room.id, firstId).shapes[0];
    await page.getByRole('button', {name: 'Finish drawing', exact: true}).click();
    await page.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await until(() => page.evaluate(() => !!document.fullscreenElement));
    await check();
    await page.getByRole('button', {name: 'Toggle fullscreen', exact: true}).click();
    await page.getByRole('button', {name: 'Skip video for everyone', exact: true}).click();
    await until(async () => await canvas.getAttribute('data-video-id') === secondId && await canvas.locator('[data-whiteboard-id]').count() === 0);
    await page.getByRole('button', {name: 'Play previous video for everyone', exact: true}).click();
    await until(async () => await canvas.getAttribute('data-video-id') === firstId && await canvas.locator('[data-whiteboard-id]').count() === 1);
    assert.deepEqual(instance.whiteboards.snapshot(room.id, firstId).shapes[0], mark);
    await page.setViewportSize({width: 390, height: 844});
    await until(() => page.locator('video').evaluate(video => video.videoWidth === 480 && video.readyState >= 2));
    await check();
    assert.equal(await canvas.getAttribute('viewBox'), '0 0 960 720');
    assert.deepEqual(errors, []);
});
