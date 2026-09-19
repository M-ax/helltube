import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, HelperError, nextRefresh, privateDirectory, readConfig, syncSSH, validateConfig, youtubeCookies } from './core.mjs';
import { openBrowser, openSignInBrowser, refreshCookies } from './browser.mjs';

const directory = path.resolve(process.argv[2]);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let config, session, busy = false, stopping = false, failures = 0;
let status = { message: 'Ready. Sign in to YouTube to create your first export.', lastExport: null, lastSync: null, nextRun: null, error: false,
  browserIdentity: 'Automatic Chrome version (worldwide usage)' };
const publish = () => emit({ type: 'status', ...status, nextRun: session ? null : status.nextRun, busy, signingIn: !!session });
const safeError = error => error instanceof HelperError ? error.message : 'Operation failed. Check the browser, output folder permissions and network connection.';

async function saveStatus() {
  await atomicWrite(path.join(directory, 'status.json'), JSON.stringify({ lastExport: status.lastExport, lastSync: status.lastSync }));
}

async function refresh() {
  if (busy || stopping) return;
  // A regular sign-in browser must finish writing its profile before background export.
  // Leave sign-in mode active on an early click, so scheduled refresh stays paused.
  if (session) {
    await session.finish();
    session = null;
  }
  busy = true;
  status.message = 'Refreshing YouTube cookies...';
  publish();
  let active;
  try {
    active = await openBrowser(directory, config.browser);
    status.browserIdentity = active.identity.description;
    publish();
    const { cookies, userAgent } = await refreshCookies(active);
    const { text, count } = youtubeCookies(cookies, { userAgent });
    await active.close();
    active = null;
    await atomicWrite(config.output, text);
    status.lastExport = new Date().toISOString();
    await saveStatus();
    if (config.sshEnabled) {
      await syncSSH(config, text);
      status.lastSync = new Date().toISOString();
      await saveStatus();
    }
    failures = 0;
    status.error = false;
    status.message = `Exported ${count} YouTube cookies with browser user agent${config.sshEnabled ? ' and synced to server' : ''}.`;
  } catch (error) {
    failures++;
    status.error = true;
    status.message = safeError(error);
  } finally {
    await active?.close().catch(() => {});
    busy = false;
    status.nextRun = nextRefresh(config, failures);
    publish();
  }
}

async function command(message) {
  if (stopping) return;
  if (message.action === 'quit') { await shutdown(); return; }
  if (message.action === 'get') { emit({ type: 'config', config }); publish(); return; }
  if (busy) throw new HelperError('Wait for the current operation to finish.');
  if (message.action === 'save') {
    if (session) throw new HelperError('Finish or cancel sign-in before changing settings.');
    busy = true;
    try {
      const candidate = validateConfig(message.config, directory);
      await atomicWrite(path.join(directory, 'settings.json'), JSON.stringify(candidate, null, 2));
      config = candidate;
      status.nextRun = config.enabled ? Date.now() + 1000 : null;
      status.message = config.enabled ? 'Settings saved. Automatic refresh enabled.' : 'Settings saved. Automatic refresh paused.';
      status.error = false;
      emit({ type: 'saved', config });
    } finally { busy = false; publish(); }
  } else if (message.action === 'refresh') {
    await refresh();
  } else if (message.action === 'signIn') {
    if (session?.isOpen) {
      status.message = 'Sign in in the browser, close its windows, then click Finish sign-in here.';
      status.error = false;
      publish();
      return;
    }
    busy = true;
    status.message = 'Opening your dedicated YouTube browser...';
    publish();
    try {
      const opened = await openSignInBrowser(directory, config.browser);
      session = opened;
      status.browserIdentity = 'Installed browser during sign-in; automatic Chrome version during refresh';
      status.message = 'Sign in in the browser, close its windows, then click Finish sign-in here.';
      status.error = false;
      void opened.closed.then(() => {
        if (session !== opened || stopping) return;
        status.message = 'Browser closed. Click Finish sign-in to export, or Sign in to reopen it.';
        status.error = false;
        publish();
      });
    } catch (error) {
      const failed = session;
      session = null;
      await failed?.close();
      throw error;
    } finally { busy = false; publish(); }
  } else if (message.action === 'cancel') {
    const active = session;
    busy = true;
    try { await active?.close(); session = null; }
    finally { busy = false; publish(); }
    status.message = 'Sign-in closed. Previous export preserved.';
    status.error = false;
    status.nextRun = nextRefresh(config, failures);
    publish();
  }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  const active = session;
  session = null;
  await active?.close().catch(() => {});
  // A refresh already in flight owns its browser and finishes cleanup before exiting.
  while (busy) await new Promise(resolve => setTimeout(resolve, 100));
  const openedDuringShutdown = session;
  session = null;
  await openedDuringShutdown?.close().catch(() => {});
  process.exit(0);
}

let timer;
try {
  await privateDirectory(directory);
  config = await readConfig(directory);
  try {
    const saved = JSON.parse(await readFile(path.join(directory, 'status.json'), 'utf8'));
    for (const key of ['lastExport', 'lastSync']) if (typeof saved[key] === 'string' && Number.isFinite(Date.parse(saved[key]))) status[key] = saved[key];
  } catch {}
  status.nextRun = config.enabled ? Date.now() + 10000 : null;
  emit({ type: 'config', config });
  publish();
  timer = setInterval(() => {
    if (!busy && !session && status.nextRun && Date.now() >= status.nextRun) void refresh();
  }, 1000);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  // Serialize configuration commands; refresh sets busy synchronously before its first await.
  let commands = Promise.resolve();
  input.on('line', line => {
    commands = commands.then(() => command(JSON.parse(line))).catch(error => {
      status.error = true; status.message = safeError(error); publish();
    });
  });
  input.on('close', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());
} catch (error) {
  emit({ type: 'fatal', message: safeError(error) });
  process.exitCode = 1;
}
