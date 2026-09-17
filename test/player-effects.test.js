import test from 'node:test';
import assert from 'node:assert/strict';
import {createBeachBall, advanceBeachBall, bumpBeachBall, displayBeachBall, ballArena, BALL_WIDTH, BALL_HEIGHT} from '../shared/beach-ball.js';

function contained(ball) {
    assert.ok(Object.values(ball).every(Number.isFinite));
    assert.ok(ball.x >= ball.radius && ball.x <= BALL_WIDTH - ball.radius);
    assert.ok(ball.y >= ball.radius && ball.y <= BALL_HEIGHT - ball.radius);
}

test('gravity accelerates the ball; floor bounces lose energy and eventually settle', () => {
    let ball = {...createBeachBall(), vx: 0, vy: 0};
    const falling = advanceBeachBall(ball, 0.1);
    assert.ok(falling.y > ball.y && falling.vy > 0);
    ball = {...ball, y: BALL_HEIGHT - ball.radius - 1, vy: 500};
    const bounced = advanceBeachBall(ball, 1 / 120);
    assert.ok(bounced.vy < 0 && Math.abs(bounced.vy) < ball.vy);
    for (let i = 0; i < 1200; i++) { ball = advanceBeachBall(ball, 0.05); contained(ball); }
    assert.equal(ball.y, BALL_HEIGHT - ball.radius);
    assert.equal(ball.vy, 0);
    assert.equal(ball.vx, 0);
});

test('fast ball remains bounded, walls reflect velocity, invalid time is ignored', () => {
    const ball = {...createBeachBall(), x: BALL_WIDTH - createBeachBall().radius - 1, vx: 1800, vy: -1800};
    assert.ok(advanceBeachBall(ball, 0.05).vx < 0);
    for (const elapsed of [0.01, 0.25, 100]) contained(advanceBeachBall(ball, elapsed));
    for (const elapsed of [0, -1, NaN, Infinity]) assert.equal(advanceBeachBall(ball, elapsed), ball);
    assert.equal(ball.x, BALL_WIDTH - ball.radius - 1, 'Physics does not mutate snapshots.');
});

test('swept cursor collisions catch fast crossings, launch upward, and cap impulse', () => {
    const ball = {...createBeachBall(), x: 800, y: 450, vx: 0, vy: 0};
    const hit = bumpBeachBall(ball, {x: 800, y: 600}, {x: 800, y: 300}, 0.05);
    assert.ok(hit.vy < -500 && Math.abs(hit.vy) <= 1800);
    contained(hit);
    assert.equal(bumpBeachBall(ball, {x: 100, y: 100}, {x: 200, y: 100}, 0.05), ball);
    const stationary = bumpBeachBall({...ball, vy: 400}, {x: 800, y: 500}, {x: 800, y: 500}, 0.05);
    assert.ok(stationary.vy < 0, 'The ball also bounces off stationary cursors.');
});

test('different viewport sizes map the same ball and cursor into the shared arena', () => {
    const ball = createBeachBall();
    for (const [width, height, inset] of [[1920, 1080, 71], [390, 260, 110], [320, 330, 110], [900, 1600, 71]]) {
        const visible = displayBeachBall(ball, width, height, inset);
        const arena = ballArena(width, height, inset);
        assert.ok(Math.abs((visible.x - arena.x) / arena.scale - ball.x) < 1e-8);
        assert.ok(Math.abs((visible.y - arena.y) / arena.scale - ball.y) < 1e-8);
        assert.ok(visible.x >= visible.radius && visible.x <= width - visible.radius);
        assert.ok(visible.y >= visible.radius && visible.y <= height - visible.radius);
        const resting = displayBeachBall({...ball, y: BALL_HEIGHT - ball.radius}, width, height, inset);
        assert.ok(resting.y + resting.radius <= height - inset + 1e-8, 'The ball remains reachable above the controls.');
    }
});
