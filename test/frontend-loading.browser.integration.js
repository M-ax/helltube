import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('cold login and idle rooms defer optional code, full fonts and reaction sounds', {timeout: 30000}, async t => {
    const {url} = await start(t, {maxTranscoders: 0});
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const requests = [];
    const errors = [];
    page.on('request', request => {
        const target = new URL(request.url());
        if (target.origin === url) requests.push(target.pathname);
    });
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).waitFor();
    assert.equal(requests.filter(path => path.endsWith('.js')).length, 1, 'Login needs only the application entry.');
    assert.ok(!requests.some(path => /\.(woff2|mp3|png)$/.test(path)), JSON.stringify(requests));
    const initialJS = await page.evaluate(() => performance.getEntriesByType('resource')
        .filter(entry => entry.name.endsWith('.js')).reduce((total, entry) => total + entry.decodedBodySize, 0));
    assert.ok(initialJS > 0 && initialJS < 200_000, `Initial JavaScript: ${initialJS} bytes`);
    t.diagnostic(`Cold login JavaScript: ${initialJS} bytes (uncompressed).`);

    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).waitFor();
    assert.ok(!requests.some(path => /\/(Player|Account|Admin|hls)-/.test(path)));
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    await page.getByRole('heading', {name: 'Reactions', exact: true}).click();
    await page.evaluate(() => document.fonts.ready);
    assert.ok(requests.some(path => /\/Player-.*\.js$/.test(path)));
    assert.ok(requests.some(path => /HackNerdFontMono-CRT-/.test(path)));
    assert.ok(!requests.some(path => /HackNerdFontMono-Regular-|\/hls-|\/sounds\//.test(path)));
    await page.getByRole('button', {name: 'Love', exact: true}).click();
    await page.locator('[data-reaction="heart"]').waitFor();
    assert.ok(!requests.some(path => path.startsWith('/sounds/')));
    await page.getByRole('button', {name: 'Metal pipe', exact: true}).click();
    await until(() => requests.includes('/sounds/metal-pipe.mp3'));
    assert.deepEqual(requests.filter(path => path.startsWith('/sounds/')), ['/sounds/metal-pipe.mp3']);

    const accountDownload = Promise.withResolvers();
    t.after(() => accountDownload.resolve());
    await page.route('**/assets/Account-*.js', async route => {
        await accountDownload.promise;
        await route.continue().catch(() => {});
    });
    await page.getByRole('button', {name: 'Account settings', exact: true}).click();
    await page.getByRole('dialog', {name: 'Loading account settings', exact: true}).waitFor();
    await page.getByRole('button', {name: 'Close dialog'}).click();
    accountDownload.resolve();
    await page.getByRole('button', {name: 'Account settings', exact: true}).click();
    await page.getByRole('dialog', {name: 'Make yourself at home.'}).waitFor();
    assert.ok(requests.some(path => /\/Account-.*\.js$/.test(path)));
    assert.ok(!requests.some(path => /\/Admin-/.test(path)));
    await page.getByRole('button', {name: 'Close dialog'}).click();
    await page.getByRole('button', {name: 'Manage users', exact: true}).click();
    await page.getByRole('dialog', {name: 'Good company starts here.'}).waitFor();
    assert.ok(requests.some(path => /\/Admin-.*\.js$/.test(path)));
    await page.getByRole('button', {name: 'Close dialog'}).click();

    // Names and titles outside the subset retain the complete font on demand.
    await page.locator('.crt-source').evaluate(node => { node.textContent = 'Привет'; });
    await page.evaluate(() => document.fonts.ready);
    await until(() => requests.some(path => /HackNerdFontMono-Regular-/.test(path)));
    assert.deepEqual(errors, []);
});

test('player tolerates missing room snapshots on initial join and room switches', {timeout: 30000}, async t => {
    const {url, instance} = await start(t, {maxTranscoders: 0});
    instance.rooms.create('Second room', 'second-room');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let holdState = true;
    let releaseState = null;
    await page.routeWebSocket('**/ws', socket => {
        const server = socket.connectToServer();
        server.onMessage(message => {
            if (holdState && JSON.parse(String(message)).type === 'state') releaseState = () => socket.send(message);
            else socket.send(message);
        });
    });
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    const rooms = page.getByRole('navigation', {name: 'Screening rooms'});
    for (const name of [/^The living room(?: |$)/, /^Second room(?: |$)/]) {
        holdState = true;
        releaseState = null;
        await rooms.getByRole('button', {name}).click();
        await until(() => releaseState);
        await until(async () => errors.length || await page.locator('.player-shell').count());
        assert.deepEqual(errors, [], 'Rendering before the room snapshot must not throw');
        assert.equal(await page.locator('.screen-tag').textContent(), 'THE SCREEN IS YOURS');
        assert.equal(await page.locator('.desktop-tile').count(), 0);
        assert.equal(await page.getByRole('button', {name: 'Skip video for everyone', exact: true}).isEnabled(), false);
        holdState = false;
        releaseState();
        await until(() => page.locator('.sync-badge').textContent().then(text => text.includes('Room synced')));
        assert.deepEqual(errors, [], 'The existing player accepts the fresh room snapshot');
    }
    await page.getByRole('button', {name: 'Sign out', exact: true}).click();
    await page.getByLabel('Username', {exact: true}).waitFor();
    assert.deepEqual(errors, []);
});
