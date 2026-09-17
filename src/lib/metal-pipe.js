export const PIPE_FALL_MS = 900;
export const PIPE_LIFETIME_MS = PIPE_FALL_MS + 1800;

export function pipePose(age, reducedMotion = false) {
    const progress = Math.max(0, Math.min(1, age / PIPE_FALL_MS));
    return {
        drop: progress * progress,
        rotation: reducedMotion ? 0 : 28 * (progress - 1),
        landed: progress === 1,
        opacity: Math.max(0, Math.min(1, (PIPE_LIFETIME_MS - age) / 350)),
    };
}
