import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite, defaults, nextRefresh, sshArguments, validateConfig, youtubeCookies } from '../tools/cookie-helper/core.mjs';
import { cookieUserAgent, COOKIE_USER_AGENT_MARKER } from '../shared/youtube-cookie-metadata.js';

const cookie = (overrides = {}) => ({ domain: '.youtube.com', path: '/', name: 'SID', value: 'synthetic-session',
  expires: 2147483647, httpOnly: true, secure: true, ...overrides });
const directory = path.resolve('test-artifacts/cookie-helper');

test('export includes only current unpartitioned YouTube cookies and preserves Netscape fields', () => {
  const result = youtubeCookies([cookie(), cookie({ domain: '.google.com', value: 'unrelated' }),
    cookie({ domain: '.youtube.com.attacker.test', value: 'unrelated' }), cookie({ name: 'expired', expires: 1 }),
    cookie({ name: 'partitioned', partitionKey: 'https://elsewhere.test' }),
    cookie({ domain: 'www.youtube.com', name: 'session', expires: -1, httpOnly: false })]);
  assert.equal(result.count, 2);
  assert.match(result.text, /#HttpOnly_\.youtube.com\tTRUE\t\/\tTRUE\t2147483647\tSID\tsynthetic-session/);
  assert.match(result.text, /www.youtube.com\tFALSE\t\/\tTRUE\t0\tsession/);
  assert.doesNotMatch(result.text, /unrelated|expired|partitioned/);
});

test('invalid or unauthenticated cookies cannot replace a usable export', () => {
  for (const cookies of [[], [cookie({ name: 'VISITOR_INFO1_LIVE' })], [cookie({ expires: 1 })],
    [cookie({ value: 'private\ninjected' })], [cookie({ domain: '.bad_.youtube.com' })], [cookie({ value: 'x'.repeat(1048576) })]]) {
    assert.throws(() => youtubeCookies(cookies), error => !error.message.includes('private'));
  }
});

test('browser identity travels with the export and rejects invalid or ambiguous headers', () => {
  const userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0 Safari/537.36';
  const { text, count } = youtubeCookies([cookie()], { userAgent });
  assert.equal(count, 1);
  assert.equal(text.split('\n')[1], `${COOKIE_USER_AGENT_MARKER} ${userAgent}`);
  assert.equal(cookieUserAgent(text), userAgent);
  assert.equal(cookieUserAgent(text.replaceAll('\n', '\r\n')), userAgent);
  assert.equal(cookieUserAgent(youtubeCookies([cookie()]).text), null);
  for (const invalid of ['', null, ' leading', 'trailing ', 'x\r\nInjected: secret', 'x\tx', 'x\x7f', 'x'.repeat(1025), 'non-ascii-\u00e9']) {
    assert.throws(() => youtubeCookies([cookie()], { userAgent: invalid }), /browser user agent/);
  }
  for (const invalid of [`${COOKIE_USER_AGENT_MARKER} x\rInjected: secret`, `${COOKIE_USER_AGENT_MARKER} x\tx`,
    `${COOKIE_USER_AGENT_MARKER}x`, `${COOKIE_USER_AGENT_MARKER} `, `${COOKIE_USER_AGENT_MARKER} ${'x'.repeat(1025)}`,
    `${text}${COOKIE_USER_AGENT_MARKER} duplicate\n`]) {
    assert.throws(() => cookieUserAgent(invalid), error => !error.message.includes('secret'));
  }
});

test('settings reject command injection, invalid destinations and accidental profile overwrites', () => {
  const base = defaults(directory);
  assert.equal(validateConfig(base, directory).enabled, false);
  for (const override of [{ intervalMinutes: 0 }, { intervalMinutes: '60' }, { enabled: 'yes' }, { output: 'relative.txt' },
    { output: path.join(directory, 'profile-edge', 'cookies.txt') }, { sshIdentity: 'relative.key' },
    { sshEnabled: true, sshHost: '-oProxyCommand=bad', sshUser: 'max' },
    { sshEnabled: true, sshHost: 'server.test', sshUser: 'max;bad' }, { sshPort: 65536 }]) {
    assert.throws(() => validateConfig({ ...base, ...override }, directory));
  }
  const config = validateConfig({ ...base, sshEnabled: true, sshHost: 'metal.example.test', sshUser: 'max' }, directory);
  const args = sshArguments(config);
  assert.ok(args.includes('BatchMode=yes'));
  assert.ok(args.includes('StrictHostKeyChecking=yes'));
  assert.equal(args.at(-1), 'sudo -n /usr/local/sbin/helltube-import-cookies');
  assert.equal(args.at(-2), 'max@metal.example.test');
});

test('automatic refresh is opt-in, backs off after errors and is bounded by the configured interval', () => {
  const config = defaults(directory);
  assert.equal(nextRefresh(config, 0, 1000), null);
  config.enabled = true;
  assert.equal(nextRefresh(config, 0, 1000), 3601000);
  assert.equal(nextRefresh(config, 1, 1000), 301000);
  assert.equal(nextRefresh(config, 2, 1000), 601000);
  assert.equal(nextRefresh(config, 100, 1000), 3601000);
});

test('atomic exports replace complete files and remove temporary files on failure', async () => {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, 'atomic-'));
  const destination = path.join(temporary, 'youtube-cookies.txt');
  await atomicWrite(destination, 'old');
  await atomicWrite(destination, 'new');
  assert.equal(await readFile(destination, 'utf8'), 'new');
  await assert.rejects(atomicWrite(temporary, 'cannot replace a directory'));
  assert.deepEqual(await readdir(temporary), ['youtube-cookies.txt']);
});

