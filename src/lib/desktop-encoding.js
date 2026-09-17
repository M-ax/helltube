export const desktopVideoEncoding = {maxBitrate: 6_000_000, maxFramerate: 30};

// WebRTC has no API to force a GPU encoder. Prefer the browser's power-efficiency
// signal for the negotiated profile; the browser still owns hardware/software
// fallback. Keep both codecs even when a capability probe reports unsupported.
export async function desktopVideoCodecs(codecs, track, {
    mediaCapabilities = globalThis.navigator?.mediaCapabilities, timeout = 750,
} = {}) {
    const candidates = (codecs || []).filter(codec => /^video\/(h264|vp8)$/i.test(codec.mimeType));
    if (candidates.length < 2) return candidates;
    const settings = track.getSettings?.() || {};
    const results = new Map();
    let timer;
    try {
        if (typeof mediaCapabilities?.encodingInfo === 'function') {
            await Promise.race([
                Promise.all(candidates.map(async codec => {
                    try {
                        const parameters = Object.entries(codec.parameters || {}).map(([key, value]) => `${key}=${value}`);
                        const info = await mediaCapabilities.encodingInfo({type: 'webrtc', video: {
                            contentType: [codec.mimeType, ...parameters].join(';'),
                            width: settings.width || 1920, height: settings.height || 1080,
                            bitrate: desktopVideoEncoding.maxBitrate,
                            framerate: Math.min(settings.frameRate || 30, desktopVideoEncoding.maxFramerate),
                        }});
                        results.set(codec, info);
                    } catch { /* Older browsers may not support WebRTC queries. */ }
                })),
                new Promise(resolve => { timer = setTimeout(resolve, timeout); }),
            ]);
        }
    } finally { clearTimeout(timer); }
    const rank = codec => {
        const info = results.get(codec);
        return info?.supported ? (info.powerEfficient ? 0 : 1) : info?.supported === false ? 3 : 2;
    };
    return candidates.sort((a, b) => rank(a) - rank(b) ||
        // With no capability information, H.264 is an opportunistic hardware
        // choice. Otherwise retain the relay's order among equally good codecs.
        (rank(a) === 2 ? Number(/h264/i.test(b.mimeType)) - Number(/h264/i.test(a.mimeType)) : 0));
}
