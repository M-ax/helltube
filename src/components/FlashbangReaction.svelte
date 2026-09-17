<script>
    import {onMount} from 'svelte';
    import FlashbangGrenade from './FlashbangGrenade.svelte';
    import {FLASH_BOUNCE_TIMES, FLASH_DETONATE_MS, FLASH_LIFETIME_MS, flashbangPose} from '../lib/flashbang.js';

    export let reaction;
    export let clockOffset = 0;
    export let onSound;
    let grenade;
    let whiteout;
    let stage = 'flying';

    onMount(() => {
        let frame;
        let impacts = 0;
        let detonated = false;
        let stopRinging;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            const pose = flashbangPose(age, reaction.x, reducedMotion);
            const impactNow = pose.impacts > impacts && !pose.detonated
                && age - FLASH_BOUNCE_TIMES[pose.impacts - 1] < 160;
            const radians = pose.rotation * Math.PI / 180;
            // Keep the rotated grenade's lowest edge on the floor at each impact.
            const halfHeight = (Math.abs(Math.cos(radians)) * 72 + Math.abs(Math.sin(radians)) * 32) / 2;
            grenade.style.left = `${pose.x * 100}%`;
            grenade.style.bottom = `calc(${(impactNow ? 0 : pose.height) * 100}% + ${halfHeight}px)`;
            grenade.style.transform = `translate(-50%, 50%) rotate(${pose.rotation}deg)`;
            grenade.style.visibility = pose.detonated ? 'hidden' : 'visible';
            whiteout.style.opacity = pose.whiteout;
            stage = pose.detonated ? 'flashed' : pose.impacts ? 'bouncing' : 'flying';

            // Sound follows the rendered frame. Skip old impacts after late delivery or a hidden tab.
            if (pose.impacts > impacts) {
                impacts = pose.impacts;
                if (!document.hidden && impactNow) {
                    onSound('flashbangBounce', [1, .7, .45][impacts - 1]);
                }
            }
            if (pose.detonated && !detonated) {
                detonated = true;
                if (!document.hidden && age - FLASH_DETONATE_MS < 160) stopRinging = onSound('flashbangRing');
            }
            if (age < FLASH_LIFETIME_MS) frame = requestAnimationFrame(draw);
        }
        draw();
        return () => {
            cancelAnimationFrame(frame);
            stopRinging?.();
        };
    });
</script>

<div class="flashbang-reaction" data-reaction="flashbang" data-reaction-id={reaction.id} data-stage={stage} aria-hidden="true">
    <div class="flying-flashbang" bind:this={grenade}><FlashbangGrenade/></div>
    <div class="flashbang-whiteout" bind:this={whiteout}></div>
</div>

<style>
    .flashbang-reaction {
        position: absolute;
        inset: 0;
        overflow: hidden;
        pointer-events: none;
        z-index: 6;
    }
    .flying-flashbang {
        position: absolute;
        width: 32px;
        height: 72px;
        visibility: hidden;
        filter: drop-shadow(0 2px 2px #0008);
        will-change: transform;
    }
    .flashbang-whiteout {
        position: absolute;
        inset: 0;
        background: #fff;
        opacity: 0;
        will-change: opacity;
    }
</style>
