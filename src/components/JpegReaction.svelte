<script>
    import {onMount} from 'svelte';
    import {createJpegCompressor, jpegSettings, JPEG_SOUND_MS, JPEG_LIFETIME_MS} from '../lib/jpeg.js';

    export let reaction;
    export let clockOffset = 0;
    export let onSound;
    let canvas;

    onMount(() => {
        const viewport = canvas.parentElement;
        const compressor = createJpegCompressor(canvas, viewport);
        let frame;
        let lastFrame = -Infinity;
        let soundHandled = false;
        let stopSound;
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            if (age >= JPEG_LIFETIME_MS) { compressor.clear(); stopSound?.(); return; }
            if (!soundHandled && age >= JPEG_SOUND_MS) {
                if (age - JPEG_SOUND_MS > 300) soundHandled = true;
                else {
                    stopSound = onSound('jpeg');
                    soundHandled = !!stopSound;
                }
            }
            if (age - lastFrame >= 1000 / 15) {
                const bounds = viewport.getBoundingClientRect();
                const settings = jpegSettings(age, bounds.width, bounds.height);
                if (settings) void compressor.render(settings);
                lastFrame = age;
            }
            frame = requestAnimationFrame(draw);
        }
        function visibilityChanged() {
            cancelAnimationFrame(frame);
            if (document.hidden) {
                stopSound?.();
                soundHandled = true;
                compressor.clear();
            } else draw();
        }
        document.addEventListener('visibilitychange', visibilityChanged);
        visibilityChanged();
        return () => {
            cancelAnimationFrame(frame);
            document.removeEventListener('visibilitychange', visibilityChanged);
            stopSound?.();
            compressor.destroy();
        };
    });
</script>

<canvas bind:this={canvas} class="jpeg-reaction" data-reaction="jpeg" data-reaction-id={reaction.id} aria-hidden="true"></canvas>

<style>
    .jpeg-reaction {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        visibility: hidden;
        image-rendering: pixelated;
        pointer-events: none;
        z-index: 1;
    }
</style>
