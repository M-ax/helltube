import test from 'node:test';
import assert from 'node:assert/strict';
import {waitForDesktopFrame} from '../src/lib/desktop-video-ready.js';

function fixture() {
    let callback;
    let frames = 10;
    let ready = 0;
    const track = {readyState: 'live', enabled: true, muted: false};
    const video = {paused: false, readyState: 4, videoWidth: 1920, videoHeight: 1080,
        srcObject: {getVideoTracks: () => [track]},
        requestVideoFrameCallback(fn) { callback = fn; return 1; }, cancelVideoFrameCallback() {},
        getVideoPlaybackQuality: () => ({totalVideoFrames: frames})};
    return {video, track, draw: () => callback(), decoded: () => frames++,
        onReady: () => ready++, ready: () => ready};
}

test('desktop readiness requires a new video frame and a live, enabled video track', () => {
    const f = fixture();
    f.track.enabled = false;
    const cancel = waitForDesktopFrame(f.video, f.onReady);
    assert.equal(f.ready(), 0, 'Old dimensions and audio readyState cannot reveal the desktop');
    f.draw();
    assert.equal(f.ready(), 0);
    f.track.enabled = true;
    f.track.muted = true;
    f.draw();
    assert.equal(f.ready(), 0);
    f.track.muted = false;
    f.draw();
    assert.equal(f.ready(), 1);
    cancel();
});

test('cancelling a pending desktop transition ignores even an already queued frame callback', () => {
    const f = fixture();
    const cancel = waitForDesktopFrame(f.video, f.onReady);
    cancel();
    f.draw();
    assert.equal(f.ready(), 0);
});

test('browsers without video frame callbacks wait for the decoded frame count to advance', t => {
    const f = fixture();
    let callback;
    delete f.video.requestVideoFrameCallback;
    const originalRequest = globalThis.requestAnimationFrame;
    const originalCancel = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = fn => { callback = fn; return 1; };
    globalThis.cancelAnimationFrame = () => {};
    t.after(() => {
        if (originalRequest) globalThis.requestAnimationFrame = originalRequest;
        else delete globalThis.requestAnimationFrame;
        if (originalCancel) globalThis.cancelAnimationFrame = originalCancel;
        else delete globalThis.cancelAnimationFrame;
    });
    const cancel = waitForDesktopFrame(f.video, f.onReady);
    callback();
    assert.equal(f.ready(), 0);
    f.decoded();
    callback();
    assert.equal(f.ready(), 1);
    cancel();
});
