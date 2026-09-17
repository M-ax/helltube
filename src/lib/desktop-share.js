import {get, writable} from 'svelte/store';

export const desktopMimeType = 'video/webm;codecs=vp8,opus';
export const desktopCaptureOptions = {
    video: {width: {ideal: 1920, max: 1920}, height: {ideal: 1080, max: 1080}, frameRate: {ideal: 30, max: 30}},
    audio: {suppressLocalAudioPlayback: false, restrictOwnAudio: true},
    systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
};

export function desktopSupport({secure = globalThis.isSecureContext, devices = globalThis.navigator?.mediaDevices,
    Recorder = globalThis.MediaRecorder} = {}) {
    if (!secure) return 'Desktop sharing requires HTTPS or localhost. Open the secure site to share.';
    if (!devices?.getDisplayMedia || !Recorder?.isTypeSupported?.(desktopMimeType)) {
        return 'Desktop sharing with audio is not supported in this browser. Try desktop Chrome or Edge.';
    }
    return '';
}

export function createDesktopShare(client, {devices = globalThis.navigator?.mediaDevices,
    Recorder = globalThis.MediaRecorder, secure = globalThis.isSecureContext} = {}) {
    const state = writable({status: 'idle', roomId: null, error: '', label: ''});
    let operation;

    function stop(error = '', notifyServer = true) {
        const previous = operation;
        operation = null;
        if (previous) {
            clearTimeout(previous.timer);
            if (previous.recorder && previous.recorder.state !== 'inactive') previous.recorder.stop();
            previous.stream?.getTracks().forEach(track => track.stop());
            if (notifyServer && previous.requested) client.command({type: 'desktop:stop', requestId: previous.requestId});
        }
        state.set({status: 'idle', roomId: null, error, label: ''});
    }

    async function start() {
        if (operation) return;
        const room = get(client.state);
        const unsupported = desktopSupport({devices, Recorder, secure});
        if (unsupported) { stop(unsupported); return; }
        if (!room.joined || room.status !== 'connected' || !room.room) { stop('Join a room before sharing.'); return; }
        const pending = {roomId: room.room.id, requestId: crypto.randomUUID()};
        operation = pending;
        state.set({status: 'choosing', roomId: pending.roomId, error: '', label: ''});
        try {
            // Keep this call in the button's activation, before any other await.
            const stream = await devices.getDisplayMedia(desktopCaptureOptions);
            if (operation !== pending) { stream.getTracks().forEach(track => track.stop()); return; }
            pending.stream = stream;
            if (!stream.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('The selected screen is no longer available. Choose it again.');
            if (!stream.getAudioTracks().some(track => track.readyState === 'live')) {
                throw new Error('No shared audio was received. Choose again and enable “Share audio” in the browser picker. If window or display audio is unavailable, share a browser tab with tab audio in Chrome or Edge.');
            }
            for (const track of stream.getTracks()) track.addEventListener('ended', () => {
                if (operation === pending) stop(track.kind === 'audio' ? 'Shared audio ended. Choose your screen and audio again.' : '');
            }, {once: true});
            pending.recorder = new Recorder(stream, {mimeType: desktopMimeType, videoBitsPerSecond: 3_000_000, audioBitsPerSecond: 128_000});
            pending.recorder.ondataavailable = ({data}) => {
                if (operation !== pending || !data.size) return;
                if (data.size > 4 * 1024 * 1024) { stop('Desktop capture fell behind. Start sharing again.'); return; }
                for (let offset = 0; offset < data.size; offset += 256 * 1024) {
                    if (!client.sendCapture(data.slice(offset, offset + 256 * 1024))) {
                        stop('Desktop sharing stopped because the connection could not keep up. Please try again.');
                        break;
                    }
                }
            };
            pending.recorder.onerror = () => { if (operation === pending) stop('Desktop capture failed. Please choose your screen again.'); };
            pending.recorder.onstop = () => { if (operation === pending) stop('Desktop capture ended.'); };
            pending.requested = true;
            state.set({status: 'starting', roomId: pending.roomId, error: '', label: stream.getVideoTracks()[0].label || 'Your desktop'});
            pending.timer = setTimeout(() => { if (operation === pending) stop('The server did not start sharing. Please try again.'); }, 15000);
            if (!client.command({type: 'desktop:start', requestId: pending.requestId, mimeType: desktopMimeType, audio: true})) {
                stop('The room connection was lost. Please try again.');
            }
        } catch (error) {
            if (operation !== pending) return;
            stop(error.name === 'NotAllowedError' ? 'Screen sharing was cancelled or permission was denied. Choose Share desktop to try again.'
                : error.name === 'NotReadableError' ? 'The screen could not be captured. Check your operating system’s screen recording permission and try again.'
                : error.message || 'Desktop sharing could not start.');
        }
    }

    const unsubscribeMessages = client.desktopMessages.subscribe(message => {
        const pending = operation;
        if (!pending || message?.requestId !== pending.requestId) return;
        if (message.type === 'desktop:started') {
            if (pending.itemId) return;
            clearTimeout(pending.timer);
            pending.itemId = message.itemId;
            try {
                pending.recorder.start(250);
                state.update(value => ({...value, status: 'sharing'}));
            } catch { stop('Desktop recording could not start. Try Chrome or Edge.'); }
        } else if (message.type === 'desktop:error' || message.type === 'desktop:stopped') stop(message.message || '', false);
    });
    const unsubscribeRoom = client.state.subscribe(room => {
        if (!operation) return;
        if (!room.joined || room.status !== 'connected' || room.room?.id !== operation.roomId) {
            stop('Desktop sharing stopped because you left the room or lost the connection.', false);
        } else if (operation.itemId && room.room.current?.id !== operation.itemId) stop('', false);
    });
    return {state, start, stop, active: () => !!operation, dispose() { stop(); unsubscribeMessages(); unsubscribeRoom(); }};
}
