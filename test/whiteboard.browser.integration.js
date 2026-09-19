import test from 'node:test';
import assert from 'node:assert/strict';
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
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
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
        await tools(a).getByRole('button', {name, exact: true}).click();
        await drag(a, [.58, .5], [.87, .65]);
        await until(async () => await b.locator(`[data-tool="${tool}"][data-complete="true"]`).count() === 1);
    }
    assert.equal(await marks(b).count(), 5);
    await a.locator('.player-shell').screenshot({path: 'test-artifacts/whiteboard-desktop.png'});
    await tools(a).getByRole('button', {name: 'Close whiteboard tools'}).click();
    assert.equal(await marks(a).count(), 5, 'Closing tools retains visible drawings.');
    assert.equal(await a.locator('.whiteboard-canvas').evaluate(node => getComputedStyle(node).pointerEvents), 'none');

    await b.reload();
    await until(async () => await marks(b).count() === 5);
    await open(b);
    assert.equal(await tools(b).getByRole('button', {name: 'Undo mine'}).isDisabled(), true, 'Undo never removes another account’s drawing.');
    await tools(b).getByRole('button', {name: 'Pen', exact: true}).click();
    await drag(b, [.6, .23], [.85, .23]);
    await until(async () => await marks(a).count() === 6);
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
    await tools(b).getByRole('button', {name: 'Rectangle', exact: true}).click();
    assert.ok((await tools(b).boundingBox()).height > 280, 'The mobile flyout has room for the drawing controls.');
    await b.locator('.whiteboard-canvas').scrollIntoViewIfNeeded();
    const touch = await b.context().newCDPSession(b);
    const rect = await b.locator('.whiteboard-canvas').boundingBox();
    const touchPoint = (x, y) => [{x: rect.x + rect.width * x, y: rect.y + rect.height * y}];
    await touch.send('Input.dispatchTouchEvent', {type: 'touchStart', touchPoints: touchPoint(.8, .35)});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchMove', touchPoints: touchPoint(.95, .55)});
    await touch.send('Input.dispatchTouchEvent', {type: 'touchEnd', touchPoints: []});
    await until(async () => await a.locator('[data-tool="rectangle"][data-complete="true"]').count() === 1);
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
