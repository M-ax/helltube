import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { openBrowser, refreshCookies } from '../tools/cookie-helper/browser.mjs';
import { youtubeCookies } from '../tools/cookie-helper/core.mjs';
import { cookieUserAgent } from '../shared/youtube-cookie-metadata.js';
import { chromeUserAgent } from '../tools/cookie-helper/chrome-identity.mjs';

const browserName = process.env.COOKIE_HELPER_TEST_BROWSER || 'chrome';
test('dedicated browser profile persists cookies, refreshes, exports only YouTube and closes cleanly',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    await mkdir('test-artifacts', { recursive: true });
    const directory = await mkdtemp(path.resolve('test-artifacts/cookie-browser-'));
    const identity = { major: 151, description: 'Chrome 151 (synthetic usage fixture)' };
    let session = await openBrowser(directory, browserName, false, { identity });
    try {
      const requestAgents = [];
      const requestBrands = [];
      await session.context.route('**/*', route => {
        if (route.request().isNavigationRequest()) {
          requestAgents.push(route.request().headers()['user-agent']);
          requestBrands.push(route.request().headers()['sec-ch-ua']);
        }
        return route.fulfill({ contentType: 'text/html', body: '<script>window.ytcfg={get:()=>true}</script>' });
      });
      await session.context.addCookies([
        { domain: '.youtube.com', path: '/', name: 'SID', value: 'synthetic-test-session', expires: 2147483647, secure: true, httpOnly: true },
        { domain: '.google.com', path: '/', name: 'SID', value: 'never-export-this', expires: 2147483647, secure: true, httpOnly: true },
      ]);
      const { cookies, userAgent } = await refreshCookies(session);
      const first = youtubeCookies(cookies, { userAgent });
      assert.equal(userAgent, chromeUserAgent(identity.major));
      assert.doesNotMatch(userAgent, /HeadlessChrome|Edg\//);
      assert.deepEqual(requestAgents, [userAgent, userAgent], 'Exported identity matches both actual browser navigation requests.');
      for (const brands of requestBrands) {
        assert.match(brands, /"Google Chrome";v="151"/);
        assert.doesNotMatch(brands, /Headless|Microsoft Edge/);
      }
      const hints = await session.page.evaluate(async () => ({ platform: navigator.platform, userAgent: navigator.userAgent,
        ...await navigator.userAgentData.getHighEntropyValues(['fullVersionList']) }));
      assert.equal(hints.userAgent, userAgent);
      assert.ok(hints.brands.some(item => item.brand === 'Google Chrome' && item.version === '151'));
      assert.ok(hints.fullVersionList.some(item => item.brand === 'Google Chrome' && item.version === '151.0.0.0'));
      assert.doesNotMatch(JSON.stringify(hints), /Headless/);
      assert.equal(cookieUserAgent(first.text), userAgent);
      assert.match(first.text, /synthetic-test-session/);
      assert.doesNotMatch(first.text, /never-export-this|google.com/);
      assert.equal(session.page.url(), 'https://www.youtube.com/robots.txt');
      await session.close();
      assert.equal(session.browser.isConnected(), false);
      session = await openBrowser(directory, browserName, false, { identity: { ...identity, major: 152 } });
      assert.equal(await session.page.evaluate(() => navigator.userAgent), chromeUserAgent(152), 'A newly selected popular release applies on reopening.');
      const persisted = youtubeCookies(await session.context.cookies(), { userAgent });
      assert.equal(persisted.text, first.text);
      await session.context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Sign in</p>' }));
      await assert.rejects(refreshCookies(session), /sign-in or consent/);
    } finally { await session.close(); }
  });
