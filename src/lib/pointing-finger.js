let hand;

// A small, warm plastic hand on stepped chrome tubes, drawn at the marshmallow's pixel scale.
export function drawPointingFinger(ctx, finger, width, height, arrival = 1) {
    const px = finger.pivot.x * width;
    const py = finger.pivot.y * height;
    const dx = finger.x * width - px;
    const dy = finger.y * height - py;
    const length = Math.hypot(dx, dy) * arrival;
    const size = Math.max(17, Math.min(30, width / 30));
    const wrist = length - size * 1.95;
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(Math.atan2(dy, dx));
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
    // The index runs along the top of the hand. The other three fingers curl underneath,
    // with their knuckles stacked down the front of the fist rather than above the index.
    hand ||= new Path2D('M 0 0 L -.05 -.12 L -.16 -.18 L -1.28 -.18 L -1.55 -.24 L -1.88 -.18 L -2.04 -.05 L -2.06 .3 L -1.98 .57 L -1.74 .83 L -1.46 .98 L -1.02 .98 L -.86 .91 L -.83 .78 L -.9 .7 L -.76 .64 L -.72 .5 L -.8 .42 L -.68 .35 L -.68 .23 L -.8 .14 L -.16 .17 L -.05 .1 Z');
    ctx.fillStyle = '#66503d'; ctx.fill(hand);
    ctx.save();
    ctx.clip(hand);
    ctx.fillStyle = finger.pressed ? '#dcc69b' : '#eee0bc'; ctx.fillRect(-2.1, -.26, 2.15, 1.3);
    ctx.fillStyle = '#bca579'; ctx.fillRect(-2.1, .75, 1.3, .27);
    ctx.fillStyle = '#fff2d2'; ctx.fillRect(-1.84, -.14, .57, .09); ctx.fillRect(-1.22, -.13, 1.04, .08);
    ctx.fillStyle = '#d6c49d'; ctx.fillRect(-1.95, .24, .19, .37);
    ctx.restore();
    ctx.strokeStyle = '#6e5841'; ctx.lineWidth = .055; ctx.stroke(hand);
    ctx.strokeStyle = '#af956c'; ctx.lineWidth = .055;
    ctx.beginPath();
    // Horizontal creases separate the three curled fingers beneath the extended index.
    ctx.moveTo(-1.29, .38); ctx.lineTo(-1.05, .43); ctx.lineTo(-.8, .42);
    ctx.moveTo(-1.32, .64); ctx.lineTo(-1.13, .7); ctx.lineTo(-.9, .7);
    ctx.moveTo(-1.42, .84); ctx.lineTo(-1.12, .9);
    // The thumb folds diagonally across the palm, staying tucked below the index.
    ctx.moveTo(-1.83, .1); ctx.lineTo(-1.58, .15); ctx.lineTo(-1.24, .34);
    ctx.lineTo(-1.17, .47); ctx.lineTo(-1.27, .56); ctx.lineTo(-1.42, .53); ctx.lineTo(-1.68, .36);
    ctx.moveTo(-.4, -.08); ctx.lineTo(-.17, -.08);
    ctx.stroke();
    ctx.restore();
}
