export const STATIC_RECOVERY_MS = 20000;
const WIDTH = 1600, HEIGHT = 900, CELL = 16, RADIUS = 64;
const COLUMNS = Math.ceil(WIDTH / CELL), ROWS = Math.ceil(HEIGHT / CELL);

// Shared by the room, in normalized picture coordinates, independent of viewer size.
export class FingerStatic {
    constructor() {
        this.rubbed = new Float64Array(COLUMNS * ROWS).fill(-Infinity);
        this.lastRub = -Infinity;
        this.lastCrackle = -Infinity;
    }

    charge(index, now) {
        return Math.max(0, Math.min(1, (now - this.rubbed[index]) / STATIC_RECOVERY_MS));
    }

    rub(from, to, now) {
        const dx = (to.x - from.x) * WIDTH, dy = (to.y - from.y) * HEIGHT;
        const distance = Math.hypot(dx, dy);
        if (distance < .5) return 0;
        let released = 0;
        const steps = Math.ceil(distance / (CELL / 2));
        // Sweep the path so quick motions cannot skip charged patches.
        for (let step = 0; step <= steps; step++) {
            const x = from.x * WIDTH + dx * step / steps;
            const y = from.y * HEIGHT + dy * step / steps;
            const col = Math.min(COLUMNS - 1, Math.floor(x / CELL));
            const row = Math.min(ROWS - 1, Math.floor(y / CELL));
            const charge = this.charge(row * COLUMNS + col, now);
            const charged = charge >= .2;
            if (charged) released = Math.max(released, charge);
            for (let cy = Math.max(0, row - 4); cy <= Math.min(ROWS - 1, row + 4); cy++) {
                for (let cx = Math.max(0, col - 4); cx <= Math.min(COLUMNS - 1, col + 4); cx++) {
                    if (Math.hypot((cx + .5) * CELL - x, (cy + .5) * CELL - y) > RADIUS) continue;
                    const index = cy * COLUMNS + cx;
                    // A discharge drains its neighborhood. Rubbing an already quiet patch refreshes
                    // that patch's cooldown without pushing a silent halo ahead into untouched glass.
                    if (charged || Number.isFinite(this.rubbed[index])) this.rubbed[index] = now;
                }
            }
        }
        this.lastRub = now;
        if (!released || now - this.lastCrackle < 65) return 0;
        this.lastCrackle = now;
        return released;
    }
}