test('worker starts paused, validates settings, saves them and shuts down without opening a browser', { timeout: 20000 }, async () => {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, 'worker-'));
  const child = spawn(process.execPath, ['tools/cookie-helper/worker.mjs', temporary], { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const message = JSON.parse(buffered.slice(0, newline));
      buffered = buffered.slice(newline + 1); messages.push(message);
      if (message.type === 'config') {
        child.stdin.write(JSON.stringify({ action: 'save', config: { ...message.config, intervalMinutes: 90 } }) + '\n');
      }
      if (message.type === 'saved') child.stdin.end(JSON.stringify({ action: 'quit' }) + '\n');
    }
  });
  let diagnostics = '';
  child.stderr.on('data', data => { diagnostics += data; });
  const code = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  assert.equal(code, 0, diagnostics);
  assert.equal(messages.find(message => message.type === 'status').nextRun, null);
  assert.equal(JSON.parse(await readFile(path.join(temporary, 'settings.json'), 'utf8')).intervalMinutes, 90);
  assert.ok(!(await readdir(temporary)).some(file => file.startsWith('profile-')));
});

test('corrupt settings produce a safe startup error instead of silently enabling refresh', { timeout: 10000 }, async () => {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, 'invalid-'));
  await writeFile(path.join(temporary, 'settings.json'), '{secret-value');
  const child = spawn(process.execPath, ['tools/cookie-helper/worker.mjs', temporary]);
  let output = '';
  child.stdout.on('data', data => { output += data; });
  const code = await new Promise(resolve => child.on('close', resolve));
  assert.equal(code, 1);
  assert.equal(JSON.parse(output).type, 'fatal');
  assert.doesNotMatch(output, /secret-value/);
});

