// Every room uses the same arena, independent of a viewer's screen size.
export const BALL_WIDTH = 1600;
export const BALL_HEIGHT = 900;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

export function createBeachBall() {
    return {x: 448, y: 270, vx: 260, vy: -180, radius: 108, angle: 0, spin: 1.5};
}

export function advanceBeachBall(ball, elapsed) {
    if (!ball || !Number.isFinite(elapsed) || elapsed <= 0) return ball;
    const next = {...ball};
    // Small steps keep gravity, fast cursor hits and floor contacts stable.
    let remaining = Math.min(elapsed, 0.25);
    while (remaining > 1e-8) {
        const dt = Math.min(remaining, 1 / 120);
        remaining -= dt;
        next.vy += 760 * dt;
        next.vx *= Math.exp(-0.16 * dt);
        next.x += next.vx * dt;
        next.y += next.vy * dt;
        if (next.x < next.radius || next.x > BALL_WIDTH - next.radius) {
            next.x = clamp(next.x, next.radius, BALL_WIDTH - next.radius);
            next.vx *= -0.82;
            next.spin = next.vy / next.radius * 0.3;
        }
        if (next.y < next.radius) {
            next.y = next.radius;
            next.vy = Math.abs(next.vy) * 0.8;
        }
        if (next.y > BALL_HEIGHT - next.radius) {
            next.y = BALL_HEIGHT - next.radius;
            next.vy = Math.abs(next.vy) < 70 ? 0 : -Math.abs(next.vy) * 0.76;
            next.vx *= Math.exp(-2.5 * dt);
            next.spin = next.vx / next.radius;
            if (Math.abs(next.vx) < 2) next.vx = 0;
        }
        next.angle = (next.angle + next.spin * dt) % (Math.PI * 2);
    }
    return next;
}

export function bumpBeachBall(ball, from, to, elapsed) {
    if (!ball) return ball;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared ? clamp(((ball.x - from.x) * dx + (ball.y - from.y) * dy) / lengthSquared, 0, 1) : 0;
    const contact = {x: from.x + dx * fraction, y: from.y + dy * fraction};
    let nx = ball.x - contact.x;
    let ny = ball.y - contact.y;
    const distance = Math.hypot(nx, ny);
    const radius = ball.radius + 12;
    if (distance >= radius) return ball;
    if (distance > 0.01) { nx /= distance; ny /= distance; }
    else {
        const length = Math.hypot(dx, dy);
        nx = length ? dx / length : 0;
        ny = length ? dy / length : -1;
    }
    const dt = clamp(elapsed || 0.05, 0.016, 0.15);
    const speed = Math.hypot(dx, dy) / dt;
    const scale = speed > 1800 ? 1800 / speed : 1;
    const cursorVX = dx / dt * scale;
    const cursorVY = dy / dt * scale;
    const impact = Math.max(0, (cursorVX - ball.vx) * nx + (cursorVY - ball.vy) * ny);
    return {...ball,
        x: clamp(contact.x + nx * radius, ball.radius, BALL_WIDTH - ball.radius),
        y: clamp(contact.y + ny * radius, ball.radius, BALL_HEIGHT - ball.radius),
        vx: clamp(ball.vx + nx * impact * 1.6, -1800, 1800),
        vy: clamp(ball.vy + ny * impact * 1.6, -1800, 1800),
        spin: clamp(ball.spin + (cursorVX * ny - cursorVY * nx) / ball.radius * 0.3, -12, 12),
    };
}

export function ballArena(width, height, bottomInset = 0) {
    height = Math.max(1, height - bottomInset);
    const scale = Math.min(width / BALL_WIDTH, height / BALL_HEIGHT);
    return {x: (width - BALL_WIDTH * scale) / 2, y: (height - BALL_HEIGHT * scale) / 2, scale};
}

export function displayBeachBall(ball, width, height, bottomInset = 0) {
    const arena = ballArena(width, height, bottomInset);
    return {...ball, x: arena.x + ball.x * arena.scale, y: arena.y + ball.y * arena.scale, radius: ball.radius * arena.scale};
}
