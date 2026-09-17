import {get, writable} from 'svelte/store';
import {createDesktopPeer} from './desktop-peer.js';

export const desktopCaptureOptions = {
    video: {width: {ideal: 1920, max: 1920}, height: {ideal: 1080, max: 1080}, frameRate: {ideal: 30, max: 30}},
    audio: {suppressLocalAudioPlayback: false, restrictOwnAudio: true},
    systemAudio: 'include', windowAudio: 'system', selfBrowserSurface: 'exclude',
    surfaceSwitching: 'include', monitorTypeSurfaces: 'include',
};

export function desktopSupport({secure = globalThis.isSecureContext, devices = globalThis.navigator?.mediaDevices,
    Peer = globalThis.RTCPeerConnection} = {}) {
    if (!secure) return 'Desktop sharing requires HTTPS or localhost. Open the secure site to share.';
    if (!devices?.getDisplayMedia || !Peer) return 'Desktop sharing is not supported in this browser. Try desktop Chrome or Edge.';
    return '';
}

const emptyPlayback = () => ({itemId: null, stream: null, error: '', local: false, stats: null, connectionState: 'new'});
const connectionError = 'The desktop connection to metal failed. Retry playback. If it keeps failing, the server administrator should check the media port or TURN configuration.';

export function createDesktopShare(client, {devices = globalThis.navigator?.mediaDevices,
    Peer = globalThis.RTCPeerConnection, Stream = globalThis.MediaStream, secure = globalThis.isSecureContext,
    makePeer = createDesktopPeer, connectTimeout = 20000, disconnectTimeout = 5000} = {}) {
    const state = writable({status: 'idle', roomId: null, error: '', label: '', hasAudio: false});
    const playback = writable(emptyPlayback());
    let operation;
    let viewing;

    function closeView(notifyServer = true) {
        const previous = viewing;
        viewing = null;
        if (previous) {
            clearTimeout(previous.timer);
            previous.peer?.close();
            if (notifyServer && previous.requestId) client.command({type: 'desktop:unwatch', requestId: previous.requestId});
        }
        playback.set(emptyPlayback());
    }

    function stop(error = '', notifyServer = true) {
        const previous = operation;
        operation = null;
        if (previous) {
            clearTimeout(previous.timer);
            clearTimeout(previous.connectionTimer);
            previous.peer?.close();
            previous.stream?.getTracks().forEach(track => track.stop());
            if (viewing?.local) closeView(false);
            if (notifyServer && previous.requested) client.command({type: 'desktop:stop', requestId: previous.requestId});
        }
        state.set({status: 'idle', roomId: null, error, label: '', hasAudio: false});
    }

    async function start() {
        if (operation) return;
        const room = get(client.state);
        const unsupported = desktopSupport({devices, Peer, secure});
        if (unsupported) { stop(unsupported); return; }
        if (!room.joined || room.status !== 'connected' || !room.room) { stop('Join a room before sharing.'); return; }
        const pending = {roomId: room.room.id, requestId: crypto.randomUUID(), restarts: 0};
        operation = pending;
        state.set({status: 'choosing', roomId: pending.roomId, error: '', label: '', hasAudio: false});
        try {
            // Keep this call in the button's activation, before any other await.
            const stream = await devices.getDisplayMedia(desktopCaptureOptions);
            if (operation !== pending) { stream.getTracks().forEach(track => track.stop()); return; }
            pending.stream = stream;
            if (!stream.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('The selected screen is no longer available. Choose it again.');
            const hasAudio = stream.getAudioTracks().some(track => track.readyState === 'live');
            for (const track of stream.getTracks()) {
                if (track.kind === 'video') track.contentHint = 'motion';
                track.addEventListener('ended', () => {
                    if (operation !== pending) return;
                    if (track.kind === 'video') stop();
                    else state.update(value => ({...value, hasAudio: stream.getAudioTracks().some(track => track.readyState === 'live')}));
                }, {once: true});
            }
            pending.requested = true;
            state.set({status: 'starting', roomId: pending.roomId, error: '', label: stream.getVideoTracks()[0].label || 'Your desktop', hasAudio});
            pending.timer = setTimeout(() => { if (operation === pending) stop('The server did not start sharing. Please try again.'); }, 15000);
            if (!client.command({type: 'desktop:start', requestId: pending.requestId, transport: 'mediasoup', audio: hasAudio})) {
                stop('The room connection was lost. Please try again.');
            }
        } catch (error) {
            if (operation !== pending) return;
            stop(error.name === 'NotAllowedError' ? 'Screen sharing was cancelled or permission was denied. Choose Share desktop to try again.'
                : error.name === 'NotReadableError' ? 'The screen could not be captured. Check your operating system’s screen recording permission and try again.'
                : error.message || 'Desktop sharing could not start.');
        }
    }

    function restartPublisher(pending) {
        if (operation !== pending) return;
        clearTimeout(pending.connectionTimer);
        if (pending.restarts++ >= 2) { stop(connectionError); return; }
        pending.connectionTimer = setTimeout(() => restartPublisher(pending), connectTimeout);
        void pending.peer.restartIce().catch(() => { if (operation === pending) stop(connectionError); });
    }

    function watch(itemId, attempts = 0) {
        closeView();
        const pending = {itemId, requestId: crypto.randomUUID(), attempts};
        viewing = pending;
        playback.set({...emptyPlayback(), itemId});
        if (!Peer) {
            playback.update(value => ({...value, error: 'This browser does not support WebRTC desktop playback.'}));
            return;
        }
        pending.timer = setTimeout(() => failView(pending), connectTimeout);
        if (!client.command({type: 'desktop:watch', requestId: pending.requestId, itemId})) failView(pending, 'The room connection was lost.');
    }

    function failView(pending, error = connectionError, retry = true) {
        if (viewing !== pending || pending.finished) return;
        clearTimeout(pending.timer);
        pending.peer?.close();
        pending.peer = null;
        if (retry && pending.attempts < 2) {
            watch(pending.itemId, pending.attempts + 1);
            return;
        }
        pending.finished = true;
        client.command({type: 'desktop:unwatch', requestId: pending.requestId});
        playback.set({...emptyPlayback(), itemId: pending.itemId, error});
    }

    const unsubscribeMessages = client.desktopMessages.subscribe(message => {
        if (!message || message.rpcId) return; // RPC replies belong to the transport helper.
        const pending = operation;
        if (pending && message.requestId === pending.requestId) {
            if (message.type === 'desktop:started') {
                if (pending.itemId) return;
                clearTimeout(pending.timer);
                pending.itemId = message.itemId;
                pending.connectionTimer = setTimeout(() => { if (operation === pending) stop(connectionError); }, connectTimeout);
                try {
                    pending.peer = makePeer({client, connection: message, Stream, stream: pending.stream,
                        onStats: stats => {
                            if (operation !== pending) return;
                            pending.stats = stats;
                            if (viewing?.local && viewing.itemId === pending.itemId) playback.update(value => ({...value, stats}));
                        },
                        onState: status => {
                            if (operation !== pending) return;
                            pending.connectionState = status;
                            if (viewing?.local && viewing.itemId === pending.itemId) playback.update(value => ({...value, connectionState: status}));
                            if (status === 'connected') clearTimeout(pending.connectionTimer);
                            else if (status === 'failed') restartPublisher(pending);
                            else if (status === 'disconnected') {
                                clearTimeout(pending.connectionTimer);
                                pending.connectionTimer = setTimeout(() => restartPublisher(pending), disconnectTimeout);
                            }
                        },
                    });
                    void pending.peer.start().then(() => {
                        if (operation === pending) state.update(value => ({...value, status: 'sharing'}));
                    }).catch(error => { if (operation === pending) stop(error.message || connectionError); });
                } catch { stop(connectionError); }
            } else if (message.type === 'desktop:error' || message.type === 'desktop:stopped') stop(message.message || '', false);
            return;
        }
        const view = viewing;
        if (!view || view.finished || message.requestId !== view.requestId) return;
        if (message.type === 'desktop:watching' && !view.peer && message.itemId === view.itemId) {
            view.peerId = message.peerId;
            try {
                view.peer = makePeer({client, connection: message, Stream,
                    onStream: stream => {
                        if (viewing === view && !view.finished) playback.update(value => ({...value, stream, error: ''}));
                    },
                    onStats: stats => {
                        if (viewing === view && !view.finished) playback.update(value => ({...value, stats}));
                    },
                    onState: status => {
                        if (viewing !== view || view.finished) return;
                        playback.update(value => ({...value, connectionState: status}));
                        if (status === 'connected') clearTimeout(view.timer);
                        else if (status === 'failed') failView(view);
                        else if (status === 'disconnected') {
                            clearTimeout(view.timer);
                            view.timer = setTimeout(() => failView(view), disconnectTimeout);
                        }
                    },
                });
                void view.peer.start().catch(error => failView(view, error.message || connectionError));
            } catch { failView(view); }
        } else if (message.type === 'desktop:error') failView(view, message.message, false);
        else if (message.type === 'desktop:stopped') closeView(false);
    });

    const unsubscribeRoom = client.state.subscribe(room => {
        const joined = room.joined && room.status === 'connected' && room.room;
        if (operation) {
            if (!joined || room.room.id !== operation.roomId) {
                stop('Desktop sharing stopped because you left the room or lost the connection.', false);
            } else if (operation.itemId && room.room.current?.id !== operation.itemId) stop('', false);
        }
        const itemId = joined && room.room.current?.kind === 'desktop' ? room.room.current.id : null;
        if (viewing?.itemId === itemId) return;
        closeView(!!joined);
        if (!itemId) return;
        if (operation?.itemId === itemId) {
            viewing = {itemId, local: true};
            playback.set({...emptyPlayback(), itemId, stream: operation.stream, local: true,
                stats: operation.stats || null, connectionState: operation.connectionState || 'new'});
        } else watch(itemId);
    });
    return {state, playback, start, stop, active: () => !!operation,
        retryView() { if (viewing && !viewing.local) watch(viewing.itemId); },
        dispose() { unsubscribeMessages(); unsubscribeRoom(); closeView(); stop(); }};
}
