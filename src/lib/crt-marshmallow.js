const clamp = value => Math.max(0, Math.min(1, value));
const ease = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
const timing = import.meta.env?.MODE === 'crt-preview'
    ? {first: 1, firstRange: 1, gap: 2, gapRange: 2}
    : {first: 12, firstRange: 10, gap: 22, gapRange: 24};

export function createMarshmallowVisits(random = Math.random) {
    const firstDelay = () => timing.first + random() * timing.firstRange;
    let wait = firstDelay();
    let visit = null;
    return {
        advance(seconds) {
            if (!Number.isFinite(seconds) || seconds <= 0) return visit;
            // Consume elapsed time so scheduling is independent of the display's frame rate.
            let remaining = Math.min(seconds, 60);
            while (remaining > 0) {
                const untilChange = visit ? visit.duration - visit.time : wait;
                const step = Math.min(remaining, untilChange);
                remaining -= step;
                if (visit) visit.time += step;
                else wait -= step;
                if (step < untilChange) break;
                if (visit) {
                    visit = null;
                    wait = timing.gap + random() * timing.gapRange;
                } else {
                    const burns = random() < 0.45;
                    visit = {side: random() < 0.5 ? 1 : -1, burns,
                        reach: 0.22 + random() * 0.08, time: 0, duration: burns ? 13 : 14};
                }
            }
            return visit;
        },
        current: () => visit,
        reset() { visit = null; wait = firstDelay(); },
    };
}

export function marshmallowPose(visit, width, height, controlsHeight) {
    if (!visit || visit.time >= visit.duration) return null;
    const {time: t, side, burns} = visit;
    const size = Math.max(15, Math.min(32, width / 30));
    const flameTop = height - Math.min(height, controlsHeight + 24);
    const restY = flameTop - size * 0.3;
    const liftHeight = Math.min(size * 1.35, Math.max(6, (height - controlsHeight - 110) * 0.5));
    const leaveAt = burns ? 10.6 : 11.6;
    const arrival = ease(t / 2.2) * (1 - ease((t - leaveAt) / 2.4));
    const target = width * visit.reach;
    const shaft = (target + size * 2) / Math.cos(0.13);
    const gripX = side > 0 ? -size * 2 : width + size * 2;
    const gripY = restY - shaft * Math.sin(0.13);
    const slide = -side * (target + size * 2) * (1 - arrival);
    let y = restY;
    let angle = side * 0.13;
    let fire = 0;
    let smoke = 0;
    let blow = 0;
    let breathTime = 0;
    let char = 0;
    let toast = ease((t - 2.2) / 7.8);
    if (burns) {
        const dip = ease((t - 2.5) / 1.4);
        const lift = ease((t - 5.3) / 0.65);
        const panic = ease((t - 5.7) / 0.3) * (1 - ease((t - 8.1) / 0.7));
        y += size * 0.85 * dip * (1 - lift) - liftHeight * lift;
        // A rigid stick pivots at the offscreen grip, putting the motion at its tip.
        angle = side * (Math.asin(Math.max(-1, Math.min(1, (y - gripY) / shaft)))
            + Math.sin(t * 28) * size * 0.6 / shaft * panic);
        toast = ease((t - 2.5) / 2.5);
        char = ease((t - 4.4) / 3.3);
        fire = ease((t - 4.0) / 0.7) * (1 - ease((t - 6.2) / 2.3));
        blow = panic;
        breathTime = Math.max(0, t - 5.9);
        smoke = ease((t - 7.4) / 1.2) * (1 - ease((t - 9.2) / 1.6));
    }
    const x = gripX + side * shaft * Math.cos(angle) + slide;
    y = gripY + side * shaft * Math.sin(angle);
    // The unseen person's breath follows a fixed downward path, independent of the stick.
    const breathOriginX = side > 0 ? -size * 1.4 : width + size * 1.4;
    const breathOriginY = Math.max(size * 0.8, flameTop - size * 3.6);
    const breathTargetX = side > 0 ? target : width - target;
    const breathTargetY = restY - liftHeight - size * 0.2;
    return {x, y, size, angle, side, toast, char, fire, smoke, blow, breathTime, shaft,
        breathOriginX, breathOriginY, breathTargetX, breathTargetY};
}

