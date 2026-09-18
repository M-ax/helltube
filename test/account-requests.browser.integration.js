import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { start, until } from './helpers.js';

test('guests request accounts and admins approve or deny them live, with instant sign-in and refresh recovery', { timeout: 45000 }, async t => {
  const { url, instance } = await start(t, { maxTranscoders: 0 });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const admin = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const guest = await guestContext.newPage();
  const errors = [];
  for (const page of [admin, guest]) {
    page.setDefaultTimeout(10000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
  }
  await admin.getByLabel('Username', { exact: true }).fill('admin');
  await admin.getByLabel('Password', { exact: true }).fill('garbageTime_');
  await admin.getByRole('button', { name: 'Enter Helltube' }).click();
  await admin.getByRole('button', { name: 'Manage users', exact: true }).click();
  const queue = admin.getByRole('region', { name: 'Account requests' });
  await queue.getByText('No account requests waiting for review.').waitFor();

  const submit = async username => {
    await guest.getByRole('button', { name: 'Request an account', exact: true }).click();
    await guest.getByLabel('Username', { exact: true }).fill(username);
    await guest.getByLabel('Display name', { exact: true }).fill('Our New Guest');
    await guest.getByLabel('Password', { exact: true }).fill('chosen-password');
    await guest.screenshot({ path: 'test-artifacts/account-request-mobile.png', fullPage: true });
    assert.equal(await guest.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await guest.getByRole('button', { name: 'Send account request' }).click();
    await guest.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
    const cookies = await guestContext.cookies(`${url}/api/account-requests`);
    assert.equal(cookies.find(cookie => cookie.name === 'account_request').httpOnly, true);
  };
  await submit('welcome_guest');
  await queue.getByRole('button', { name: 'Approve welcome_guest', exact: true }).waitFor();
  await guest.reload();
  await guest.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  assert.equal(await guest.locator('input[type=password]').count(), 0);
  await admin.screenshot({ path: 'test-artifacts/account-request-admin.png', fullPage: true });
  await queue.getByRole('button', { name: 'Approve welcome_guest', exact: true }).click();
  await guest.locator('.app-shell').waitFor();
  assert.equal((await guest.request.get(`${url}/api/me`).then(response => response.json())).user.username, 'welcome_guest');
  await guest.reload();
  await guest.locator('.app-shell').waitFor();
  // Signing out must not reclaim the already-consumed approval receipt.
  await guest.request.post(`${url}/api/logout`);
  await guest.reload();
  await guest.getByRole('button', { name: 'Enter Helltube' }).waitFor();
  await submit('declined_guest');
  await queue.getByRole('button', { name: 'Deny declined_guest', exact: true }).click();
  await guest.getByRole('heading', { name: 'Request denied' }).waitFor();
  assert.equal(instance.accounts.users.some(user => user.username === 'declined_guest'), false);
  await guest.reload();
  await guest.getByRole('heading', { name: 'Request denied' }).waitFor();
  await guest.getByRole('button', { name: 'Back to sign in' }).click();
  await guest.getByLabel('Username', { exact: true }).fill('welcome_guest');
  await guest.getByLabel('Password', { exact: true }).fill('chosen-password');
  await guest.getByRole('button', { name: 'Enter Helltube' }).click();
  await guest.locator('.app-shell').waitFor();
  await until(() => queue.getByText('No account requests waiting for review.').isVisible());
  assert.deepEqual(errors, []);
});

test('approval while disconnected is recovered and temporary sign-in failures retry automatically', { timeout: 30000 }, async t => {
  const { url, api } = await start(t, { maxTranscoders: 0 });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  await page.goto(url);
  await page.getByRole('button', { name: 'Request an account', exact: true }).click();
  await page.getByLabel('Username', { exact: true }).fill('offline_guest');
  await page.getByLabel('Display name', { exact: true }).fill('Offline Guest');
  await page.getByLabel('Password', { exact: true }).fill('chosen-password');
  await page.getByRole('button', { name: 'Send account request' }).click();
  await page.getByRole('heading', { name: 'Waiting for approval' }).waitFor();
  const request = (await api('/api/account-requests')).data.requests[0];
  let claims = 0;
  await page.route('**/api/account-requests/claim', async route => {
    if (++claims === 1) await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Temporarily unavailable.' }) });
    else await route.continue();
  });
  await context.setOffline(true);
  await api(`/api/account-requests/${request.id}/approve`, { method: 'POST' });
  await context.setOffline(false);
  await page.locator('.app-shell').waitFor({ timeout: 15000 });
  assert.equal(claims, 2);
  assert.equal((await page.request.get(`${url}/api/me`).then(response => response.json())).user.username, 'offline_guest');
});
