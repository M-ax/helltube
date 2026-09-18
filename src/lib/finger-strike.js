import {FINGER_TAP_IMPACT_MS} from '../../shared/reaction-pointer.js';

export const FINGER_TAP_DURATION_MS = 180;

export function fingerStrikePose(age, reducedMotion = false) {
    if (!Number.isFinite(age) || age < 0 || age >= FINGER_TAP_DURATION_MS) return {lift: 0, phase: 'idle', contact: 0};
    let lift = 0;
    let phase;
    if (age < 20) {
        lift = 48 * (1 - (1 - age / 20) ** 2);
        phase = 'windup';
    } else if (age < FINGER_TAP_IMPACT_MS) {
        lift = 48 * (1 - ((age - 20) / (FINGER_TAP_IMPACT_MS - 20)) ** 2);
        phase = 'strike';
    } else if (age < 84) phase = 'impact';
    else {
        const t = (age - 84) / (FINGER_TAP_DURATION_MS - 84);
        lift = 9 * Math.sin(t * Math.PI) * (1 - t);
        phase = 'rebound';
    }
    return {lift: lift * (reducedMotion ? .15 : 1), phase,
        contact: age >= FINGER_TAP_IMPACT_MS ? Math.max(0, 1 - (age - FINGER_TAP_IMPACT_MS) / 42) : 0};
}

// Rotate the whole prop out of the screen around its offscreen grip, then perspective-project it.
// All shaft sections, the hand and the cast shadow use this same geometry.
export function fingerProjection(finger, width, height, arrival = 1, lift = 0) {
    const px = finger.pivot.x * width, py = finger.pivot.y * height;
    const dx = finger.x * width - px, dy = finger.y * height - py;
    const length = Math.hypot(dx, dy) * arrival;
    const angle = Math.atan2(dy, dx);
    const tilt = Math.atan2(lift, Math.max(1, length));
    const focal = Math.max(600, width * 1.1);
    // A slightly low viewpoint makes depth read as a visible upward lift and downward strike.
    const eyeX = width / 2, eyeY = height + focal * .2;
    return {length, project(x, y, shadow = false) {
        const along = x * Math.cos(tilt);
        const z = x * Math.sin(tilt);
        const worldX = px + Math.cos(angle) * along - Math.sin(angle) * y;
        const worldY = py + Math.sin(angle) * along + Math.cos(angle) * y;
        if (shadow) return {x: worldX + z * .35 + 2, y: worldY + z * .6 + 3};
        const perspective = focal / (focal - z);
        return {x: eyeX + (worldX - eyeX) * perspective,
            y: eyeY + (worldY - eyeY) * perspective};
    }};
}
