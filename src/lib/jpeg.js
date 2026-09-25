export const JPEG_SOUND_MS = 600;
export const JPEG_AUDIO_MS = 6000;
export const JPEG_LIFETIME_MS = JPEG_SOUND_MS + JPEG_AUDIO_MS;

export function jpegSettings(age, width, height) {
    if (age < JPEG_SOUND_MS || age >= JPEG_LIFETIME_MS || !(width > 0 && height > 0)) return null;
    // Reach maximum damage just before the last word, in twelve increasingly ugly steps.
    const progress = Math.min(1, Math.floor((age - JPEG_SOUND_MS) / (JPEG_AUDIO_MS * .9) * 12) / 12);
    const edge = Math.round(960 * Math.pow(48 / 960, progress));
    const scale = Math.min(1, edge / Math.max(width, height));
    return {width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)),
        quality: .85 * Math.pow(.01 / .85, progress), progress};
}

export function createJpegCompressor(canvas, viewport) {
    const scratch = document.createElement('canvas');
    const input = scratch.getContext('2d', {alpha: false});
    const output = canvas.getContext('2d');
    let busy = false;
    let destroyed = false;
    let generation = 0;

    function clear() {
        generation++;
        canvas.style.visibility = 'hidden';
        output?.clearRect(0, 0, canvas.width, canvas.height);
    }

    return {
        async render(settings) {
            if (destroyed || busy || !input || !output) return;
            const bounds = viewport.getBoundingClientRect();
            const videos = [...viewport.querySelectorAll('video:not([data-reaction-source])')].filter(video => {
                const style = getComputedStyle(video);
                return video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0
                    && style.visibility !== 'hidden' && Number(style.opacity) > 0
                    && !video.closest('.visualized');
            });
            if (!videos.length || !bounds.width || !bounds.height) { clear(); return; }
            busy = true;
            const current = generation;
            const sources = videos.map(video => ({video, src: video.currentSrc, stream: video.srcObject}));
            let bitmap;
            try {
                scratch.width = settings.width;
                scratch.height = settings.height;
                input.fillStyle = '#050506';
                input.fillRect(0, 0, scratch.width, scratch.height);
                const sx = scratch.width / bounds.width;
                const sy = scratch.height / bounds.height;
                for (const video of videos) {
                    const rect = video.getBoundingClientRect();
                    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
                    const width = video.videoWidth * scale;
                    const height = video.videoHeight * scale;
                    input.drawImage(video, (rect.left - bounds.left + (rect.width - width) / 2) * sx,
                        (rect.top - bounds.top + (rect.height - height) / 2) * sy, width * sx, height * sy);
                }
                // Actual browser JPEG encoding produces block artifacts and chroma loss.
                // Only one encode/decode is in flight; slow devices simply render fewer frames.
                const blob = await new Promise(resolve => scratch.toBlob(resolve, 'image/jpeg', settings.quality));
                if (!blob || destroyed || current !== generation) return;
                bitmap = await createImageBitmap(blob);
                if (destroyed || current !== generation || document.hidden) return;
                if (sources.some(({video, src, stream}) => !video.isConnected || video.readyState < 2
                    || video.currentSrc !== src || video.srcObject !== stream)) { clear(); return; }
                canvas.width = bitmap.width;
                canvas.height = bitmap.height;
                output.drawImage(bitmap, 0, 0);
                canvas.dataset.quality = String(settings.quality);
                canvas.dataset.progress = String(settings.progress);
                canvas.style.visibility = 'visible';
            } catch {
                // CORS-tainted or unavailable frames must never obscure native playback.
                clear();
            } finally {
                bitmap?.close();
                busy = false;
                if (destroyed) scratch.width = scratch.height = 0;
            }
        },
        clear,
        destroy() {
            destroyed = true;
            clear();
            if (!busy) scratch.width = scratch.height = 0;
        },
    };
}
