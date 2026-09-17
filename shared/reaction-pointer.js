export const POINTER_TICK_MS = 1000 / 60;
export const POINTER_TIMEOUT_MS = 1500;

export function startPointerTicker(callback) {
    let deadline = performance.now() + POINTER_TICK_MS;
    let timer;
    let stopped = false;
    function tick() {
        if (stopped) return;
        callback();
        const now = performance.now();
        // Correct timer rounding/drift, but discard missed ticks after a stall.
        if (now - deadline > POINTER_TICK_MS) deadline = now;
        deadline += POINTER_TICK_MS;
        if (!stopped) schedule(Math.max(1, deadline - now));
    }
    function schedule(delay) {
        timer = setTimeout(tick, delay);
        timer.unref?.();
    }
    schedule(POINTER_TICK_MS);
    return () => { stopped = true; clearTimeout(timer); };
}

// Choose the edge in physical pixels, then keep this pivot for the entire visit.
export function fingerPivot(x, y, width, height) {
    const distances = [x * width, (1 - x) * width, y * height, (1 - y) * height];
    const edge = distances.indexOf(Math.min(...distances));
    const dx = Math.min(.3, 64 / Math.max(1, width));
    const dy = Math.min(.3, 64 / Math.max(1, height));
    return [{x: -dx, y}, {x: 1 + dx, y}, {x, y: -dy}, {x, y: 1 + dy}][edge];
}

export function validFinger(finger) {
    if (!finger || typeof finger !== 'object') return false;
    const {x, y, pivot, pressed, taps} = finger;
    return [x, y].every(n => Number.isFinite(n) && n >= 0 && n <= 1)
        && pivot && [pivot.x, pivot.y].every(n => Number.isFinite(n) && n >= -.3 && n <= 1.3)
        && (pivot.x < 0 || pivot.x > 1 || pivot.y < 0 || pivot.y > 1)
        && typeof pressed === 'boolean' && Number.isSafeInteger(taps) && taps >= 0 && taps <= 1e9;
}
