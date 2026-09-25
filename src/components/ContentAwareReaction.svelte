<script>
    import {onMount} from 'svelte';
    import {createContentAwareRenderer, CONTENT_AWARE_LIFETIME_MS} from '../lib/content-aware.js';
    export let reaction;
    export let clockOffset = 0;
    let canvas;
    onMount(() => {
        const renderer = createContentAwareRenderer(canvas, canvas.parentElement);
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        let frame, previous = -Infinity;
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            if (document.hidden || age >= CONTENT_AWARE_LIFETIME_MS) { renderer.clear(); return; }
            if (age - previous >= 100) { renderer.render(age, reduced.matches); previous = age; }
            frame = requestAnimationFrame(draw);
        }
        draw();
        return () => { cancelAnimationFrame(frame); renderer.destroy(); };
    });
</script>
<canvas bind:this={canvas} class="content-aware-reaction" data-reaction="contentaware" data-reaction-id={reaction.id} aria-hidden="true"></canvas>
<style>
    .content-aware-reaction { position: absolute; inset: 0; width: 100%; height: 100%; visibility: hidden; pointer-events: none; z-index: 1; }
</style>
