export const CONTENT_AWARE_LIFETIME_MS = 5000;

// Remove minimum-energy vertical seams. Work at a bounded resolution so this
// deliberately exaggerated meme effect never scales with the source's 4K size.
export function carveSeams(image, targetWidth) {
    const {width, height} = image;
    const data = new Uint8ClampedArray(image.data);
    targetWidth = Math.max(2, Math.min(width, Math.round(targetWidth)));
    const costs = new Float32Array(width * height);
    const parents = new Int16Array(width * height);
    let current = width;
    const luminance = new Float32Array(width * height);
    for (let i = 0; i < luminance.length; i++) luminance[i] = data[i * 4] * .299 + data[i * 4 + 1] * .587 + data[i * 4 + 2] * .114;
    while (current > targetWidth) {
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < current; x++) {
                const i = y * width + x;
                const center = luminance[i];
                // Adjacent differences preserve thin features that a centered
                // gradient would mistakenly classify as a flat, zero-energy seam.
                const energy = Math.abs(center - luminance[y * width + Math.max(0, x - 1)])
                    + Math.abs(center - luminance[y * width + Math.min(current - 1, x + 1)])
                    + Math.abs(center - luminance[Math.max(0, y - 1) * width + x])
                    + Math.abs(center - luminance[Math.min(height - 1, y + 1) * width + x]);
                let parent = x;
                if (y) {
                    for (let dx = -1; dx <= 1; dx++) {
                        const px = x + dx;
                        if (px >= 0 && px < current && costs[(y - 1) * width + px] < costs[(y - 1) * width + parent]) parent = px;
                    }
                }
                parents[i] = parent;
                costs[i] = energy + (y ? costs[(y - 1) * width + parent] : 0);
            }
        }
        let seam = 0;
        for (let x = 1; x < current; x++) if (costs[(height - 1) * width + x] < costs[(height - 1) * width + seam]) seam = x;
        for (let y = height - 1; y >= 0; y--) {
            const parent = parents[y * width + seam];
            const start = (y * width + seam) * 4;
            data.copyWithin(start, start + 4, (y * width + current) * 4);
            luminance.copyWithin(y * width + seam, y * width + seam + 1, y * width + current);
            seam = parent;
        }
        current--;
    }
    const output = new Uint8ClampedArray(targetWidth * height * 4);
    for (let y = 0; y < height; y++) output.set(data.subarray(y * width * 4, (y * width + targetWidth) * 4), y * targetWidth * 4);
    return {data: output, width: targetWidth, height};
}

export function createContentAwareRenderer(canvas, viewport) {
    const scratch = document.createElement('canvas');
    const input = scratch.getContext('2d', {willReadFrequently: true});
    const output = canvas.getContext('2d');
    const clear = () => { canvas.style.visibility = 'hidden'; output?.clearRect(0, 0, canvas.width, canvas.height); };
    return {
        clear,
        render(age, reducedMotion = false) {
            if (!input || !output || document.hidden) { clear(); return; }
            const bounds = viewport.getBoundingClientRect();
            const videos = [...viewport.querySelectorAll('video:not([data-reaction-source])')].filter(video => {
                const style = getComputedStyle(video);
                return video.readyState >= 2 && video.videoWidth && style.visibility !== 'hidden' && Number(style.opacity) > 0
                    && !video.closest('.visualized');
            });
            if (!videos.length || !bounds.width || !bounds.height) { clear(); return; }
            try {
                scratch.width = 160;
                scratch.height = Math.max(2, Math.min(120, Math.round(160 * bounds.height / bounds.width)));
                input.fillStyle = '#050506';
                input.fillRect(0, 0, scratch.width, scratch.height);
                for (const video of videos) {
                    const rect = video.getBoundingClientRect();
                    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
                    const w = video.videoWidth * scale, h = video.videoHeight * scale;
                    input.drawImage(video, (rect.left - bounds.left + (rect.width - w) / 2) * scratch.width / bounds.width,
                        (rect.top - bounds.top + (rect.height - h) / 2) * scratch.height / bounds.height,
                        w * scratch.width / bounds.width, h * scratch.height / bounds.height);
                }
                const amount = reducedMotion ? .4 : .35 + .18 * Math.sin(age / 420);
                const carved = carveSeams(input.getImageData(0, 0, scratch.width, scratch.height), scratch.width * (1 - amount));
                canvas.width = carved.width;
                canvas.height = carved.height;
                output.putImageData(new ImageData(carved.data, carved.width, carved.height), 0, 0);
                canvas.dataset.seams = String(scratch.width - carved.width);
                canvas.style.visibility = 'visible';
            } catch { clear(); }
        },
        destroy() { clear(); scratch.width = scratch.height = 0; },
    };
}