export const marshmallowShader = `
    uniform vec4 u_marshmallow;
    uniform vec4 u_toasting;
    uniform vec4 u_stick;
    uniform vec4 u_breathPath;

    float segmentDistance(vec2 p, vec2 a, vec2 b) {
        vec2 ab = b - a;
        return length(p - a - ab * clamp(dot(p - a, ab) / dot(ab, ab), 0.0, 1.0));
    }

    vec4 crtMarshmallow(vec2 uv) {
        float size = u_marshmallow.z;
        float pixel = max(1.5, size / 16.0);
        vec2 screen = floor(uv * u_flameSize / pixel) * pixel;
        vec2 delta = screen - u_marshmallow.xy;
        float c = cos(u_marshmallow.w);
        float s = sin(u_marshmallow.w);
        vec2 p = mat2(c, -s, s, c) * delta;
        p.x *= u_stick.x;
        vec2 body = abs(p / size) - vec2(0.37, 0.28);
        float shape = length(max(body, 0.0)) + min(max(body.x, body.y), 0.0) - 0.13;
        vec2 bounds = size * vec2(abs(c) * 0.50 + abs(s) * 0.41, abs(s) * 0.50 + abs(c) * 0.41);
        vec4 result = vec4(0.0);

        // Rising pixel smoke after the frantic shaking finally puts the fire out.
        for (int i = 0; i < 3; i++) {
            float age = fract(u_flameTime * 0.65 + float(i) / 3.0);
            vec2 center = vec2(sin(age * 7.0 + float(i)) * size * 0.28,
                -size * (0.55 + age * 1.9));
            float puff = 1.0 - step(size * (0.12 + age * 0.24), length(delta - center));
            float opacity = puff * u_toasting.w * (1.0 - age) * 0.48;
            if (opacity > 0.0) result = vec4(vec3(0.64, 0.61, 0.55), opacity);
        }

        // Fire grows from the rotated body's rounded outline, then spreads and rises.
        // Smooth coverage below and around the body avoids a flat, clipped flame base.
        float rise = max(0.0, -delta.y - bounds.y * 0.25) / (size * 1.85);
        float noise = flameNoise(vec2(delta.x / (size * 0.25), delta.y / (size * 0.45) + u_flameTime * 4.0));
        float heat = clamp(noise * 0.75 + 0.4 - rise * 0.65, 0.0, 1.0);
        float fireWidth = max(size * 0.06, bounds.x + size * (0.16 + 0.28 * smoothstep(0.0, 0.3, rise) - rise * 0.65));
        float sway = sin(rise * 7.0 - u_flameTime * 7.0) * size * 0.14 * rise;
        float plume = (1.0 - smoothstep(fireWidth * 0.6, fireWidth + size * 0.15, abs(delta.x + sway)))
            * smoothstep(-size * 0.12, size * 0.26, -delta.y)
            * smoothstep(0.05, 0.3, heat) * (1.0 - smoothstep(0.7, 1.05, rise));
        float shell = 1.0 - smoothstep(0.0, 0.23 + noise * 0.15, shape);
        float flame = max(shell * 0.42, plume * 0.68) * (0.5 + noise * 0.5) * u_toasting.z;
        vec3 fireColor = mix(vec3(1.0, 0.32, 0.025), vec3(1.0, 0.73, 0.2), heat);
        if (flame > 0.001) result = vec4(fireColor, flame);

        float twig = segmentDistance(p, vec2(-u_stick.y, 0.0), vec2(size * 0.67, 0.0));
        float branch = segmentDistance(p, vec2(-size * 2.0, 0.0), vec2(-size * 2.4, -size * 0.23));
        if (min(twig, branch) < max(1.5, size * 0.07)) {
            result = vec4(p.y < 0.0 ? vec3(0.66, 0.40, 0.17) : vec3(0.34, 0.19, 0.075), 0.98);
        }

        if (shape < 0.0) {
            float speckle = flameHash(floor(p / pixel));
            float crust = clamp(u_toasting.x * (0.7 + p.y / size * 0.5 + speckle * 0.3), 0.0, 1.0);
            vec3 color = mix(vec3(1.0, 0.95, 0.82), vec3(0.68, 0.32, 0.075), crust);
            color *= 1.0 - max(0.0, p.y / size) * 0.32;
            color = mix(color, vec3(0.19, 0.11, 0.055), u_toasting.y * (0.55 + speckle * 0.4));
            if (shape > -0.07) color *= 0.7;
            if (p.y < -size * 0.19 && abs(p.x) < size * 0.26) color += vec3(0.12, 0.10, 0.065) * (1.0 - u_toasting.y);
            color = mix(color, fireColor, u_toasting.z * noise * 0.12);
            result = vec4(color, 1.0);
        }

        // Airy cartoon poofs expand and break apart along the fixed breath path.
        for (int i = 0; i < 3; i++) {
            float age = (u_stick.w - float(i) * 0.62) / 0.72;
            if (age >= 0.0 && age <= 1.0) {
                vec2 center = mix(u_breathPath.xy, u_breathPath.zw, age);
                float puffSize = size * (0.75 + age * 0.95);
                vec2 direction = normalize(u_breathPath.zw - u_breathPath.xy);
                vec2 poof = mat2(direction.x, -direction.y, direction.y, direction.x) * (screen - center) / puffSize;
                float angle = atan(poof.y, poof.x);
                float radius = length(poof * vec2(1.0, 1.1));
                float rim = 0.4 + sin(angle * 5.0 + 0.3) * 0.075 + sin(angle * 3.0 + 1.0) * 0.035;
                float curls = (1.0 - smoothstep(0.025, 0.07, abs(radius - rim)))
                    * smoothstep(-0.35, 0.25, sin(angle * 3.0 + age * 1.2));
                float haze = (1.0 - smoothstep(0.12, rim, radius)) * 0.12;
                float flecks = max(1.0 - smoothstep(0.035, 0.075, length(poof - vec2(-0.6, -0.13))),
                    1.0 - smoothstep(0.025, 0.06, length(poof - vec2(-0.72, 0.17))));
                float coverage = max(max(curls, haze), flecks * 0.65);
                // Fade throughout the journey, disappearing before reaching the marshmallow.
                float fade = pow(1.0 - smoothstep(0.1, 0.9, age), 1.5);
                float opacity = coverage * u_stick.z * 0.62 * smoothstep(0.0, 0.1, age) * fade;
                if (opacity > 0.001) {
                    float alpha = opacity + result.a * (1.0 - opacity);
                    vec3 color = (vec3(0.94, 0.93, 0.88) * opacity + result.rgb * result.a * (1.0 - opacity)) / alpha;
                    result = vec4(color, alpha);
                }
            }
        }
        result.rgb *= mix(0.82, 1.0, step(1.0, mod(screen.y, 3.0)));
        return result;
    }
`;
