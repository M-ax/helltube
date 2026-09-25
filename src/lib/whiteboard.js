// Build paths in the viewport's actual dimensions so arrows and stroke widths
// stay legible in theater/fullscreen and at different viewer aspect ratios.
export function whiteboardPath(shape, width, height) {
    const points = shape.points.map(([x, y]) => [x * width, y * height]);
    const [x, y] = points[0];
    const [ex, ey] = points.at(-1);
    if (points.length === 1 || (!['pen', 'spray'].includes(shape.tool) && x === ex && y === ey)) return `M${x} ${y}l0.01 0`;
    if (['pen', 'spray'].includes(shape.tool)) return points.map(([px, py], index) => `${index ? 'L' : 'M'}${px} ${py}`).join(' ');
    if (shape.tool === 'rectangle') return `M${x} ${y}H${ex}V${ey}H${x}Z`;
    if (shape.tool === 'ellipse') {
        const rx = Math.abs(ex - x) / 2, ry = Math.abs(ey - y) / 2;
        const cx = (x + ex) / 2, cy = (y + ey) / 2;
        if (!rx || !ry) return `M${x} ${y}L${ex} ${ey}`;
        return `M${cx - rx} ${cy}a${rx} ${ry} 0 1 0 ${2 * rx} 0a${rx} ${ry} 0 1 0 ${-2 * rx} 0`;
    }
    const line = `M${x} ${y}L${ex} ${ey}`;
    if (shape.tool !== 'arrow') return line;
    const angle = Math.atan2(ey - y, ex - x);
    const length = Math.min(Math.hypot(ex - x, ey - y) * .4, 12 + shape.width * 2);
    return `${line}M${ex - Math.cos(angle - .5) * length} ${ey - Math.sin(angle - .5) * length}L${ex} ${ey}L${ex - Math.cos(angle + .5) * length} ${ey - Math.sin(angle + .5) * length}`;
}
