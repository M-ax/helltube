<script>
    import {onMount} from 'svelte';
    import {drawPointingFinger} from '../lib/pointing-finger.js';
    import {fingerStrikePose, FINGER_TAP_DURATION_MS} from '../lib/finger-strike.js';
    import {FINGER_TAP_IMPACT_MS, POINTER_TIMEOUT_MS} from '../../shared/reaction-pointer.js';

    export let fingers = [];
    export let local = null;
    export let clientId = null;
    export let clockOffset = 0;
    export let onSlide;
    export let onImpact;
    let canvas;
    let count = 0;

    onMount(() => {
        const ctx = canvas.getContext('2d');
        const poses = new Map();
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        let frame;
        let width = 1;
        let height = 1;
        const observer = new ResizeObserver(([entry]) => {
            width = entry.contentRect.width;
            height = entry.contentRect.height;
            const pixel = Math.max(1.5, Math.min(2, width / 480));
            canvas.width = Math.ceil(width / pixel);
            canvas.height = Math.ceil(height / pixel);
        });
        observer.observe(canvas);
        function draw(now) {
            ctx.setTransform(canvas.width / width, 0, 0, canvas.height / height, 0, 0);
            ctx.clearRect(0, 0, width, height);
            const visible = document.hidden ? [] : fingers.filter(finger => finger.clientId !== clientId
                && Date.now() + clockOffset - finger.time < POINTER_TIMEOUT_MS);
            if (local && !document.hidden) visible.push({...local, clientId: 'local'});
            const alive = new Set();
            canvas.dataset.tapPhase = 'idle';
            canvas.dataset.tapLift = '0';
            for (const finger of visible) {
                const id = finger.clientId;
                alive.add(id);
                let pose = poses.get(id);
                if (!pose) {
                    pose = {x: finger.x, y: finger.y, targetX: finger.x, targetY: finger.y, lastMove: now, lastFrame: now, born: now, speed: 0,
                        taps: 0, tapStarted: -Infinity, impacted: true};
                    poses.set(id, pose);
                }
                if (finger.taps > pose.taps) {
                    pose.taps = finger.taps;
                    const age = finger.tapTime == null ? Infinity : id === 'local'
                        ? Math.max(0, now - finger.tapTime) : Math.max(0, Date.now() + clockOffset - finger.tapTime);
                    pose.tapStarted = now - age;
                    pose.impacted = age >= FINGER_TAP_DURATION_MS;
                }
                if (finger.pressed && !pose.pressed) pose.speed = 0;
                pose.pressed = finger.pressed;
                const distance = Math.hypot((finger.x - pose.targetX) * width, (finger.y - pose.targetY) * height);
                if (distance > .1) {
                    pose.speed = Math.min(1, distance / Math.max(8, now - pose.lastMove) * 1.5);
                    pose.lastMove = now;
                    pose.targetX = finger.x; pose.targetY = finger.y;
                }
                const blend = id === 'local' ? 1 : 1 - Math.exp(-(now - pose.lastFrame) / 22);
                pose.x += (finger.x - pose.x) * blend;
                pose.y += (finger.y - pose.y) * blend;
                pose.lastFrame = now;
                const tapAge = now - pose.tapStarted;
                const impactNow = !pose.impacted && tapAge >= FINGER_TAP_IMPACT_MS;
                if (impactNow) pose.impacted = true;
                const playImpact = impactNow && tapAge < FINGER_TAP_IMPACT_MS + 100;
                // Even after a delayed frame, the sound and the exact screen-contact pose share this draw.
                const strike = fingerStrikePose(playImpact ? FINGER_TAP_IMPACT_MS : tapAge, reducedMotion);
                const arrival = reducedMotion || tapAge < FINGER_TAP_DURATION_MS ? 1 : Math.min(1, (now - pose.born) / 120);
                if (strike.phase !== 'idle') {
                    canvas.dataset.tapPhase = strike.phase;
                    canvas.dataset.tapLift = String(strike.lift);
                }
                drawPointingFinger(ctx, {...finger, x: pose.x, y: pose.y}, width, height, 1 - (1 - arrival) ** 3, strike);
                if (playImpact) onImpact();
                onSlide(id, finger.pressed && tapAge >= FINGER_TAP_IMPACT_MS && now - pose.lastMove < 75 ? pose.speed : 0);
            }
            for (const id of poses.keys()) if (!alive.has(id)) { poses.delete(id); onSlide(id, 0); }
            count = visible.length;
            // Scanlines affect only the prop's opaque pixels, as in the marshmallow shader.
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.globalCompositeOperation = 'source-atop';
            ctx.fillStyle = '#21180e24';
            for (let y = 1; y < canvas.height; y += 3) ctx.fillRect(0, y, canvas.width, 1);
            ctx.globalCompositeOperation = 'source-over';
            frame = requestAnimationFrame(draw);
        }
        frame = requestAnimationFrame(draw);
        return () => { cancelAnimationFrame(frame); observer.disconnect(); for (const id of poses.keys()) onSlide(id, 0); };
    });
</script>

<canvas bind:this={canvas} class="pointing-fingers" data-reaction="finger" data-finger-count={count}
        data-local-x={local?.x} data-local-y={local?.y} data-pressed={local?.pressed || false} aria-hidden="true"></canvas>

<style>
    .pointing-fingers { position: absolute; inset: 0; width: 100%; height: 100%; z-index: 4;
        pointer-events: none; image-rendering: pixelated; }
</style>
