import test from 'node:test';
import assert from 'node:assert/strict';
import { containsTime, PreviewSegments } from '../src/lib/seek-preview.js';

const ranges = (...entries) => ({ length: entries.length, start: i => entries[i][0], end: i => entries[i][1] });
const frag = (sn, start = sn * 2) => ({ sn, start, duration: 2, cc: 0, level: 0 });
function append(cache, fragment, data = new Uint8Array([1, 2, 3]), offset = 0) {
  cache.append({ frag: fragment, data, offset });
  cache.complete(fragment);
}

test('seek preview checks actual local ranges, not the server buffer or gaps', () => {
  const buffered = ranges([2, 8], [10, 16]);
  for (const time of [-1, 0, 8, 9, 16, NaN, Infinity]) assert.equal(containsTime(buffered, time), false);
  for (const time of [2, 7.99, 10, 15.99]) assert.equal(containsTime(buffered, time), true);
});

test('preview segments require completed local data and preserve timestamp offsets', () => {
  const cache = new PreviewSegments();
  const fragment = frag(2);
  const data = new Uint8Array([1, 2, 3]);
  cache.append({ frag: fragment, data, offset: -1.4 });
  assert.equal(cache.find(5, ranges([0, 10])), null);
  cache.complete(fragment);
  data.fill(9);
  const entry = cache.find(5, ranges([0, 10]));
  assert.deepEqual(entry.chunks[0].data, new Uint8Array([1, 2, 3]));
  assert.equal(entry.chunks[0].offset, -1.4);
  assert.equal(cache.find(5, ranges([6, 10])), null);
  assert.equal(cache.find(6, ranges([0, 10])), null);
  cache.clear();
  assert.equal(cache.bytes, 0);
  assert.equal(cache.find(5, ranges([0, 10])), null);
});

test('preview cache is byte bounded and evicts data removed from playback memory', () => {
  const cache = new PreviewSegments(7);
  for (let index = 0; index < 3; index++) append(cache, frag(index));
  assert.equal(cache.bytes, 6);
  assert.equal(cache.find(1, ranges([0, 6])), null);
  assert.ok(cache.find(3, ranges([0, 6])));
  cache.prune(ranges([4, 6]), 4);
  assert.equal(cache.bytes, 3);
  append(cache, frag(30));
  cache.prune(ranges([4, 6], [60, 62]), 4);
  assert.equal(cache.find(61, ranges([60, 62])), null);
  append(cache, frag(5), new Uint8Array(8));
  assert.equal(cache.bytes, 0, 'An oversized fragment cannot escape the memory limit.');
});

test('preview uses final video PTS boundaries and replaces retransmitted fragments', () => {
  const cache = new PreviewSegments();
  const fragment = { ...frag(0), elementaryStreams: { video: { startPTS: .067, endPTS: 2.067 } } };
  append(cache, fragment);
  assert.equal(cache.find(.02, ranges([0, 3])), null);
  assert.ok(cache.find(2.03, ranges([0, 3])));
  append(cache, fragment, new Uint8Array([4]));
  assert.equal(cache.bytes, 1);
  assert.deepEqual(cache.find(1, ranges([0, 3])).chunks[0].data, new Uint8Array([4]));
});