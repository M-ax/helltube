import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import path from 'node:path';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {metadataDuration, probeCommand, probeDuration, HOSTED_INPUT_FORMATS} from '../server/media-metadata.js';
import {Media} from '../server/media.js';

const source = 'http://127.0.0.1:3000/internal/remote/job?key=private-test-key';

function mockProcesses(t, launch) {
  const calls = [];
  const mocked = t.mock.method(childProcess, 'spawn', (command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = signal => {
      child.killed = signal || 'SIGTERM';
      process.nextTick(() => child.emit('close', null));
      return true;
    };
    calls.push({command, args, options, child});
    process.nextTick(() => launch(child, command, args));
    return child;
  });
  syncBuiltinESMExports();
  t.after(() => { mocked.mock.restore(); syncBuiltinESMExports(); });
  return calls;
}

test('metadata accepts a finite duration and falls back to the longest audio/video stream', () => {
  assert.equal(metadataDuration('{"format":{"duration":"123.456"}}'), 123.456);
  assert.equal(metadataDuration(JSON.stringify({format: {duration: 'N/A'}, streams: [
    {codec_type: 'audio', duration: '15.1'}, {codec_type: 'video', duration: '15'},
    {codec_type: 'subtitle', duration: '9000'}]})), 15.1);
  for (const duration of [null, '', 0, -1, 'N/A', 'Infinity', 'NaN', true, {}, '1e100']) {
    assert.equal(metadataDuration(JSON.stringify({format: {duration}})), null);
  }
  for (const output of ['bad JSON', '{}', 'null', '{"streams":{}}']) assert.equal(metadataDuration(output), null);
});

test('ffprobe uses the configured executable or the FFmpeg sibling', () => {
  assert.equal(probeCommand({ffprobe: 'custom-probe'}), 'custom-probe');
  assert.equal(path.dirname(probeCommand({ffmpeg: path.join('tools', 'bin', 'ffmpeg')})), path.join('tools', 'bin'));
  assert.match(path.basename(probeCommand()), /^ffprobe(?:\.exe)?$/);
});

test('probe requests only bounded metadata through the loopback source and excludes inherited proxies', async t => {
  const previous = process.env.https_proxy;
  process.env.https_proxy = 'http://should-not-receive-internal-grants.invalid';
  t.after(() => {
    if (previous === undefined) delete process.env.https_proxy;
    else process.env.https_proxy = previous;
  });
  const calls = mockProcesses(t, child => {
    child.stdout.write('{"format":{"duration":"60"}}');
    child.emit('close', 0);
  });
  assert.equal(await probeDuration(source), 60);
  const {args, options} = calls[0];
  assert.equal(args[args.indexOf('-i') + 1], source);
  assert.equal(args[args.indexOf('-protocol_whitelist') + 1], 'http,tcp');
  assert.equal(args[args.indexOf('-format_whitelist') + 1], HOSTED_INPUT_FORMATS);
  assert.ok(!HOSTED_INPUT_FORMATS.includes('hls') && !HOSTED_INPUT_FORMATS.includes('dash'));
  assert.ok(!args.includes('-ss'), 'Metadata describes the full file even when preparing a seek.');
  assert.equal(args[args.indexOf('-show_entries') + 1], 'format=duration:stream=codec_type,duration');
  assert.deepEqual(Object.keys(options.env).filter(key => /^(https?|all|no)_proxy$/i.test(key)), []);
  assert.equal(options.windowsHide, true);
  assert.equal(options.stdio[2], 'ignore', 'Probe diagnostics cannot leak source URLs.');
});

test('missing tools, invalid output and unsuccessful probes fall back without rejecting playback', async t => {
  let attempt = 0;
  mockProcesses(t, child => {
    if (attempt++ === 0) child.emit('error', Object.assign(new Error('missing'), {code: 'ENOENT'}));
    else child.stdout.write(attempt === 2 ? 'not JSON' : '{"format":{"duration":90}}');
    child.emit('close', attempt === 3 ? 1 : 0);
  });
  for (let i = 0; i < 3; i++) assert.equal(await probeDuration(source), null);
});

