let hand;

// A small, warm plastic hand on stepped chrome tubes, drawn at the marshmallow's pixel scale.
export function drawPointingFinger(ctx, finger, width, height, arrival = 1) {
    const px = finger.pivot.x * width;
    const py = finger.pivot.y * height;
    const dx = finger.x * width - px;
    const dy = finger.y * height - py;
    const length = Math.hypot(dx, dy) * arrival;
    const size = Math.max(17, Math.min(30, width / 30));
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(dy, dx));
    const wrist = length - size * 1.95;
    // Thick outer tube, two nested tubes, and the collars that reveal the telescoping construction.
    for (let i = 0; i < 3; i++) {
        const start = Math.max(0, wrist) * i / 3;
        const end = Math.max(0, wrist) * (i + 1) / 3 + 2;
        const r = size * (.15 - i * .027);
        ctx.fillStyle = '#353236'; ctx.fillRect(start, -r - 1, end - start, r * 2 + 2);
        ctx.fillStyle = '#77787a'; ctx.fillRect(start, -r, end - start, r * 2);
        ctx.fillStyle = '#d4d1bc'; ctx.fillRect(start, -r, end - start, Math.max(1, r * .65));
        ctx.fillStyle = '#f6ebcf'; ctx.fillRect(start, -r * .2, end - start, 1);
        ctx.fillStyle = '#45434a'; ctx.fillRect(start, r * .5, end - start, r * .5);
        if (i < 2) {
            ctx.fillStyle = '#48474b'; ctx.fillRect(end - 3, -r - 1, 3, r * 2 + 2);
            ctx.fillStyle = '#d6cfb8'; ctx.fillRect(end - 3, -r - 1, 1, r * 1.5);
        }
    }
    ctx.translate(length, 0);
    ctx.scale(size, size);
    // The fingertip stays at (0, 0), even when pressed into the glass.
    ctx.scale(1, finger.pressed ? .88 : 1);
    hand ||= new Path2D('M 0 0 L -.06 -.13 L -.16 -.18 L -1.03 -.18 L -1.08 -.49 L -1.23 -.6 L -1.4 -.57 L -1.47 -.67 L -1.67 -.64 L -1.78 -.49 L -1.94 -.43 L -2.02 -.22 L -1.99 .31 L -1.77 .52 L -1.35 .55 L -1.08 .39 L -.98 .17 L -.16 .17 L -.05 .1 Z');
    ctx.fillStyle = '#66503d'; ctx.fill(hand);
    ctx.save();
    ctx.clip(hand);
    ctx.fillStyle = finger.pressed ? '#dcc69b' : '#eee0bc'; ctx.fillRect(-2.04, -.64, 2.1, 1.09);
    ctx.fillStyle = '#bca579'; ctx.fillRect(-2.1, .26, 1.14, .27);
    ctx.fillStyle = '#fff2d2'; ctx.fillRect(-1.9, -.44, .77, .13); ctx.fillRect(-1.02, -.13, .84, .08);
    ctx.fillStyle = '#d6c49d'; ctx.fillRect(-1.85, -.07, .76, .13);
    ctx.restore();
    ctx.strokeStyle = '#6e5841'; ctx.lineWidth = .055; ctx.stroke(hand);
    ctx.strokeStyle = '#af956c'; ctx.lineWidth = .055;
    ctx.beginPath();
    ctx.moveTo(-1.7, -.44); ctx.lineTo(-1.72, -.12);
    ctx.moveTo(-1.46, -.47); ctx.lineTo(-1.49, -.15);
    ctx.moveTo(-1.23, -.38); ctx.lineTo(-1.26, -.09);
    // Thumb curls across the folded fingers.
    ctx.moveTo(-1.91, .15); ctx.lineTo(-1.59, -.04); ctx.lineTo(-1.25, .03); ctx.lineTo(-1.17, .16);
    ctx.moveTo(-.4, -.08); ctx.lineTo(-.17, -.08);
    ctx.stroke();
    ctx.restore();
}
