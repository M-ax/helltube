import test from 'node:test';
import assert from 'node:assert/strict';
import { orthographicProjection, videoRect } from '../src/lib/video-renderer.js';

test('orthographic projection maps top-left screen coordinates without perspective', () => {
  const projection = orthographicProjection(800, 600);
  const project = (x, y, z) => [
    projection[0] * x + projection[12],
    projection[5] * y + projection[13],
    projection[10] * z + projection[14],
    projection[15],
  ];
  for (const [point, expected] of [
    [[0, 0, 0], [-1, 1, 0, 1]],
    [[800, 600, 0], [1, -1, 0, 1]],
    [[400, 300, 0.5], [0, 0, -0.5, 1]],
  ]) {
    project(...point).forEach((value, index) => assert.ok(Math.abs(value - expected[index]) < 0.00001));
  }
  assert.equal(projection[3], 0);
  assert.equal(projection[7], 0);
  assert.equal(projection[11], 0);
});

test('video plane preserves landscape and portrait aspect ratios with centered letterboxing', () => {
  assert.deepEqual(videoRect(1280, 720, 1920, 1080), [0, 0, 1280, 720]);
  assert.deepEqual(videoRect(800, 600, 1920, 1080), [0, 75, 800, 450]);
  assert.deepEqual(videoRect(800, 600, 1080, 1920), [231.25, 0, 337.5, 600]);
  assert.deepEqual(videoRect(400, 300, 320, 240), [0, 0, 400, 300]);
});

test('video plane waits for metadata and ignores zero-sized or invalid viewports', () => {
  for (const dimensions of [[0, 600, 320, 180], [800, 0, 320, 180], [800, 600, 0, 0],
    [800, 600, NaN, 180], [800, Infinity, 320, 180], [800, 600, -1, 180]]) {
    assert.equal(videoRect(...dimensions), null);
  }
});