test('oversized output and cancellation discard metadata and stop the child', async t => {
  const calls = mockProcesses(t, child => child.stdout.write('x'.repeat(65537)));
  assert.equal(await probeDuration(source), null);
  assert.equal(calls[0].child.killed, 'SIGTERM');
  const controller = new AbortController();
  const pending = probeDuration(source, {signal: controller.signal});
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(calls[1].child.killed, 'SIGTERM');
  assert.equal(await probeDuration(source, {signal: controller.signal}), null);
  assert.equal(calls.length, 2, 'An already cancelled job never spawns a process.');
});

test('a hanging probe is time limited', async t => {
  // A real child owns a live handle; keep the equivalent mocked process alive until timeout.
  const keepAlive = setInterval(() => {}, 100);
  t.after(() => clearInterval(keepAlive));
  const calls = mockProcesses(t, () => {});
  assert.equal(await probeDuration(source, {timeoutMs: 20}), null);
  assert.equal(calls[0].child.killed, 'SIGTERM');
});

async function mediaFixture(t, duration = null, startAt = 0) {
  await mkdir('test-artifacts', {recursive: true});
  const dir = await mkdtemp(path.resolve('test-artifacts', 'metadata-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const media = new Media({dataDir: dir, port: 3000, ffmpeg: 'test-ffmpeg', ffprobe: 'test-ffprobe'},
    {rooms: new Map()}, {}, {});
  const item = {id: 'item', kind: 'http', duration, source: {url: 'https://upstream.invalid/file?signature=secret'}};
  media.start(item, startAt);
  return {media, item, job: media.jobs.get(item.id)};
}

test('duration is available before conversion; known durations skip probing on a later seek', async t => {
  let current;
  const calls = mockProcesses(t, (child, command) => {
    if (command === 'test-ffprobe') child.stdout.write('{"format":{"duration":"60"}}');
    else {
      assert.equal(current.item.duration, 60);
      current.job.cancelled = true; // No fake HLS output is needed for this source lifecycle check.
    }
    child.emit('close', 0);
  });
  current = await mediaFixture(t);
  await current.job.task;
  assert.deepEqual(calls.map(call => call.command), ['test-ffprobe', 'test-ffmpeg']);
  assert.ok(calls[0].args.at(-1).startsWith('http://127.0.0.1:3000/internal/remote/'));
  current = await mediaFixture(t, 60, 30);
  await current.job.task;
  assert.equal(calls.filter(call => call.command === 'test-ffprobe').length, 1);
});

test('an out-of-range hosted start is rejected after probing and before conversion', async t => {
  const calls = mockProcesses(t, child => {
    child.stdout.write('{"format":{"duration":"10"}}');
    child.emit('close', 0);
  });
  const {job, item} = await mediaFixture(t, null, 10);
  await job.task;
  assert.equal(item.status, 'error');
  assert.match(item.error, /before the end/);
  assert.deepEqual(calls.map(call => call.command), ['test-ffprobe']);
});

test('a failed optional probe still starts the normal converter', async t => {
  let current;
  const calls = mockProcesses(t, (child, command) => {
    if (command === 'test-ffprobe') {
      child.emit('error', Object.assign(new Error('missing'), {code: 'ENOENT'}));
      child.emit('close', -1);
    } else {
      assert.equal(current.item.duration, null);
      current.job.cancelled = true;
      child.emit('close', 0);
    }
  });
  current = await mediaFixture(t);
  await current.job.task;
  assert.deepEqual(calls.map(call => call.command), ['test-ffprobe', 'test-ffmpeg']);
  assert.notEqual(current.item.status, 'error');
});

test('removing a job during probing prevents stale metadata and conversion', async t => {
  const started = Promise.withResolvers();
  const calls = mockProcesses(t, child => started.resolve(child));
  const {media, job, item} = await mediaFixture(t);
  await started.promise;
  media.dispose(job);
  calls[0].child.stdout.write('{"format":{"duration":"999"}}');
  await job.cleanup;
  assert.equal(item.duration, null);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].child.killed, 'SIGTERM');
  assert.equal(media.jobs.size, 0);
});
