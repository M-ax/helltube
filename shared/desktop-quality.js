// Shared by the browser publisher and native caster. The relay forwards one
// encoding to every viewer; keep the entire ladder inside its existing budget.
export const desktopLimits = Object.freeze({width: 1920, height: 1080, frameRate: 60,
    videoBitrate: 6_000_000, audioBitrate: 128_000});

export const casterPresets = Object.freeze({
    balanced: {width: 1280, height: 720, frameRate: 30, videoBitrate: 2_500_000, audioBitrate: 96_000},
    detail: {width: 1920, height: 1080, frameRate: 30, videoBitrate: 4_500_000, audioBitrate: 128_000},
    motion: {width: 1920, height: 1080, frameRate: 60, videoBitrate: 6_000_000, audioBitrate: 128_000},
    constrained: {width: 854, height: 480, frameRate: 24, videoBitrate: 1_000_000, audioBitrate: 64_000},
});

const bounded = (value, fallback, min, max) => Math.round(Math.min(max, Math.max(min,
    typeof value === 'number' && Number.isFinite(value) ? value : fallback)));
const choice = (value, choices, fallback) => choices.includes(value) ? value : fallback;

export function normalizeDesktopQuality(value = {}) {
    value ??= {};
    return {
        width: bounded(value.width, 1920, 320, desktopLimits.width) & ~1,
        height: bounded(value.height, 1080, 180, desktopLimits.height) & ~1,
        frameRate: bounded(value.frameRate, 60, 10, desktopLimits.frameRate),
        videoBitrate: bounded(value.videoBitrate, desktopLimits.videoBitrate, 300_000, desktopLimits.videoBitrate),
        audioBitrate: bounded(value.audioBitrate, desktopLimits.audioBitrate, 32_000, desktopLimits.audioBitrate),
        codec: choice(value.codec, ['auto', 'h264', 'vp8'], 'auto'),
        contentHint: choice(value.contentHint, ['motion', 'detail', 'text'], 'motion'),
        degradationPreference: choice(value.degradationPreference,
            ['balanced', 'maintain-framerate', 'maintain-resolution'], 'balanced'),
        stereo: value.stereo !== false,
        dtx: value.dtx === true,
    };
}

// Coordinates are normalized to the selected capture, never to desktop/DPI
// coordinates. Clamping keeps a region valid when a window changes size.
export function cropRectangle(region, width, height) {
    const clamp = (v, fallback, min, max) => Math.min(max, Math.max(min, Number.isFinite(v) ? v : fallback));
    const x = Math.floor(clamp(region?.x, 0, 0, 0.99) * width);
    const y = Math.floor(clamp(region?.y, 0, 0, 0.99) * height);
    return {x, y, width: Math.max(1, Math.min(width - x, Math.round(clamp(region?.width, 1, 0.01, 1) * width))),
        height: Math.max(1, Math.min(height - y, Math.round(clamp(region?.height, 1, 0.01, 1) * height)))};
}
