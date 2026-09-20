// The relay forwards one encoding to every viewer, within this media budget.
export const desktopLimits = Object.freeze({width: 1920, height: 1080, frameRate: 60,
    videoBitrate: 12_000_000, audioBitrate: 192_000});

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
