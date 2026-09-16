import test from 'node:test';
import assert from 'node:assert/strict';
import { createBeachBall, resizeBeachBall, advanceBeachBall } from '../src/lib/beach-ball.js';

function assertContained(ball) {
  assert.ok(ball.radius >= 0 && ball.radius <= Math.min(ball.width, ball.height) / 2);
  assert.ok(ball.x >= ball.radius && ball.x <= ball.width - ball.radius);
  assert.ok(ball.y >= ball.radius && ball.y <= ball.height - ball.radius);
  for (const value of Object.values(ball)) assert.ok(Number.isFinite(value));
}

function assertClose(actual, expected) {
  assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} should equal ${expected}`);
}

test('beach ball has a proportional, bounded size on desktop, mobile and tiny viewports', () => {
  for (const [width, height] of [[1920, 1080], [360, 202], [202, 360], [10, 8], [1, 1], [0, 0]]) {
    const ball = createBeachBall(width, height);
    assertContained(ball);
    assert.ok(ball.radius <= 72);
  }
  assert.ok(createBeachBall(1920, 1080).radius > createBeachBall(360, 202).radius);
  assert.deepEqual(createBeachBall(NaN, -1), createBeachBall(0, 0));
  assert.deepEqual(createBeachBall(Infinity, 0), createBeachBall(0, 0));
});

test('beach ball reflects both axes and preserves travel after crossing a corner', () => {
  const initial = createBeachBall(400, 300);
  const ball = Object.freeze({...initial, x: 400 - initial.radius - 5, y: initial.radius + 5, vx: 100, vy: -100});
  const next = advanceBeachBall(ball, 0.2);
  assertClose(next.x, 400 - ball.radius - 15);
  assertClose(next.y, ball.radius + 15);
  assert.equal(next.vx, -100);
  assert.equal(next.vy, 100);
  assertContained(next);
  assert.equal(ball.vx, 100);
  assert.equal(ball.vy, -100);
});

test('an exact wall hit points velocity inward, including the next frame', () => {
  const initial = createBeachBall(400, 300);
  const ball = {...initial, x: 400 - initial.radius - 5, y: initial.radius + 5, vx: 100, vy: -100};
  const hit = advanceBeachBall(ball, 0.05);
  assert.equal(hit.x, 400 - ball.radius);
  assert.equal(hit.y, ball.radius);
  assert.equal(hit.vx, -100);
  assert.equal(hit.vy, 100);
  const next = advanceBeachBall(hit, 0.01);
  assertClose(next.x, hit.x - 1);
  assertClose(next.y, hit.y + 1);
});

test('large time steps reflect repeatedly instead of clamping or leaving the viewport', () => {
  const ball = {...createBeachBall(360, 202), vx: -137, vy: 89};
  const next = advanceBeachBall(ball, 123.45);
  const partitioned = advanceBeachBall(advanceBeachBall(ball, 73), 50.45);
  assertContained(next);
  for (const key of ['x', 'y', 'vx', 'vy', 'angle']) assertClose(next[key], partitioned[key]);
  assert.ok(next.angle >= 0 && next.angle < Math.PI * 2);
  assert.equal(Math.abs(next.vx), Math.abs(ball.vx));
  assert.equal(Math.abs(next.vy), Math.abs(ball.vy));
});

test('resizing retains relative position and direction, and survives zero-size layouts', () => {
  let ball = {...createBeachBall(1280, 720), vx: -150};
  const resized = resizeBeachBall(ball, 360, 202);
  assertClose((resized.x - resized.radius) / (resized.width - resized.radius * 2), 0.28);
  assertClose((resized.y - resized.radius) / (resized.height - resized.radius * 2), 0.37);
  assert.equal(resizeBeachBall(resized, 360, 202), resized);
  for (const [width, height] of [[360, 202], [8, 8], [0, 0], [1920, 1080], [300, 900]]) {
    ball = resizeBeachBall(ball, width, height);
    assertContained(ball);
    assert.ok(ball.vx < 0);
    assert.ok(ball.vy > 0);
    assertContained(advanceBeachBall(ball, 10));
  }
});

test('reduced motion and invalid elapsed time leave position and rotation unchanged', () => {
  const ball = Object.freeze(createBeachBall(800, 600));
  assert.equal(advanceBeachBall(ball, 3600, true), ball);
  for (const elapsed of [0, -1, NaN, Infinity]) assert.equal(advanceBeachBall(ball, elapsed), ball);
  assert.notEqual(advanceBeachBall(ball, 0.1).angle, ball.angle);
});