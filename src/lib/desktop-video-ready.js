// Audio can already be playing while video is still negotiating. Wait for a
// newly presented video frame, including when resuming a previously paused track.
export function waitForDesktopFrame(video, onReady) {
    let cancelled = false;
    let callback;
    const frameCallbacks = typeof video.requestVideoFrameCallback === 'function';
    const decodedFrames = () => video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount;
    const initialFrames = decodedFrames();
    const schedule = () => {
        callback = frameCallbacks ? video.requestVideoFrameCallback(check) : requestAnimationFrame(check);
    };
    function check() {
        if (cancelled) return;
        const fresh = frameCallbacks || initialFrames === undefined || decodedFrames() > initialFrames;
        const track = video.srcObject?.getVideoTracks().find(track => track.readyState === 'live' && track.enabled && !track.muted);
        if (fresh && track && !video.paused && video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
            onReady();
        } else schedule();
    }
    schedule();
    return () => {
        cancelled = true;
        if (frameCallbacks) video.cancelVideoFrameCallback(callback);
        else cancelAnimationFrame(callback);
    };
}
