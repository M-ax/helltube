const fullTurn = Math.PI * 2;

function dimension(value) {
    return Number.isFinite(value) && value > 0 ? value : 0;
}

function geometry(width, height) {
    width = dimension(width);
    height = dimension(height);
    const shortest = Math.min(width, height);
    return {
        width,
        height,
        radius: Math.min(72, Math.max(22, shortest * 0.12), shortest / 2),
        speed: Math.max(70, Math.min(210, shortest * 0.32)),
    };
}

export function createBeachBall(width, height) {
    const bounds = geometry(width, height);
    return {
        width: bounds.width,
        height: bounds.height,
        radius: bounds.radius,
        x: bounds.radius + (bounds.width - bounds.radius * 2) * 0.28,
        y: bounds.radius + (bounds.height - bounds.radius * 2) * 0.37,
        vx: bounds.speed,
        vy: bounds.speed * 0.73,
        angle: 0,
    };
}

export function resizeBeachBall(ball, width, height) {
    const bounds = geometry(width, height);
    if (ball.width === bounds.width && ball.height === bounds.height) return ball;
    const fraction = (position, size, fallback) => size > ball.radius * 2
        ? Math.max(0, Math.min(1, (position - ball.radius) / (size - ball.radius * 2)))
        : fallback;
    return {
        ...ball,
        width: bounds.width,
        height: bounds.height,
        radius: bounds.radius,
        x: bounds.radius + (bounds.width - bounds.radius * 2) * fraction(ball.x, ball.width, 0.28),
        y: bounds.radius + (bounds.height - bounds.radius * 2) * fraction(ball.y, ball.height, 0.37),
        vx: (Math.sign(ball.vx) || 1) * bounds.speed,
        vy: (Math.sign(ball.vy) || 1) * bounds.speed * 0.73,
    };
}

function reflect(position, velocity, elapsed, minimum, maximum) {
    const span = maximum - minimum;
    if (span <= 0) return [minimum, velocity];
    const period = span * 2;
    const offset = ((position - minimum + velocity * elapsed) % period + period) % period;
    const direction = offset === 0 ? Math.abs(velocity)
        : offset === span ? -Math.abs(velocity)
            : velocity * (offset < span ? 1 : -1);
    return [minimum + (offset <= span ? offset : period - offset), direction];
}

export function advanceBeachBall(ball, elapsed, reducedMotion = false) {
    if (reducedMotion || !Number.isFinite(elapsed) || elapsed <= 0) return ball;
    const [x, vx] = reflect(ball.x, ball.vx, elapsed, ball.radius, ball.width - ball.radius);
    const [y, vy] = reflect(ball.y, ball.vy, elapsed, ball.radius, ball.height - ball.radius);
    return {...ball, x, y, vx, vy, angle: (ball.angle + elapsed * 1.25) % fullTurn};
}

export function paintBeachBall(context, size) {
    const colors = ['#ff665c', '#fff0cf', '#43bddd', '#ffe166', '#f8faf0', '#58ce9e'];
    context.save();
    context.translate(size / 2, size / 2);
    context.scale(size / 2 - 2, size / 2 - 2);
    context.beginPath();
    context.arc(0, 0, 1, 0, fullTurn);
    context.clip();
    context.fillStyle = colors[1];
    context.fillRect(-1, -1, 2, 2);
    const poleX = -0.24;
    const poleY = -0.36;
    for (let index = 0; index < colors.length; index++) {
        const start = index * fullTurn / colors.length - 0.3;
        const end = (index + 1) * fullTurn / colors.length - 0.3;
        const startX = Math.cos(start);
        const startY = Math.sin(start);
        const endX = Math.cos(end);
        const endY = Math.sin(end);
        context.beginPath();
        context.moveTo(poleX, poleY);
        context.quadraticCurveTo(startX * 0.7 - 0.26, startY * 0.7, startX, startY);
        context.arc(0, 0, 1, start, end);
        context.quadraticCurveTo(endX * 0.7 - 0.26, endY * 0.7, poleX, poleY);
        context.fillStyle = colors[index];
        context.fill();
    }
    context.beginPath();
    context.ellipse(poleX, poleY, 0.11, 0.075, -0.35, 0, fullTurn);
    context.fillStyle = '#fff4d7';
    context.fill();
    const shade = context.createRadialGradient(-0.34, -0.4, 0.1, 0, 0, 1);
    shade.addColorStop(0, 'rgba(255, 255, 255, 0.48)');
    shade.addColorStop(0.36, 'rgba(255, 255, 255, 0.12)');
    shade.addColorStop(0.72, 'rgba(12, 27, 46, 0.08)');
    shade.addColorStop(1, 'rgba(12, 27, 46, 0.5)');
    context.fillStyle = shade;
    context.fillRect(-1, -1, 2, 2);
    const highlight = context.createRadialGradient(-0.34, -0.43, 0, -0.34, -0.43, 0.28);
    highlight.addColorStop(0, 'rgba(255, 255, 255, 0.7)');
    highlight.addColorStop(1, 'rgba(255, 255, 255, 0)');
    context.fillStyle = highlight;
    context.fillRect(-1, -1, 2, 2);
    context.restore();
}