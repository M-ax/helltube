import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { HelperError, privateDirectory } from './core.mjs';
import { chromeUserAgentOverride, loadChromeIdentity } from './chrome-identity.mjs';
import { prepareBrowserProfile } from './browser-recovery.mjs';

const exec = promisify(execFile);

export async function browserExecutable(browser) {
  const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA].filter(Boolean);
  const suffix = browser === 'chrome' ? ['Google', 'Chrome', 'Application', 'chrome.exe'] : ['Microsoft', 'Edge', 'Application', 'msedge.exe'];
  for (const root of roots) {
    const candidate = path.join(root, ...suffix);
    try { await access(candidate); return candidate; } catch {}
  }
  throw new HelperError(`Install ${browser === 'chrome' ? 'Google Chrome' : 'Microsoft Edge'} before signing in.`);
}

// Google sign-in takes place in a regular browser, without CDP, automation or UA overrides.
// The user closes its windows before we reopen the same dedicated profile for export.
export async function openSignInBrowser(directory, browserName, { executable, url = 'https://www.youtube.com/' } = {}) {
  const profile = path.join(directory, `profile-${browserName}`);
  await privateDirectory(profile);
  await prepareBrowserProfile(profile);
  const child = spawn(executable || await browserExecutable(browserName), [
    `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
    '--disable-background-mode', '--new-window', url,
  ], { windowsHide: false, stdio: 'ignore' });
  let ended = false;
  let launchError = false;
  const closed = new Promise(resolve => {
    child.once('error', () => { launchError = true; });
    child.once('close', () => { ended = true; resolve(); });
  });
  await delay(500);
  if (launchError || ended) {
    throw new HelperError('The sign-in browser could not start. Close any previous helper browser windows, then try Sign in again.');
  }
  return {
    closed,
    get isOpen() { return !ended; },
    async finish() {
      if (!ended) throw new HelperError('Close all windows of the helper sign-in browser, then click Finish sign-in.');
    },
    async close() {
      if (ended) return;
      // Ask only our own browser process to close normally so it can save its profile.
      // Never force-kill a sign-in browser or attach a debugger to Google sign-in.
      if (process.platform === 'win32') {
        const taskkill = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'taskkill.exe');
        await exec(taskkill, ['/PID', String(child.pid)], { windowsHide: true, timeout: 10000 }).catch(() => {});
      } else child.kill('SIGTERM');
      await Promise.race([closed, delay(10000, undefined, { ref: false })]);
      if (!ended) throw new HelperError('Close all windows of the helper sign-in browser, then try again.');
    },
  };
}

// Refresh owns a short-lived automated process; it never performs account sign-in.
export async function openBrowser(directory, browserName, { executable, identity: selectedIdentity } = {}) {
  const profile = path.join(directory, `profile-${browserName}`);
  await privateDirectory(profile);
  const identity = selectedIdentity || await loadChromeIdentity(directory);
  const override = chromeUserAgentOverride(identity.major);
  await prepareBrowserProfile(profile);
  const portFile = path.join(profile, 'DevToolsActivePort');
  await rm(portFile, { force: true });
  const child = spawn(executable || await browserExecutable(browserName), [
    `--user-data-dir=${profile}`, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0',
    `--user-agent=${override.userAgent}`,
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode',
    '--headless=new', 'about:blank',
  ], { windowsHide: true, stdio: 'ignore' });
  let launchError = false;
  child.on('error', () => { launchError = true; });
  let browser;
  async function close() {
    if (browser?.isConnected()) {
      try { const session = await browser.newBrowserCDPSession(); await session.send('Browser.close'); } catch {}
      await browser.close().catch(() => {});
    }
    for (let i = 0; i < 30 && child.exitCode === null && !launchError; i++) await delay(100);
    if (child.exitCode === null && !launchError) child.kill();
  }
  try {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      if (launchError || child.exitCode !== null) throw new HelperError('The dedicated browser could not start. Check its installation and policies, or save settings with the other browser.');
      try {
        const [port, endpoint] = (await readFile(portFile, 'utf8')).trim().split(/\r?\n/);
        if (/^\d+$/.test(port) && /^\/devtools\/browser\/[a-zA-Z0-9-]+$/.test(endpoint)) {
          browser = await chromium.connectOverCDP(`ws://127.0.0.1:${port}${endpoint}`, { timeout: 5000 });
          break;
        }
      } catch {}
      await delay(200);
    }
    if (!browser) throw new HelperError('Cannot connect to the dedicated browser. Check browser policies and try again.');
    const context = browser.contexts()[0];
    const page = context.pages()[0] || await context.newPage();
    const configured = new WeakMap();
    const configurePage = target => {
      if (!configured.has(target)) configured.set(target, (async () => {
        const cdp = await context.newCDPSession(target);
        await cdp.send('Emulation.setUserAgentOverride', override);
      })());
      return configured.get(target);
    };
    await configurePage(page);
    // Popups keep the launch-wide UA; also align their navigator/client-hint metadata.
    context.on('page', target => { void configurePage(target).catch(() => {}); });
    page.setDefaultNavigationTimeout(45000);
    return { browser, context, page, close, identity, userAgent: override.userAgent };
  } catch (error) { await close(); throw error; }
}

export async function refreshCookies(session) {
  const response = await session.page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
  if (!response?.ok()) throw new HelperError('YouTube could not be reached. The previous export was preserved.');
  // Let the normal YouTube page finish session renewal, then stop its active scripts.
  await session.page.waitForTimeout(5000);
  const signedIn = await session.page.evaluate(() => window.ytcfg?.get('LOGGED_IN') === true);
  if (!signedIn) throw new HelperError('YouTube needs sign-in or consent. Open Sign in and complete verification.');
  await session.page.goto('https://www.youtube.com/robots.txt', { waitUntil: 'domcontentloaded' });
  const userAgent = await session.page.evaluate(() => navigator.userAgent);
  if (userAgent !== session.userAgent || /HeadlessChrome|Edg\//i.test(userAgent)) {
    throw new HelperError('The browser identity could not be applied. The previous export was preserved.');
  }
  return { cookies: await session.context.cookies(), userAgent };
}
