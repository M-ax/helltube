<script>
    import {onMount} from 'svelte';
    import {BIDEN_LIFETIME_MS, BIDEN_SOUND_MS, bidenPose, bidenSound, bidenVariant} from '../lib/biden.js';

    export let reaction;
    export let clockOffset = 0;
    export let onSound;
    let walker;
    let cutout;

    onMount(() => {
        let frame;
        let soundHandled = false;
        let stopSound;
        const motionPreference = window.matchMedia('(prefers-reduced-motion: reduce)');
        const variant = bidenVariant(reaction.id);
        function silence() {
            if (document.hidden) {
                stopSound?.();
                soundHandled = true;
            }
        }
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            const pose = bidenPose(age, reaction.x, variant, motionPreference.matches);
            walker.style.left = `${pose.x * 100}%`;
            walker.style.opacity = pose.opacity;
            walker.dataset.walking = String(pose.walking);
            cutout.style.transform = `translateY(${-pose.bob}px) scaleX(${pose.direction}) rotate(${pose.rotation}deg) scaleY(${pose.stretch})`;
            if (!soundHandled && age >= BIDEN_SOUND_MS) {
                // Never replay a missed line on late delivery or after tab suspension.
                if (document.hidden || age - BIDEN_SOUND_MS > 300) soundHandled = true;
                else {
                    stopSound = onSound(bidenSound(reaction.id));
                    soundHandled = !!stopSound;
                }
            }
            if (age < BIDEN_LIFETIME_MS) frame = requestAnimationFrame(draw);
            else stopSound?.();
        }
        document.addEventListener('visibilitychange', silence);
        draw();
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('visibilitychange', silence);
            stopSound?.();
        };
    });
</script>

<div class="biden-reaction" data-reaction="biden" data-reaction-id={reaction.id} aria-hidden="true">
    <div class="biden-walker" bind:this={walker}>
        <img class="biden-cutout" bind:this={cutout} src="/images/joe-biden-walking.png" alt="" draggable="false"/>
        <span class="biden-caption">PARODY</span>
    </div>
</div>

<style>
    .biden-reaction {
        position: absolute;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
        z-index: 3;
    }
    .biden-walker {
        position: absolute;
        bottom: min(calc(var(--controls-height, 71px) + 8px), 24%);
        height: clamp(70px, 36%, 230px);
        max-height: 65%;
        aspect-ratio: 1 / 2;
        transform: translateX(-50%);
        opacity: 0;
    }
    .biden-cutout {
        display: block;
        width: 100%;
        height: 100%;
        object-fit: contain;
        transform-origin: 50% 100%;
        filter: drop-shadow(2px 2px 0 #0009);
        will-change: transform;
    }
    .biden-caption {
        position: absolute;
        left: 50%;
        bottom: -5px;
        transform: translateX(-50%) rotate(-3deg);
        padding: 2px 4px;
        border-radius: 2px;
        background: #101010b3;
        color: #eee;
        font: 8px var(--mono);
        letter-spacing: 1px;
    }
</style>
