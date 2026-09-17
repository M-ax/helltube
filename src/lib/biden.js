export const BIDEN_LIFETIME_MS = 12000;
export const BIDEN_SOUND_MS = 600;

// A shared event ID picks the same route and soundbite on every viewer's device.
export function bidenVariant(id) {
    let hash = 0;
    for (const character of id) hash = (Math.imul(hash, 31) + character.charCodeAt(0)) >>> 0;
    return hash % 2;
}

export function bidenSound(id) {
    return bidenVariant(id) ? 'bidenThing' : 'bidenWord';
}

export function bidenPose(age, startX = .5, variant = 0, reducedMotion = false) {
    age = Math.max(0, Math.min(BIDEN_LIFETIME_MS, age));
    const start = Math.max(.15, Math.min(.85, startX));
    const route = [
        [0, start], [1800, .78], [2400, .78], [4600, .3], [5300, .3],
        [7100, .58], [7700, .58], [9800, .18], [10400, .18], [BIDEN_LIFETIME_MS, -.2],
    ];
    const index = route.findIndex(([time]) => time > age);
    const [fromTime, fromX] = route[index < 0 ? route.length - 2 : index - 1];
    const [toTime, toX] = route[index < 0 ? route.length - 1 : index];
    // Quantized steps deliberately give the photographic cutout a cheap puppet walk.
    const progress = Math.min(1, Math.floor((age - fromTime) / 90) * 90 / (toTime - fromTime));
    const walking = toX !== fromX;
    const direction = (toX >= fromX ? 1 : -1) * (variant ? -1 : 1);
    const step = Math.floor(age / 130) % 4;
    const x = fromX + (toX - fromX) * progress;
    return {
        x: reducedMotion ? start : variant ? 1 - x : x,
        direction: reducedMotion ? 1 : direction,
        bob: reducedMotion || !walking ? 0 : [0, 8, 2, 11][step],
        rotation: reducedMotion || !walking ? 0 : [-4, 3, -2, 5][step],
        stretch: reducedMotion || !walking ? 1 : [1, .96, 1.02, .98][step],
        walking: !reducedMotion && walking,
        opacity: age === BIDEN_LIFETIME_MS ? 0 : Math.max(0, Math.min(1, age / 180,
            reducedMotion ? (BIDEN_LIFETIME_MS - age) / 500 : 1)),
    };
}
