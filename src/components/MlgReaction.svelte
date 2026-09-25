<script>
    import {onMount} from 'svelte';
    import {keyGreen, MLG_LEAD_MS, MLG_LIFETIME_MS} from '../lib/mlg.js';
    export let reaction;
    export let clockOffset = 0;
    export let onSound;
    let canvas;
    onMount(() => {
        // Detached, muted video supplies pixels only; shared reaction audio obeys
        // the same local mute/volume controls as every other reaction.
        const video = document.createElement('video');
        video.muted = true; video.playsInline = true; video.preload = 'auto';
        video.src = video.canPlayType('video/mp4; codecs="avc1.42E01E"')
            ? '/videos/intervention.mp4' : '/videos/intervention.webm';
        const context = canvas.getContext('2d', {willReadFrequently: true});
        const reduced = matchMedia('(prefers-reduced-motion: reduce)');
        let frame, last = -Infinity, started = false, soundHandled = false, stopSound;
        function draw() {
            const age = Math.max(0, Date.now() + clockOffset - reaction.serverTime);
            if (document.hidden || age >= MLG_LIFETIME_MS) { video.pause(); stopSound?.(); return; }
            const position = Math.max(0, (age - MLG_LEAD_MS) / 1000);
            if (video.readyState >= 2 && context) {
                if (!started && age >= MLG_LEAD_MS) {
                    started = true;
                    video.currentTime = Math.min(position, video.duration || 6);
                    void video.play().catch(() => {});
                }
                if (!soundHandled && age >= MLG_LEAD_MS) {
                    if (age - MLG_LEAD_MS > 300) soundHandled = true;
                    else { stopSound = onSound('mlg', 1, {offset: position}); soundHandled = !!stopSound; }
                }
                // Recover delayed loading without replaying the start of the clip.
                if (started && !video.seeking && Math.abs(video.currentTime - position) > .2) video.currentTime = Math.min(position, video.duration || 6);
                if (age - last >= 1000 / 30 && !video.seeking) {
                    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
                    context.drawImage(video, 0, 0);
                    const image = context.getImageData(0, 0, canvas.width, canvas.height);
                    keyGreen(image.data); context.putImageData(image, 0, 0);
                    canvas.style.visibility = 'visible';
                    canvas.dataset.frameTime = String(video.currentTime);
                    last = age;
                }
            }
            const rise = reduced.matches ? 0 : Math.pow(Math.max(0, 1 - age / MLG_LEAD_MS), 2) * 100;
            canvas.style.transform = 'translateY(' + rise + '%)';
            canvas.style.opacity = String(Math.min(1, (MLG_LIFETIME_MS - age) / 300));
            frame = requestAnimationFrame(draw);
        }
        video.load(); draw();
        return () => { cancelAnimationFrame(frame); stopSound?.(); video.pause(); video.removeAttribute('src'); video.load(); };
    });
</script>
<canvas bind:this={canvas} class="mlg-reaction" data-reaction="mlg" data-reaction-id={reaction.id} aria-hidden="true"></canvas>
<style>
    .mlg-reaction { position: absolute; bottom: 0; left: 0; width: 100%; height: 100%; visibility: hidden; pointer-events: none; z-index: 2; }
</style>
