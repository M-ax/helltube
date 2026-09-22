import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { browserExecutable, openBrowser, openSignInBrowser, refreshCookies } from '../tools/cookie-helper/browser.mjs';
import { youtubeCookies } from '../tools/cookie-helper/core.mjs';
import { cookieUserAgent } from '../shared/youtube-cookie-metadata.js';
import { chromeUserAgent } from '../tools/cookie-helper/chrome-identity.mjs';

const browserName = process.env.COOKIE_HELPER_TEST_BROWSER || 'chrome';
test('ordinary sign-in browser has no debugger and hands its saved profile to background refresh',
  { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
    await mkdir('test-artifacts', { recursive: true });
    const directory = await mkdtemp(path.resolve('test-artifacts/cookie-sign-in-'));
    let observed, closeWindow = false, signIn, refresh;
    const server = createServer((request, response) => {
      if (request.url === '/observed' && request.method === 'POST') {
        let body = '';
        request.on('data', data => { body += data; });
        request.on('end', () => { observed = JSON.parse(body); response.end('ok'); });
      } else if (request.url === '/state') {
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify({ closeWindow }));
      } else {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Set-Cookie', 'helper_fixture=persisted; Max-Age=3600; Path=/; HttpOnly; SameSite=Lax');
        response.end(`<title>Helltube sign-in handoff test</title><p>Synthetic browser test. No Google login.</p>
          <script>
            fetch('/observed', { method: 'POST', body: JSON.stringify({
              userAgent: navigator.userAgent, webdriver: navigator.webdriver,
              brands: navigator.userAgentData?.brands
            }) });
            setInterval(async () => {
              if ((await (await fetch('/state')).json()).closeWindow) window.close();
            }, 100);
          </script>`);
      }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/`;
    try {
      signIn = await openSignInBrowser(directory, browserName, { url });
      for (let attempt = 0; !observed && attempt < 100; attempt++) await delay(100);
      assert.ok(observed, 'The regular browser loaded the fixture without an automation connection.');
      assert.equal(observed.webdriver, false);
      assert.doesNotMatch(observed.userAgent, /HeadlessChrome/);
      if (browserName === 'edge') assert.match(observed.userAgent, /Edg\//, 'Sign-in uses the installed Edge identity.');
      await assert.rejects(access(path.join(directory, `profile-${browserName}`, 'DevToolsActivePort')), { code: 'ENOENT' });
      assert.equal(signIn.isOpen, true);
      await assert.rejects(signIn.finish(), /Close all windows/);
      await assert.rejects(openBrowser(directory, browserName, { identity: { major: 151 } }), /sign-in browser is still open/);
      assert.equal(signIn.isOpen, true, 'A failed refresh leaves the regular sign-in browser alone.');
      closeWindow = true;
      for (let attempt = 0; signIn.isOpen && attempt < 100; attempt++) await delay(100);
      assert.equal(signIn.isOpen, false, 'The browser finishes saving its profile before export starts.');
      await signIn.finish();
      refresh = await openBrowser(directory, browserName, { identity: { major: 299, description: 'Synthetic refresh identity' } });
      const cookies = await refresh.context.cookies(url);
      assert.equal(cookies.find(cookie => cookie.name === 'helper_fixture')?.value, 'persisted');
      assert.equal(await refresh.page.evaluate(() => navigator.userAgent), chromeUserAgent(299));
      assert.notEqual(observed.userAgent, chromeUserAgent(299), 'The refresh override does not affect sign-in.');
      await refresh.close();
      refresh = null;
      closeWindow = false;
      observed = null;
      signIn = await openSignInBrowser(directory, browserName, { url });
      for (let attempt = 0; !observed && attempt < 100; attempt++) await delay(100);
      assert.ok(observed);
      await signIn.close(); // Cancel/quit closes only the helper's own browser normally.
      assert.equal(signIn.isOpen, false);
      await signIn.finish();
    } finally {
      await refresh?.close();
      await signIn?.close();
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });

test('an active background browser keeps its connection file and cannot be taken over',
  { skip: process.platform !== 'win32', timeout: 30000 }, async () => {
    await mkdir('test-artifacts', { recursive: true });
    const directory = await mkdtemp(path.resolve('test-artifacts/cookie-active-'));
    const identity = { major: 151 };
    const session = await openBrowser(directory, browserName, { identity });
    try {
      const portFile = path.join(directory, `profile-${browserName}`, 'DevToolsActivePort');
      const original = await readFile(portFile, 'utf8');
      await assert.rejects(openBrowser(directory, browserName, { identity }), /background browser is already in use/);
      await assert.rejects(openSignInBrowser(directory, browserName, { url: 'about:blank' }), /background browser is already in use/);
      assert.equal(await readFile(portFile, 'utf8'), original, 'A retry must not erase a running browser connection.');
      assert.equal(await session.page.evaluate(() => 42), 42, 'The original browser is still usable.');
    } finally { await session.close(); }
  });

test('an orphaned background browser is recovered without its port file and retains saved cookies',
  { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
    await mkdir('test-artifacts', { recursive: true });
    const directory = await mkdtemp(path.resolve('test-artifacts/cookie orphan [fixture]-'));
    const profile = path.join(directory, `profile-${browserName}`);
    const portFile = path.join(profile, 'DevToolsActivePort');
    const seed = await openBrowser(directory, browserName, { identity: { major: 151 } });
    try {
      await seed.context.addCookies([{ url: 'https://example.test/', name: 'recovery_fixture', value: 'persisted', expires: 2147483647 }]);
    } finally { await seed.close(); }
    await rm(portFile, { force: true });
    const script = `
      import { spawn } from 'node:child_process';
      import { access } from 'node:fs/promises';
      import { setTimeout as delay } from 'node:timers/promises';
      const browser = spawn(${JSON.stringify(await browserExecutable(browserName))}, [
        ${JSON.stringify(`--user-data-dir=${profile}`)}, '--headless=new', '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', '--disable-background-mode', 'about:blank',
      ], { detached: true, windowsHide: true, stdio: 'ignore' });
      browser.unref();
      for (let attempt = 0; attempt < 100; attempt++) {
        try { await access(${JSON.stringify(portFile)}); process.exit(0); } catch {}
        await delay(100);
      }
      browser.kill();
      process.exit(1);
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.resume();
    let diagnostics = '';
    child.stderr.on('data', data => { diagnostics += data; });
    const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
    assert.equal(code, 0, diagnostics);
    const [port, endpoint] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
    let session, neighbor;
    try {
      // A similarly named profile owned by a live process must remain untouched.
      neighbor = await openBrowser(`${directory}-other`, browserName, { identity: { major: 151 } });
      await rm(portFile);
      session = await openBrowser(directory, browserName, { identity: { major: 152 } });
      assert.equal((await session.context.cookies('https://example.test/')).find(cookie => cookie.name === 'recovery_fixture')?.value, 'persisted');
      assert.equal(await session.page.evaluate(() => navigator.userAgent), chromeUserAgent(152));
      assert.equal(await neighbor.page.evaluate(() => 42), 42);
      await assert.rejects(chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { timeout: 1000 }), 'The abandoned browser has exited.');
    } finally {
      await session?.close();
      await neighbor?.close();
      // Keep the fixture isolated even if recovery fails before returning a session.
      try {
        const leftover = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { timeout: 1000 });
        try { await (await leftover.newBrowserCDPSession()).send('Browser.close'); } finally { await leftover.close(); }
      } catch {}
    }
  });

test('dedicated browser profile persists cookies, refreshes, exports only YouTube and closes cleanly',
  { skip: process.platform !== 'win32', timeout: 60000 }, async () => {
    await mkdir('test-artifacts', { recursive: true });
    const directory = await mkdtemp(path.resolve('test-artifacts/cookie-browser-'));
    const identity = { major: 151, description: 'Chrome 151 (synthetic usage fixture)' };
    let session = await openBrowser(directory, browserName, { identity });
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
      session = await openBrowser(directory, browserName, { identity: { ...identity, major: 152 } });
      assert.equal(await session.page.evaluate(() => navigator.userAgent), chromeUserAgent(152), 'A newly selected popular release applies on reopening.');
      const persisted = youtubeCookies(await session.context.cookies(), { userAgent });
      assert.equal(persisted.text, first.text);
      await session.context.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<p>Sign in</p>' }));
      await assert.rejects(refreshCookies(session), /sign-in or consent/);
    } finally { await session.close(); }
  });
