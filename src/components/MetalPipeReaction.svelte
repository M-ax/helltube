<script>
    import {onMount} from 'svelte';
    import {PIPE_FALL_MS, PIPE_LIFETIME_MS, pipePose} from '../lib/metal-pipe.js';

    export let reaction;
    export let clockOffset = 0;
    export let onImpact;
    let pipe;
    let landed = false;

    onMount(() => {
        let frame;
        let impacted = false;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            const pose = pipePose(age, reducedMotion);
            // Position and impact sound share this frame, including after late delivery.
            pipe.style.top = `calc(${pose.drop * 100}% - 24px)`;
            pipe.style.transform = `translateX(-50%) rotate(${pose.rotation}deg)`;
            pipe.style.opacity = pose.opacity;
            landed = pose.landed;
            if (landed && !impacted) {
                impacted = true;
                // Returning to a hidden tab must not replay a long-past crash.
                if (!document.hidden && age - PIPE_FALL_MS < 200) onImpact();
            }
            if (age < PIPE_LIFETIME_MS) frame = requestAnimationFrame(draw);
        }
        draw();
        return () => cancelAnimationFrame(frame);
    });
</script>

<div class="metal-pipe-reaction" data-reaction="metalpipe" data-reaction-id={reaction.id}
     data-landed={landed} aria-hidden="true">
    <span class="falling-metal-pipe" bind:this={pipe} style={`left: ${reaction.x * 100}%`}>
        <span class="metal-pipe-body"></span>
    </span>
</div>
