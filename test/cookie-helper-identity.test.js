import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BUNDLED_CHROME_SHARE, CHROME_SHARE_URL, IDENTITY_CHECK_INTERVAL, chromeUserAgent,
  chromeUserAgentOverride, loadChromeIdentity, parseChromeShare } from '../tools/cookie-helper/chrome-identity.mjs';

const now = Date.UTC(2026, 8, 18);
const report = (rows = [['Chrome 153.0', 4.5], ['Chrome for Android', 55], ['Chrome 151.0', 18.86], ['Edge 153', 12]], period = 'August 2026') =>
  `<table class="stats-snapshot"><tfoot><tr><th>Desktop Browser Version Market Share Worldwide - ${period}</th></tr></tfoot>` +
  `<tbody>${rows.map(([name, share]) => `<tr><th>${name}</th><td><span class="count">${share}</span>%</td></tr>`).join('')}</tbody></table>`;
const response = html => new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
async function directory() {
  await mkdir('test-artifacts', { recursive: true });
  return mkdtemp(path.resolve('test-artifacts/chrome-identity-'));
}

test('Chrome identity selects the most used numbered release, not the newest or the Android bucket', () => {
  assert.deepEqual(parseChromeShare(report(), now), BUNDLED_CHROME_SHARE);
  assert.equal(parseChromeShare(report([['Chrome 151.0', 19], ['Chrome 152.0', 21], ['Chrome 153.0', 3]]), now).major, 152);
  for (const html of [report([], 'Smarch 2026'), report([], 'December 2026'), report([['Chrome for Android', 55]]),
    report([['Chrome 151.0', 120]]), report([['Chrome 151.0', -1]]), report([['Chrome 151.0', 0]]),
    report().replace('Desktop Browser Version Market Share Worldwide', 'Browser Market Share France'), 'x'.repeat(1048577)]) {
    assert.throws(() => parseChromeShare(html, now));
  }
});

test('normal Windows Chrome UA and client hints use one validated major version', () => {
  const override = chromeUserAgentOverride(151);
  assert.equal(override.userAgent, chromeUserAgent(151));
  assert.match(override.userAgent, /Windows NT 10\.0; Win64; x64/);
  assert.match(override.userAgent, /Chrome\/151\.0\.0\.0/);
  assert.doesNotMatch(JSON.stringify(override), /Headless|Edg\//);
  assert.equal(override.platform, 'Win32');
  assert.deepEqual(override.userAgentMetadata.brands.filter(item => item.brand !== 'Not_A Brand').map(item => item.version), ['151', '151']);
  assert.equal(override.userAgentMetadata.platform, 'Windows');
  for (const major of [0, 99, 1000, 151.5, '151', '151\r\nX-Header: injected']) assert.throws(() => chromeUserAgent(major));
});

test('market share is fetched without credentials, cached for a day and updated for the next report', async () => {
  const dir = await directory();
  const fetchImpl = test.mock.fn(async (url, options) => {
    assert.equal(url, CHROME_SHARE_URL);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers.Cookie, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    return response(report());
  });
  const first = await loadChromeIdentity(dir, { fetchImpl, now });
  assert.equal(first.major, 151);
  assert.equal(first.source, 'statcounter');
  assert.equal((await loadChromeIdentity(dir, { fetchImpl, now: now + 1000 })).major, 151);
  assert.equal(fetchImpl.mock.callCount(), 1);
  const updated = await loadChromeIdentity(dir, { now: now + IDENTITY_CHECK_INTERVAL,
    fetchImpl: async () => response(report([['Chrome 152.0', 20], ['Chrome 151.0', 10]], 'September 2026')) });
  assert.equal(updated.major, 152);
  assert.equal(updated.period, '2026-09');
  assert.equal(JSON.parse(await readFile(path.join(dir, 'chrome-identity.json'), 'utf8')).major, 152);
});

test('lookup failures retain the last selection and never fall back to a native headless identity', async () => {
  const dir = await directory();
  await loadChromeIdentity(dir, { now, fetchImpl: async () => response(report([['Chrome 152.0', 30]])) });
  for (const fetchImpl of [async () => { throw new Error('offline'); }, async () => new Response('unavailable', { status: 503 }),
    async () => response('<html>Layout changed</html>'), async () => response(report([['Chrome 150.0', 20]], 'July 2026')),
    async () => response('x'.repeat(1048577))]) {
    const nextNow = JSON.parse(await readFile(path.join(dir, 'chrome-identity.json'), 'utf8')).checkedAt + IDENTITY_CHECK_INTERVAL;
    const identity = await loadChromeIdentity(dir, { now: nextNow, fetchImpl });
    assert.equal(identity.major, 152);
    assert.equal(identity.source, 'cached');
    assert.equal(identity.userAgent, chromeUserAgent(152));
  }
});

test('offline first use and corrupt caches use the bundled verified version with a visible fallback label', async () => {
  for (const contents of [null, '{broken', JSON.stringify({ major: 9999, period: '2026-08', share: 12, checkedAt: now, fetchedAt: now })]) {
    const dir = await directory();
    if (contents) await writeFile(path.join(dir, 'chrome-identity.json'), contents);
    const fetchImpl = test.mock.fn(async () => { throw new Error('offline'); });
    const identity = await loadChromeIdentity(dir, { fetchImpl, now });
    assert.equal(identity.major, BUNDLED_CHROME_SHARE.major);
    assert.equal(identity.source, 'bundled');
    assert.match(identity.description, /bundled/);
    assert.doesNotMatch(identity.userAgent, /Headless/);
    await loadChromeIdentity(dir, { fetchImpl, now: now + 1000 });
    assert.equal(fetchImpl.mock.callCount(), 1);
  }
});
