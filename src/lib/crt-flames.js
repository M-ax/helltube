// Shared by the player's WebGL pass and the standalone visual preview.
export const crtFlameShader = `
    uniform vec2 u_flameSize;
    uniform float u_flameTime;

    float flameHash(vec2 p) {
        vec3 q = fract(vec3(p.xyx) * 0.1031);
        q += dot(q, q.yzx + 33.33);
        return fract((q.x + q.y) * q.z);
    }

    float flameNoise(vec2 p) {
        vec2 cell = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(mix(flameHash(cell), flameHash(cell + vec2(1.0, 0.0)), f.x),
            mix(flameHash(cell + vec2(0.0, 1.0)), flameHash(cell + 1.0), f.x), f.y);
    }

    vec4 crtFlame(vec2 uv) {
        float pixel = clamp(u_flameSize.x / 300.0, 2.0, 4.0);
        vec2 p = floor(vec2(uv.x, 1.0 - uv.y) * u_flameSize / pixel) * pixel;
        float y = p.y / u_flameSize.y;
        float t = u_flameTime;
        // Quantized horizontal displacement makes the fire break up like a CRT signal.
        float tear = step(0.84, flameHash(vec2(floor(p.y / 7.0), floor(t * 9.0))));
        p.x += tear * (flameHash(vec2(floor(t * 13.0), floor(p.y / 7.0))) - 0.5) * 24.0;
        float sway = sin(y * 6.0 - t * 2.6 + p.x * 0.025) * y * 9.0;
        vec2 flow = vec2((p.x + sway) / 18.0, y * 1.6 - t * 1.8);
        float turbulence = flameNoise(flow) * 0.62
            + flameNoise(flow * 2.1 + vec2(7.0, -t * 0.7)) * 0.26
            + flameNoise(flow * 4.3) * 0.12;
        float heat = clamp((turbulence + 0.48 - y * 1.18) * 1.7, 0.0, 1.0);
        float alpha = smoothstep(0.08, 0.27, heat) * (1.0 - smoothstep(0.88, 1.0, y));
        // Strong orange midtones; the lower controls remain readable through the embers.
        vec3 color = mix(vec3(0.88, 0.22, 0.012), vec3(1.0, 0.44, 0.025), smoothstep(0.0, 0.48, heat));
        color = mix(color, vec3(1.0, 0.58, 0.10), smoothstep(0.48, 1.0, heat));
        float scanline = mix(0.74, 1.0, step(1.0, mod(uv.y * u_flameSize.y, 3.0)));
        alpha *= mix(0.16, 0.86, smoothstep(0.12, 0.54, y)) * scanline;
        return vec4(color, alpha);
    }
`;
