export const FLASH_BOUNCE_TIMES = [800, 1220, 1480];
export const FLASH_DETONATE_MS = 1750;
export const FLASH_HOLD_MS = 250;
export const FLASH_FADE_MS = 3750;
export const FLASH_LIFETIME_MS = FLASH_DETONATE_MS + FLASH_HOLD_MS + FLASH_FADE_MS;

const clamp = value => Math.max(0, Math.min(1, value));

export function flashbangPose(age, landingX = .5, reducedMotion = false) {
    age = Math.max(0, age);
    const direction = landingX < .5 ? 1 : -1;
    const startX = direction === 1 ? -.15 : 1.15;
    const firstX = landingX - direction * .14;
    const flight = clamp(age / FLASH_BOUNCE_TIMES[0]);
    let x = startX + (firstX - startX) * flight;
    let height = (1 - flight) * (.65 + 1.45 * flight);
    let rotation = direction * (-120 + 570 * flight);
    const impacts = FLASH_BOUNCE_TIMES.filter(time => age >= time).length;
    if (impacts) {
        const bounce = clamp((age - FLASH_BOUNCE_TIMES[0]) / (FLASH_BOUNCE_TIMES[2] - FLASH_BOUNCE_TIMES[0]));
        x = firstX + (landingX - firstX) * bounce;
        rotation = direction * (450 + 360 * bounce);
        if (impacts < FLASH_BOUNCE_TIMES.length) {
            const start = FLASH_BOUNCE_TIMES[impacts - 1];
            const end = FLASH_BOUNCE_TIMES[impacts];
            const progress = clamp((age - start) / (end - start));
            height = 4 * progress * (1 - progress) * (impacts === 1 ? .18 : .065);
        } else height = 0;
    }
    const detonated = age >= FLASH_DETONATE_MS;
    const fade = clamp((age - FLASH_DETONATE_MS - FLASH_HOLD_MS) / FLASH_FADE_MS);
    return {
        x, height, rotation: reducedMotion ? 90 : rotation, impacts, detonated,
        whiteout: detonated ? 1 - fade : 0,
    };
}
