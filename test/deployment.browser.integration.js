import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { start, until } from './helpers.js';

async function fixture(t) {
    const backend = await start(t);
    const browser = await chromium.launch({ channel: 'chrome', headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let navigations = 0;
    page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations++; });
    return { ...backend, page, errors, navigations: () => navigations };
}

async function join({ page, url, api }) {
    const { data: { room } } = await api('/api/rooms', { method: 'POST', body: { name: 'Deployment recovery room' } });
    await page.goto(url);
    await page.getByLabel('Username', { exact: true }).fill('admin');
    await page.getByLabel('Password', { exact: true }).fill('garbageTime_');
    await page.getByRole('button', { name: 'Enter Helltube' }).click();
    await page.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button', { name: /^Deployment recovery room/ }).click();
    await page.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    return room;
}

test('startup recovers through proxy 5xx and network errors and restores the selected room without another refresh', { timeout: 30000 }, async t => {
    const context = await fixture(t);
    const { page, instance, errors, navigations } = context;
    const room = await join(context);
    let attempts = 0;
    await page.route('**/api/me', route => {
        attempts++;
        if (attempts <= 2) return route.fulfill({ status: attempts === 1 ? 502 : 503, contentType: 'text/html', body: '<h1>Unavailable</h1>' });
        if (attempts === 3) return route.abort('failed');
        return route.continue();
    });
    await page.reload();
    await page.getByRole('status').filter({ hasText: 'Reconnecting automatically' }).waitFor();
    assert.equal(await page.getByRole('alert').count(), 0);
    await page.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    await until(() => instance.rooms.get(room.id).members.size === 1);
    assert.match(await page.locator('.room-button[aria-current="page"]').innerText(), /Deployment recovery room/);
    assert.equal(attempts, 4);
    assert.equal(navigations(), 2, 'Recovery after loading the page never needs an additional refresh.');
    assert.deepEqual(errors, []);
});

test('frontend deployment reloads once after metal catches up and recovers if startup still hits the cutover', { timeout: 30000 }, async t => {
    const context = await fixture(t);
    const { page, errors, navigations } = context;
    const version = JSON.parse(await readFile('dist/version.json', 'utf8'));
    const commit = (version.commit?.[0] === 'b' ? 'a' : 'b').repeat(40);
    let published = false, phase = 'old', checks = 0, startupAttempts = 0;
    await page.route('**/version.json?*', route => route.fulfill({ json: published && navigations() === 1
        ? { buildId: '22222222-2222-4222-8222-222222222222', commit } : version }));
    await page.route('**/api/version', route => {
        checks++;
        return phase === 'offline' ? route.fulfill({ status: 502, body: 'Bad Gateway' })
            : route.fulfill({ json: { commit: phase === 'ready' ? commit : version.commit } });
    });
    await join(context);
    published = true;
    for (const next of ['old', 'offline']) {
        phase = next;
        const before = checks;
        await page.evaluate(() => window.dispatchEvent(new Event('online')));
        await until(() => checks > before);
        // Leave time for a mistaken location.reload() to reach a navigation.
        await page.waitForTimeout(200);
        assert.equal(navigations(), 1);
        assert.equal(await page.getByRole('button', { name: 'Your files', exact: true }).isVisible(), true);
    }
    await page.route('**/api/me', route => ++startupAttempts === 1
        ? route.fulfill({ status: 504, body: 'Gateway Timeout' }) : route.continue());
    phase = 'ready';
    const reloaded = page.waitForEvent('framenavigated', frame => frame === page.mainFrame());
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await reloaded;
    await page.getByRole('status').filter({ hasText: 'Reconnecting automatically' }).waitFor();
    await page.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    assert.match(await page.locator('.room-button[aria-current="page"]').innerText(), /Deployment recovery room/);
    assert.equal(startupAttempts, 2);
    assert.equal(navigations(), 2);
    assert.deepEqual(errors, []);
});

test('signed-out startup reaches login automatically after a deployment outage', { timeout: 15000 }, async t => {
    const { page, url, errors, navigations } = await fixture(t);
    let attempts = 0;
    await page.route('**/api/me', route => ++attempts === 1
        ? route.fulfill({ status: 503, body: 'Unavailable' }) : route.continue());
    await page.goto(url);
    await page.getByRole('status').filter({ hasText: 'Reconnecting automatically' }).waitFor();
    await page.getByRole('button', { name: 'Enter Helltube' }).waitFor();
    assert.equal(attempts, 2);
    assert.equal(navigations(), 1);
    assert.deepEqual(errors, []);
});
