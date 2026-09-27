import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { start, until } from './helpers.js';

test('Strife-style loopback iframe preserves login and room through refresh', { timeout: 30000 }, async t => {
  const { url, instance } = await start(t, { ffmpeg: 'missing-test-ffmpeg', ytdlp: 'missing-test-ytdlp' });
  const shell = createServer((_, res) => {
    res.setHeader('Content-Type', 'text/html');
    res.end('<iframe style="width:100%;height:95vh;border:0" id="video" src="' + url + '" referrerpolicy="no-referrer" allow="autoplay; fullscreen; display-capture; clipboard-write" sandbox="allow-scripts allow-same-origin allow-forms allow-downloads allow-popups" allowfullscreen></iframe>');
  });
  await new Promise(resolve => shell.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => shell.close(resolve)));
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1480, height: 900 } });
  page.setDefaultTimeout(10000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:' + shell.address().port);
  const frame = page.frameLocator('#video');
  await frame.getByLabel('Username', { exact: true }).fill('admin');
  await frame.getByLabel('Password', { exact: true }).fill('garbageTime_');
  await frame.getByRole('button', { name: 'Enter Helltube' }).click();
  await frame.getByRole('navigation', { name: 'Screening rooms' }).getByRole('button', { name: /^The living room(?: |$)/ }).click();
  await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
  for (let i = 0; i < 2; i++) {
    await page.reload();
    await frame.getByRole('button', { name: 'Your files', exact: true }).waitFor();
    await until(() => instance.rooms.get('lobby').members.size === 1);
  }
  assert.equal(await page.locator('#video').evaluate(frame => {
    try { return !!frame.contentWindow.document; } catch { return false; }
  }), false);
  assert.deepEqual(errors, []);
  const headers = (await fetch(url)).headers;
  assert.equal(headers.get('x-frame-options'), null);
  assert.equal(headers.get('content-security-policy').split('frame-ancestors ')[1], "'self' http://127.0.0.1:* http://localhost:*");
  // A foreign web page cannot gain the desktop's framing or API privileges.
  const foreign = 'http://foreign.example.test';
  // Use the real server policy on a public-origin fixture so Chrome's local-network
  // permission gate cannot mask the frame-ancestors decision being tested.
  const framed = 'http://video.example.test';
  await page.route(framed + '/**', route => route.fulfill({ contentType: 'text/html',
    headers: { 'Content-Security-Policy': headers.get('content-security-policy') }, body: '<h1>Blocked fixture</h1>' }));
  await page.route(foreign + '/**', route => route.fulfill({ contentType: 'text/html', body: '<iframe src="' + framed + '"></iframe>' }));
  const blocked = page.waitForEvent('console', message => /frame-ancestors/.test(message.text()));
  await page.goto(foreign);
  await blocked;
  assert.equal(await page.frames()[1].getByRole('heading', { name: 'Blocked fixture' }).count(), 0);
  const denied = await fetch(url + '/api/me', { headers: { Origin: foreign, 'Sec-Fetch-Site': 'cross-site' } });
  assert.equal(denied.status, 403);
});
