import {SPRAY_TIPS, WHITEBOARD_INTERVAL} from '../../shared/whiteboard.js';

const cache = new WeakMap();

export function sprayGeometry(shape) {
    const cached = cache.get(shape.points);
    if (cached?.id === shape.id && cached.tip === shape.tip && cached.width === shape.width) return cached.geometry;
    const tip = SPRAY_TIPS.find(value => value.id === shape.tip) || SPRAY_TIPS[0];
    const radius = tip.radius * shape.width / 4;
    let seed = 2166136261;
    for (const char of shape.id) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619);
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    const dots = [], haze = [], drips = [];
    let anchor = null, dwell = 0, drop = null, previous = null;
    for (const [nx, ny] of shape.points) {
        const x = nx * 960, y = ny * 540;
        // Tiny hand tremors still deposit paint into the same wet patch.
        if (!anchor || Math.hypot(x - anchor[0], y - anchor[1]) > radius * .45) { anchor = [x, y]; dwell = 0; drop = null; }
        dwell += WHITEBOARD_INTERVAL;
        for (let i = 0; i < tip.density; i++) {
            const angle = random() * Math.PI * 2, r = Math.sqrt(random()) * radius;
            const dx = Math.cos(angle) * r, dy = Math.sin(angle) * r * tip.aspect;
            const fraction = random();
            const px = previous ? previous[0] + (x - previous[0]) * fraction : x;
            const py = previous ? previous[1] + (y - previous[1]) * fraction : y;
            const size = .35 + random() * (tip.id === 'fat' ? 1.2 : .7);
            dots.push('M' + (px + dx).toFixed(2) + ' ' + (py + dy).toFixed(2) + 'h' + size.toFixed(2));
        }
        haze.push(previous ? 'M' + previous[0].toFixed(2) + ' ' + previous[1].toFixed(2) + 'L' + x.toFixed(2) + ' ' + y.toFixed(2) : 'M' + x.toFixed(2) + ' ' + y.toFixed(2) + 'h.01');
        previous = [x, y];
        if (dwell > 480) {
            if (!drop) { drop = {x: anchor[0] + (random() - .5) * radius * .4, y: anchor[1], length: 0, width: 0}; drips.push(drop); }
            drop.length = Math.min(540 - drop.y, (dwell - 480) / 1000 * 48 * tip.flow);
            drop.width = Math.min(7, 1.5 + dwell / 1300) * shape.width / 4;
        }
    }
    const geometry = {dots: dots.join(''), haze: haze.join(''), radius, aspect: tip.aspect, drips};
    cache.set(shape.points, {id: shape.id, tip: shape.tip, width: shape.width, geometry});
    return geometry;
}
