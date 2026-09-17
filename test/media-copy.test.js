import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {mkdir, mkdtemp, rm, writeFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {Media} from '../server/media.js';
import {until} from './helpers.js';

async function fixture(t) {
  await mkdir('test-artifacts', {recursive: true});
  const dir = await mkdtemp(path.resolve('test-artifacts', 'copy-'));
  const calls = [];
  const mocked = t.mock.method(childProcess, 'spawn', (_command, args, options) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {child.killed = true; process.nextTick(() => child.emit('close', null));};
    calls.push({child, args, options});
    return child;
  });
  syncBuiltinESMExports();
  const media = new Media({dataDir: dir, ffmpeg: 'fixture', youtubeProxy: 'http://127.0.0.1:8888'},
    {rooms: new Map()}, {}, {resolve: async () => ({duration: 40, copyQuality: {label: 'Original (1080p)'},
      inputs: [{url: 'https://video.googlevideo.com/source.m3u8', headers: {Referer: 'https://youtube.com/'}}]})});
  const item = {id: 'item', kind: 'youtube', source: {url: 'https://youtube.com/watch?v=jNQXAC9IVRw'}};
  media.start(item, 10);
  const job = media.jobs.get(item.id);
  t.after(async () => {
    media.dispose(job);
    await job.cleanup;
    mocked.mock.restore();
    syncBuiltinESMExports();
    await rm(dir, {recursive: true, force: true});
  });
  await until(() => calls.length === 2);
  const copy = calls.find(call => call.args.includes('copy'));
  const encode = calls.find(call => call.args.includes('libx264'));
  const complete = async call => {
    await writeFile(call.args.at(-1), '#EXTM3U\n#EXTINF:20,\nsegment-000000.ts\n#EXT-X-ENDLIST\n');
    call.child.emit('close', 0);
  };
  return {media, job, item, copy, encode, complete};
}

test('copy and encoding run concurrently with isolated keys, shared network rules and seek timelines', async t => {
  const {media, job, item, copy, encode, complete} = await fixture(t);
  assert.ok(!copy.args.includes('-vf') && !copy.args.includes('-c:v') && !copy.args.includes('-r'));
  assert.ok(!copy.args.includes('-ss'), 'Copy retains the zero-based source timeline.');
  assert.equal(encode.args[encode.args.indexOf('-ss') + 1], '10');
  for (const call of [copy, encode]) {
    assert.equal(call.args[call.args.indexOf('-http_proxy') + 1], 'http://127.0.0.1:8888');
    assert.match(call.args[call.args.indexOf('-headers') + 1], /Referer: https:\/\/youtube.com\//);
    assert.ok(call.args.includes('-hls_key_info_file'));
  }
  assert.notDeepEqual(job.key, job.original.key);
  assert.equal(media.allJobs().length, 2);
  await complete(copy);
  await media.refresh(job);
  assert.equal(item.media.id, 'original', 'Copy can play while encoding is still running.');
  assert.equal(job.done, false);
  await complete(encode);
  await job.task;
  assert.equal(job.done, true);
  assert.deepEqual(item.media.qualities.map(quality => [quality.id, quality.baseTime]), [['original', 0], ['standard', 10]]);
});

for (const failed of ['copy', 'encode']) {
  test(`a failed ${failed} process leaves the other quality playable`, async t => {
    t.mock.method(console, 'error', () => {});
    const context = await fixture(t);
    context[failed].child.emit('close', 1);
    await context.complete(context[failed === 'copy' ? 'encode' : 'copy']);
    await context.job.task;
    assert.equal(context.item.status, 'ready');
    assert.equal(context.item.media.qualities.length, 1);
    assert.equal(context.item.media.id, failed === 'copy' ? 'standard' : 'original');
  });
}

test('cancelling kills both processes and removes both renditions and keys', async t => {
  const {media, job, copy, encode} = await fixture(t);
  media.dispose(job);
  await job.cleanup;
  assert.ok(copy.child.killed && encode.child.killed);
  assert.equal(media.allJobs().length, 0);
  for (const rendition of [job, job.original]) {
    assert.deepEqual(rendition.key, Buffer.alloc(16));
    await assert.rejects(stat(rendition.dir), {code: 'ENOENT'});
    await assert.rejects(stat(rendition.keyDir), {code: 'ENOENT'});
  }
});

test('publication failure keeps its cause after stopping Original and leaves Standard playable', async t => {
  const logged = t.mock.method(console, 'error', () => {});
  const {media, job, item, copy, encode, complete} = await fixture(t);
  const failure = new Error('Playlist publication failed');
  job.original.publisher = {pending: Promise.resolve(), publish: async () => {throw failure;}};
  await media.refresh(job);
  assert.ok(copy.child.killed);
  await complete(encode);
  await job.task;
  assert.equal(job.original.failed, failure);
  assert.equal(item.status, 'ready');
  assert.deepEqual(item.media.qualities.map(quality => quality.id), ['standard']);
  assert.ok(logged.mock.calls.some(call => call.arguments[0] === 'Original HLS publication:' &&
    call.arguments[1] === failure.message));
});
