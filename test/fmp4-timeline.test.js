import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fmp4Timeline} from '../server/fmp4-timeline.js';

function box(type, ...data) {
  const payload = Buffer.concat(data);
  const header = Buffer.alloc(8);
  header.writeUInt32BE(payload.length + 8);
  header.write(type, 4);
  return Buffer.concat([header, payload]);
}

function track(id, type, scale, version = 0) {
  const offset = version ? 20 : 12;
  const tkhd = Buffer.alloc(offset + 4), mdhd = Buffer.alloc(offset + 4), hdlr = Buffer.alloc(12);
  tkhd[0] = mdhd[0] = version;
  tkhd.writeUInt32BE(id, offset);
  mdhd.writeUInt32BE(scale, offset);
  hdlr.write(type, 8);
  return box('trak', box('tkhd', tkhd), box('mdia', box('mdhd', mdhd), box('hdlr', hdlr)));
}

function fragment(id, ticks, samples = 1, version = 1) {
  const tfhd = Buffer.alloc(8), tfdt = Buffer.alloc(version ? 12 : 8), trun = Buffer.alloc(8);
  tfhd.writeUInt32BE(id, 4);
  tfdt[0] = version;
  if (version) tfdt.writeBigUInt64BE(BigInt(ticks), 4);
  else tfdt.writeUInt32BE(ticks, 4);
  trun.writeUInt32BE(samples, 4);
  return box('traf', box('tfhd', tfhd), box('tfdt', tfdt), box('trun', trun));
}

async function fixture(t) {
  await mkdir('test-artifacts', {recursive: true});
  const dir = await mkdtemp(path.resolve('test-artifacts', 'timeline-'));
  t.after(() => rm(dir, {recursive: true, force: true}));
  const init = path.join(dir, 'init.mp4'), segment = path.join(dir, 'segment.m4s');
  return {init, segment, read: () => fmp4Timeline(init, segment)};
}

test('copied timelines use track timescales and account for audio before the video keyframe', async t => {
  const f = await fixture(t);
  await writeFile(f.init, box('moov', track(1, 'vide', 16000), track(2, 'soun', 48000, 1)));
  await writeFile(f.segment, Buffer.concat([box('styp'), box('moof', fragment(1, 96000), fragment(2, 240048))]));
  assert.deepEqual(await f.read(), {baseTime: 5.001, leadingDuration: 0.9989999999999997});
  await writeFile(f.segment, box('moof', fragment(1, 96000), fragment(2, 336048)));
  assert.deepEqual(await f.read(), {baseTime: 6, leadingDuration: 0});
});

test('empty tracks cannot reset the timeline and large 64-bit timestamps remain accurate', async t => {
  const f = await fixture(t);
  await writeFile(f.init, box('moov', track(1, 'vide', 90000), track(2, 'soun', 48000)));
  await writeFile(f.segment, box('moof', fragment(1, 9000000000), fragment(2, 0, 0, 0)));
  assert.deepEqual(await f.read(), {baseTime: 100000, leadingDuration: 0});
});

test('missing tracks, malformed boxes and edit lists fail instead of guessing an offset', async t => {
  const f = await fixture(t);
  await writeFile(f.init, box('moov', track(1, 'vide', 90000)));
  for (const bytes of [Buffer.alloc(7), box('moof', fragment(2, 90000)), box('mdat', Buffer.alloc(8))]) {
    await writeFile(f.segment, bytes);
    await assert.rejects(f.read());
  }
  const video = track(1, 'vide', 90000).subarray(8);
  await writeFile(f.init, box('moov', box('trak', video, box('edts'))));
  await writeFile(f.segment, box('moof', fragment(1, 90000)));
  await assert.rejects(f.read(), /timeline/);
});