test('worker keeps refresh paused until the ordinary sign-in browser closes and the user finishes', { timeout: 20000 }, async () => {
  await mkdir(directory, { recursive: true });
  const temporary = await mkdtemp(path.join(directory, 'sign-in-worker-'));
  const output = path.join(temporary, 'youtube-cookies.txt');
  const closed = path.join(temporary, 'browser-closed');
  const refreshed = path.join(temporary, 'refresh-started');
  const browserFixture = path.join(temporary, 'browser-fixture.mjs');
  const loader = path.join(temporary, 'loader.mjs');
  const coreURL = pathToFileURL(path.resolve('tools/cookie-helper/core.mjs')).href;
  const workerURL = pathToFileURL(path.resolve('tools/cookie-helper/worker.mjs')).href;
  await writeFile(output, 'previous export');
  await writeFile(browserFixture, `
    import { existsSync, writeFileSync } from 'node:fs';
    import { HelperError } from ${JSON.stringify(coreURL)};
    export async function openSignInBrowser() {
      let ended = false, finish;
      const closed = new Promise(resolve => { finish = resolve; });
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(closed)})) { ended = true; clearInterval(timer); finish(); }
      }, 10);
      return { closed, get isOpen() { return !ended; },
        async finish() { if (!ended) throw new HelperError('Close all windows before finishing.'); },
        async close() { ended = true; clearInterval(timer); finish(); }
      };
    }
    export async function openBrowser() {
      writeFileSync(${JSON.stringify(refreshed)}, 'started');
      return { identity: { description: 'Synthetic refresh' }, async close() {} };
    }
    export async function refreshCookies() { return { cookies: [${JSON.stringify(cookie())}], userAgent: 'Synthetic Chrome' }; }
  `);
  await writeFile(loader, `export async function resolve(specifier, context, next) {
    if (specifier === './browser.mjs' && context.parentURL === ${JSON.stringify(workerURL)})
      return { url: ${JSON.stringify(pathToFileURL(browserFixture).href)}, shortCircuit: true };
    return next(specifier, context);
  }`);
  const child = spawn(process.execPath, ['--experimental-loader', pathToFileURL(loader).href, 'tools/cookie-helper/worker.mjs', temporary],
    { stdio: ['pipe', 'pipe', 'pipe'] });
  const messages = [];
  let buffered = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', data => {
    buffered += data;
    let newline;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      messages.push(JSON.parse(buffered.slice(0, newline)));
      buffered = buffered.slice(newline + 1);
    }
  });
  child.stderr.resume();
  const exited = new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
  const send = message => { const from = messages.length; child.stdin.write(JSON.stringify(message) + '\n'); return from; };
  async function waitFor(predicate, from = 0) {
    for (let attempt = 0; attempt < 250; attempt++) {
      const message = messages.slice(from).find(predicate);
      if (message) return message;
      await delay(20);
    }
    assert.fail('Timed out waiting for worker sign-in status.');
  }
  try {
    const { config } = await waitFor(message => message.type === 'config');
    let from = send({ action: 'save', config: { ...config, enabled: true } });
    await waitFor(message => message.type === 'saved', from);
    from = send({ action: 'signIn' });
    const signingIn = await waitFor(message => message.type === 'status' && message.signingIn && !message.busy, from);
    assert.equal(signingIn.nextRun, null);
    from = send({ action: 'refresh' });
    const early = await waitFor(message => message.type === 'status' && message.error, from);
    assert.equal(early.signingIn, true);
    assert.match(early.message, /Close all windows/);
    await delay(1300); // Automatic refresh was due, but must remain paused during sign-in.
    await assert.rejects(readFile(refreshed), { code: 'ENOENT' });
    assert.equal(await readFile(output, 'utf8'), 'previous export');
    from = messages.length;
    await writeFile(closed, 'closed');
    const browserClosed = await waitFor(message => message.type === 'status' && /Browser closed/.test(message.message), from);
    assert.equal(browserClosed.signingIn, true);
    assert.equal(browserClosed.nextRun, null);
    from = send({ action: 'save', config });
    await waitFor(message => message.type === 'status' && /Finish or cancel/.test(message.message), from);
    from = send({ action: 'refresh' });
    const exported = await waitFor(message => message.type === 'status' && !message.busy && message.lastExport, from);
    assert.equal(exported.signingIn, false);
    assert.ok(exported.nextRun > Date.now());
    assert.match(await readFile(output, 'utf8'), /SID\tsynthetic-session/);
    assert.equal(cookieUserAgent(await readFile(output, 'utf8')), 'Synthetic Chrome');
    const previous = await readFile(output, 'utf8');
    await rm(closed);
    from = send({ action: 'signIn' });
    await waitFor(message => message.type === 'status' && message.signingIn && !message.busy, from);
    from = send({ action: 'cancel' });
    const cancelled = await waitFor(message => message.type === 'status' && /Previous export preserved/.test(message.message), from);
    assert.equal(cancelled.signingIn, false);
    assert.ok(cancelled.nextRun > Date.now());
    assert.equal(await readFile(output, 'utf8'), previous);
  } finally {
    child.stdin.end(JSON.stringify({ action: 'quit' }) + '\n');
    assert.equal(await exited, 0);
  }
});
