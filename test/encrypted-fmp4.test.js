import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes, createDecipheriv} from 'node:crypto';
import fs from 'node:fs/promises';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import path from 'node:path';
import {EncryptedFmp4} from '../server/encrypted-fmp4.js';
import {sponsorPlaylist} from '../server/sponsorblock.js';

async function fixture(t) {
  await mkdir('test-artifacts', {recursive: true});
  const dir = await mkdtemp(path.resolve('test-artifacts', 'fmp4-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const job = {id: 'fixture', key: randomBytes(16), dir: path.join(dir, 'public'), clearDir: path.join(dir, 'private')};
  await mkdir(job.dir);
  await mkdir(job.clearDir);
  const publisher = new EncryptedFmp4(job);
  return {job, publisher};
}

test('growing fMP4 publication is atomic, encrypts initialization, preserves keys and removes plaintext fragments', async t => {
  const {job, publisher} = await fixture(t);
  const header = '#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-MAP:URI="init.mp4"\n';
  const first = `${header}#EXTINF:2,\nsegment-000000.m4s\n`;
  const bytes = randomBytes(128);
  await writeFile(path.join(job.clearDir, 'init.mp4'), bytes);
  await writeFile(path.join(job.clearDir, 'segment-000000.m4s'), bytes);
  await writeFile(path.join(job.clearDir, 'index.m3u8'), first);
  await Promise.all([publisher.publish(), publisher.publish()]);
  const iv = sequence => {const value = Buffer.alloc(16); value.writeBigUInt64BE(BigInt(sequence), 8); return value;};
  const decrypt = async (file, sequence) => {
    const encrypted = await readFile(path.join(job.dir, file));
    const cipher = createDecipheriv('aes-128-cbc', job.key, iv(sequence));
    assert.notDeepEqual(encrypted, bytes);
    assert.deepEqual(Buffer.concat([cipher.update(encrypted), cipher.final()]), bytes);
    return encrypted;
  };
  const init = await decrypt('init.mp4', 0);
  const segment = await decrypt('segment-000000.m4s', 1);
  assert.notDeepEqual(init, segment, 'Identical bytes have distinct IVs.');
  assert.deepEqual((await readdir(job.clearDir)).sort(), ['index.m3u8', 'init.mp4']);
  await writeFile(path.join(job.clearDir, 'segment-000001.m4s'), bytes);
  await writeFile(path.join(job.clearDir, 'index.m3u8'), first + '#EXTINF:2,\nsegment-000001.m4s\n#EXT-X-ENDLIST\n');
  await publisher.publish();
  await decrypt('segment-000001.m4s', 2);
  assert.deepEqual(await readFile(path.join(job.dir, 'segment-000000.m4s')), segment);
  const contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
  assert.ok(contents.includes('#EXT-X-ENDLIST'));
  assert.equal(contents.match(/#EXT-X-KEY:/g).length, 3);
  const gaps = sponsorPlaylist(contents, {kind: 'youtube', sponsorSegments: [[0, 2]]});
  assert.ok(gaps.includes('#EXT-X-GAP\nsegment-000000.m4s'));
  assert.ok(!gaps.includes('#EXT-X-GAP\nsegment-000001.m4s'));
  assert.deepEqual(gaps.match(/#EXT-X-KEY:.*$/gm), contents.match(/#EXT-X-KEY:.*$/gm));
  assert.deepEqual(await readdir(job.dir), ['index.m3u8', 'init.mp4', 'segment-000000.m4s', 'segment-000001.m4s']);
  job.cancelled = true;
  await writeFile(path.join(job.clearDir, 'index.m3u8'), first);
  await publisher.publish();
  assert.equal(await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'), contents);
});

async function growingFixture(t) {
  const {job, publisher} = await fixture(t);
  const first = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:2,\nsegment-000000.m4s\n';
  for (const file of ['init.mp4', 'segment-000000.m4s']) await writeFile(path.join(job.clearDir, file), randomBytes(128));
  await writeFile(path.join(job.clearDir, 'index.m3u8'), first);
  await publisher.publish();
  const previous = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
  await writeFile(path.join(job.clearDir, 'segment-000001.m4s'), randomBytes(128));
  await writeFile(path.join(job.clearDir, 'index.m3u8'), first + '#EXTINF:2,\nsegment-000001.m4s\n');
  return {job, publisher, previous};
}

function mockRename(t, handler) {
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', (source, target) => handler(source, target, rename));
  syncBuiltinESMExports();
  t.after(() => {mock.mock.restore(); syncBuiltinESMExports();});
}

test('earlier copied audio extends the first segment and its advertised target duration once', async t => {
  const {job, publisher} = await growingFixture(t);
  job.leadingDuration = 1.25;
  await publisher.publish();
  await publisher.publish();
  const contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
  assert.match(contents, /#EXT-X-TARGETDURATION:4\n/);
  assert.deepEqual([...contents.matchAll(/#EXTINF:([\d.]+)/g)].map(match => Number(match[1])), [3.25, 2]);
});

test('temporary playlist locks retain the old playable manifest and recover publication', async t => {
  const {job, publisher, previous} = await growingFixture(t);
  const codes = ['EPERM', 'EBUSY', 'EACCES'];
  let attempts = 0;
  mockRename(t, async (source, target, rename) => {
    if (target === path.join(job.dir, 'index.m3u8') && attempts++ < codes.length) {
      assert.equal(await readFile(target, 'utf8'), previous);
      throw Object.assign(new Error('Playlist in use'), {code: codes[attempts - 1]});
    }
    return rename(source, target);
  });
  await Promise.all([publisher.publish(), publisher.publish()]);
  assert.equal(attempts, 4);
  const contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
  assert.ok(contents.includes('segment-000001.m4s'));
  assert.equal(contents.match(/#EXT-X-KEY:/g).length, 3);
  assert.deepEqual((await readdir(job.clearDir)).sort(), ['index.m3u8', 'init.mp4']);
});

test('persistent playlist locks fail within a bounded time and preserve the old manifest', async t => {
  const {job, publisher, previous} = await growingFixture(t);
  const failure = Object.assign(new Error('Playlist remains locked'), {code: 'EPERM'});
  let attempts = 0;
  mockRename(t, (source, target, rename) => {
    if (target === path.join(job.dir, 'index.m3u8')) {attempts++; throw failure;}
    return rename(source, target);
  });
  await assert.rejects(publisher.publish(), error => error === failure);
  assert.equal(attempts, 7);
  assert.equal(await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'), previous);
});

test('cancelling while a playlist is locked stops publication without replacing the manifest', async t => {
  const {job, publisher, previous} = await growingFixture(t);
  let attempts = 0;
  mockRename(t, (source, target, rename) => {
    if (target === path.join(job.dir, 'index.m3u8')) {
      attempts++;
      job.cancelled = true;
      throw Object.assign(new Error('Playlist in use'), {code: 'EBUSY'});
    }
    return rename(source, target);
  });
  await publisher.publish();
  assert.equal(attempts, 1);
  assert.equal(await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'), previous);
});
