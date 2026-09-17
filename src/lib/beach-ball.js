const fullTurn = Math.PI * 2;


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
