import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { YouTube, runJSON } from '../server/youtube.js';

const cookieText = '# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\ttest-secret-cookie\n';
const extractor = `
  import { readFile, writeFile, stat } from 'node:fs/promises';
  import path from 'node:path';
  const args = process.argv.slice(1);
  const index = args.indexOf('--cookies');
  const file = index < 0 ? null : args[index + 1];
  const contents = file ? await readFile(file, 'utf8') : null;
  const mode = file ? (await stat(file)).mode & 0o777 : null;
  const directoryMode = file ? (await stat(path.dirname(file))).mode & 0o777 : null;
  if (file) await writeFile(file, '# rewritten by extractor\\n');
  const data = { args, file, contents, mode, directoryMode,
    id: 'jNQXAC9IVRw', title: 'Test video', duration: 19,
    url: 'https://test.googlevideo.com/video' };
  if (args.includes('--require-cookies') && !file) {
    process.stderr.write('Missing cookies');
    process.exit(1);
  }
  if (args.includes('--fixture-fail')) {
    process.stderr.write(contents || 'Fixture extraction failed');
    process.exit(1);
  }
  if (args.includes('--fixture-invalid')) {
    process.stdout.write(contents || 'not JSON');
  } else if (args.includes('--fixture-wait')) {
    await writeFile(args[args.indexOf('--fixture-wait') + 1], JSON.stringify(data));
    setInterval(() => {}, 1000);
  } else {
    process.stdout.write(JSON.stringify(data));
  }
`;

async function fixture(t, authenticated = true) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'youtube-cookies-'));
  const temporary = path.join(dir, 'temporary');
  const source = path.join(dir, 'private cookies.txt');
  await mkdir(temporary);
  await writeFile(source, cookieText, { mode: 0o600 });
  await chmod(source, 0o400);
  t.mock.method(os, 'tmpdir', () => temporary);
  const youtube = new YouTube({ ytdlp: process.execPath, ytdlpCookiesFile: authenticated ? source : '' });
  youtube.baseArgs = ['--input-type=module', '-e', extractor, '--', ...youtube.baseArgs];
  t.after(async () => {
    youtube.close();
    await chmod(source, 0o600);
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, temporary, source, youtube };
}

test('YouTube cookies are opt-in through YTDLP_COOKIES_FILE', () => {
  for (const value of ['', 'private cookies.txt']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { config } from "./server/config.js"; console.log(JSON.stringify(config.ytdlpCookiesFile));'], {
      encoding: 'utf8', env: { ...process.env, YTDLP_COOKIES_FILE: value }, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), value);
  }
});

test('anonymous extraction does not create or pass a cookie file', async t => {
  const f = await fixture(t, false);
  const result = await f.youtube.extract(['--dump-single-json', '--', 'https://www.youtube.com/watch?v=jNQXAC9IVRw']);
  assert.equal(result.file, null);
  assert.ok(result.args.includes('--ignore-config'));
  assert.ok(!result.args.includes('--cookies'));
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
});

test('each concurrent extraction gets a private writable copy and preserves the read-only secret', async t => {
  const f = await fixture(t);
  const results = await Promise.all([f.youtube.extract(['first']), f.youtube.extract(['second'])]);
  assert.notEqual(results[0].file, results[1].file);
  for (const result of results) {
    assert.equal(result.contents, cookieText);
    assert.notEqual(result.file, f.source);
    assert.ok(result.file.startsWith(f.temporary + path.sep));
    assert.ok(!result.args.includes(f.source));
    assert.ok(!result.args.join(' ').includes('test-secret-cookie'));
    if (process.platform !== 'win32') {
      assert.equal(result.mode, 0o600);
      assert.equal(result.directoryMode, 0o700);
    }
    await assert.rejects(stat(path.dirname(result.file)), { code: 'ENOENT' });
  }
  assert.equal(await readFile(f.source, 'utf8'), cookieText);
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
});

test('cookies reach both queue metadata and playback URL extraction', async t => {
  const f = await fixture(t);
  f.youtube.baseArgs.push('--require-cookies');
  const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
  const [item] = await f.youtube.items(url, { displayName: 'Viewer' });
  assert.equal(item.title, 'Test video');
  const stream = await f.youtube.resolve(url);
  assert.equal(stream.inputs[0].url, 'https://test.googlevideo.com/video');
  assert.deepEqual(await readdir(f.temporary), []);
});

test('a missing configured secret fails closed without starting anonymous extraction', async t => {
  const f = await fixture(t);
  f.youtube.config.ytdlpCookiesFile = path.join(f.dir, 'missing');
  await assert.rejects(f.youtube.extract([]), /YTDLP_COOKIES_FILE/);
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
});

test('extractor errors never expose cookie lines and always remove the working copy', async t => {
  const f = await fixture(t);
  for (const option of ['--fixture-fail', '--fixture-invalid']) {
    await assert.rejects(f.youtube.extract([option]), error => {
      assert.ok(!error.message.includes('test-secret-cookie'));
      assert.ok(!error.message.includes(cookieText));
      assert.match(error.message, /cookies|metadata/i);
      return true;
    });
    assert.deepEqual(await readdir(f.temporary), []);
    assert.equal(f.youtube.pending.size, 0);
  }
  f.youtube.config.ytdlp = path.join(f.dir, 'missing-executable');
  await assert.rejects(f.youtube.extract([]));
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
});

test('shutdown waits for the child to close before removing its cookie copy', { timeout: 10000 }, async t => {
  const f = await fixture(t);
  const ready = path.join(f.dir, 'ready.json');
  const running = f.youtube.extract(['--fixture-wait', ready]);
  const rejected = running.then(() => null, error => error);
  let data;
  for (let attempt = 0; attempt < 200; attempt++) {
    try { data = JSON.parse(await readFile(ready, 'utf8')); break; }
    catch { await delay(20); }
  }
  assert.ok(data, 'Extractor started and read its cookie file');
  f.youtube.close();
  assert.equal((await rejected)?.name, 'AbortError');
  assert.equal(data.contents, cookieText);
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
});

test('cancellation during cookie preparation still cleans up and preserves the concurrency limit', async t => {
  const f = await fixture(t);
  const running = Array.from({ length: 4 }, () => f.youtube.extract([]).catch(error => error));
  await assert.rejects(f.youtube.extract([]), error => error.status === 429);
  f.youtube.close();
  for (const error of await Promise.all(running)) assert.equal(error.name, 'AbortError');
  assert.deepEqual(await readdir(f.temporary), []);
  assert.equal(f.youtube.pending.size, 0);
  assert.equal(await readFile(f.source, 'utf8'), cookieText);
});

test('subprocess timeout still rejects after closing the child', async () => {
  await assert.rejects(runJSON(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 100 }), /timed out/);
});