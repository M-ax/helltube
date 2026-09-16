export function time(seconds) {
    if (!Number.isFinite(seconds)) return '—';
    const value = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(value / 3600);
    const minutes = Math.floor((value % 3600) / 60);
    return `${hours ? `${hours}:${String(minutes).padStart(2, '0')}` : minutes}:${String(value % 60).padStart(2, '0')}`;
}

export function bytes(value) {
    if (!Number.isFinite(value) || value <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const unit = Math.min(Math.floor(Math.log(value) / Math.log(1024)), units.length - 1);
    return `${(value / 1024 ** unit).toFixed(unit > 0 ? 1 : 0)} ${units[unit]}`;
}

export function initials(name = '') {
    return name.trim().split(/\s+/).slice(0, 2).map((part) => Array.from(part)[0] || '').join('').toUpperCase() || '?';
}

export function targetPosition(room, clockOffset = 0, now = Date.now()) {
    if (!room?.playback) return 0;
    const {position, paused, updatedAt} = room.playback;
    const elapsed = paused ? 0 : Math.max(0, (now + clockOffset - updatedAt) / 1000);
    const target = Math.max(0, position + elapsed);
    return Number.isFinite(room.current?.duration) && room.current.duration > 0
        ? Math.min(target, room.current.duration)
        : target;
}

export function driftCorrection(target, actual) {
    const drift = target - actual;
    if (Math.abs(drift) > 1) return {seek: target, rate: 1};
    return {seek: null, rate: Math.abs(drift) >= 0.15 ? (drift > 0 ? 1.03 : 0.97) : 1};
}

export function imageUrl(value) {
    if (!value) return null;
    try {
        const url = new URL(value, window.location.origin);
        return ['https:', 'http:'].includes(url.protocol) ? url.href : null;
    } catch {
        return null;
    }
}

export function mediaUrl(value) {
    const url = imageUrl(value);
    return url && new URL(url).origin === window.location.origin ? url : null;
}

export function isYoutubeUrl(value) {
    try {
        const url = new URL(value);
        return ['https:', 'http:'].includes(url.protocol)
            && (url.hostname === 'youtu.be' || url.hostname === 'youtube.com' || url.hostname.endsWith('.youtube.com'));
    } catch {
        return false;
    }
}