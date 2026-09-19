import { createInterface } from 'node:readline';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, HelperError, nextRefresh, privateDirectory, readConfig, syncSSH, validateConfig, youtubeCookies } from './core.mjs';
import { openBrowser, refreshCookies } from './browser.mjs';

const directory = path.resolve(process.argv[2]);
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
let config, session, busy = false, stopping = false, failures = 0;
let status = { message: 'Ready. Sign in to YouTube to create your first export.', lastExport: null, lastSync: null, nextRun: null, error: false,
  browserIdentity: 'Automatic Chrome version (worldwide usage)' };
const publish = () => emit({ type: 'status', ...status, busy, signingIn: !!session });
const safeError = error => error instanceof HelperError ? error.message : 'Operation failed. Check the browser, output folder permissions and network connection.';

async function saveStatus() {
  await atomicWrite(path.join(directory, 'status.json'), JSON.stringify({ lastExport: status.lastExport, lastSync: status.lastSync }));
}

async function refresh() {
  if (busy || stopping) return;
  busy = true;
  status.message = session ? 'Finishing sign-in and exporting cookies...' : 'Refreshing YouTube cookies...';
  publish();
  let active = session;
  session = null;
  try {
    active ||= await openBrowser(directory, config.browser, false);
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
    if (session) { await session.page.bringToFront(); return; }
    busy = true;
    status.message = 'Opening your dedicated YouTube browser...';
    publish();
    try {
      session = await openBrowser(directory, config.browser, true);
      status.browserIdentity = session.identity.description;
      await session.page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
      status.message = 'Sign in in the browser, then click Finish sign-in here. Keep the browser open until then.';
      status.error = false;
      session.browser.on('disconnected', () => {
        if (!session) return;
        session = null;
        status.message = 'Sign-in browser closed. Choose Refresh now to export, or Sign in to reopen it.';
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
    session = null;
    busy = true;
    try { await active?.close(); } finally { busy = false; }
    status.message = 'Sign-in closed. Previous export preserved.';
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
