import {get, writable} from 'svelte/store';
import {createDesktopPeer} from './desktop-peer.js';
import {desktopVideoEncoding} from './desktop-encoding.js';
import {normalizeDesktopQuality} from '../../shared/desktop-quality.js';

export const desktopCaptureOptions = {
    video: {width: {ideal: 1920, max: 1920}, height: {ideal: 1080, max: 1080},
        frameRate: {ideal: desktopVideoEncoding.maxFramerate, max: desktopVideoEncoding.maxFramerate}},
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
    makePeer = createDesktopPeer, connectTimeout = 20000, disconnectTimeout = 5000,
    quality, watchRemote = true} = {}) {
    const state = writable({status: 'idle', roomId: null, error: '', label: '', hasAudio: false,
        videoBitrate: normalizeDesktopQuality(typeof quality === 'function' ? undefined : quality).videoBitrate});
    const playback = writable({});
    let operation;
    let selectedBitrate;
    const views = new Map();
    let viewingRoom = null;

    function updateView(itemId, patch) {
        playback.update(value => ({...value, [itemId]: {...value[itemId], ...patch}}));
    }

    function closeView(itemId, notifyServer = true) {
        const previous = views.get(itemId);
        views.delete(itemId);
        if (previous) {
            clearTimeout(previous.timer);
            previous.peer?.close();
            if (notifyServer && previous.requestId) client.command({type: 'desktop:unwatch', requestId: previous.requestId});
        }
        playback.update(value => {
            const next = {...value};
            delete next[itemId];
            return next;
        });
    }

    function stop(error = '', notifyServer = true) {
        const previous = operation;
        operation = null;
        if (previous) {
            clearTimeout(previous.timer);
            clearTimeout(previous.connectionTimer);
            previous.peer?.close();
            previous.stream?.getTracks().forEach(track => track.stop());
            if (views.get(previous.itemId)?.local) closeView(previous.itemId, false);
            if (notifyServer && previous.requested) client.command({type: 'desktop:stop', requestId: previous.requestId});
        }
        state.update(value => ({...value, status: 'idle', roomId: null, error, label: '', hasAudio: false}));
    }

    async function setVideoBitrate(value) {
        const videoBitrate = normalizeDesktopQuality({videoBitrate: value}).videoBitrate;
        const pending = operation;
        if (pending) {
            if (get(state).status !== 'sharing') throw new Error('Wait for desktop sharing to start before changing the bitrate.');
            try { await pending.peer.setVideoBitrate(videoBitrate); }
            catch (error) { if (operation === pending) throw error; }
            if (operation !== pending) return;
            pending.quality = {...pending.quality, videoBitrate};
        }
        selectedBitrate = videoBitrate;
        state.update(value => ({...value, videoBitrate}));
    }

    async function start() {
        if (operation) return;
        const room = get(client.state);
        const unsupported = desktopSupport({devices, Peer, secure});
        if (unsupported) { stop(unsupported); return; }
        if (!room.joined || room.status !== 'connected' || !room.room) { stop('Join a room before sharing.'); return; }
        const pending = {roomId: room.room.id, requestId: crypto.randomUUID(), restarts: 0,
            quality: typeof quality === 'function' ? quality() : quality};
        if (selectedBitrate !== undefined) pending.quality = {...pending.quality, videoBitrate: selectedBitrate};
        operation = pending;
        state.set({status: 'choosing', roomId: pending.roomId, error: '', label: '', hasAudio: false,
            videoBitrate: normalizeDesktopQuality(pending.quality).videoBitrate});
        try {
            // Keep this call in the button's activation, before any other await.
            const stream = await devices.getDisplayMedia(desktopCaptureOptions);
            if (operation !== pending) { stream.getTracks().forEach(track => track.stop()); return; }
            pending.stream = stream;
            if (!stream.getVideoTracks().some(track => track.readyState === 'live')) throw new Error('The selected screen is no longer available. Choose it again.');
            const hasAudio = stream.getAudioTracks().some(track => track.readyState === 'live');
            for (const track of stream.getTracks()) {
                if (track.kind === 'video') track.contentHint = pending.quality?.contentHint || 'motion';
                track.addEventListener('ended', () => {
                    if (operation !== pending) return;
                    if (track.kind === 'video') stop();
                    else state.update(value => ({...value, hasAudio: stream.getAudioTracks().some(track => track.readyState === 'live')}));
                }, {once: true});
            }
            pending.requested = true;
            state.update(value => ({...value, status: 'starting', label: stream.getVideoTracks()[0].label || 'Your desktop', hasAudio}));
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

    function watch(itemId, attempts = 0, videoEnabled = views.get(itemId)?.videoEnabled ?? true) {
        closeView(itemId);
        const pending = {itemId, requestId: crypto.randomUUID(), attempts, videoEnabled};
        views.set(itemId, pending);
        updateView(itemId, {...emptyPlayback(), itemId, videoEnabled, videoError: ''});
        if (!Peer) {
            updateView(itemId, {error: 'This browser does not support WebRTC desktop playback.'});
            return;
        }
        pending.timer = setTimeout(() => failView(pending), connectTimeout);
        if (!client.command({type: 'desktop:watch', requestId: pending.requestId, itemId})) failView(pending, 'The room connection was lost.');
    }

    function failView(pending, error = connectionError, retry = true) {
        if (views.get(pending.itemId) !== pending || pending.finished) return;
        clearTimeout(pending.timer);
        pending.peer?.close();
        pending.peer = null;
        if (retry && pending.attempts < 2) {
            watch(pending.itemId, pending.attempts + 1);
            return;
        }
        pending.finished = true;
        client.command({type: 'desktop:unwatch', requestId: pending.requestId});
        updateView(pending.itemId, {...emptyPlayback(), itemId: pending.itemId, error});
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
                    pending.peer = makePeer({client, connection: message, Stream, stream: pending.stream, quality: pending.quality,
                        onStats: stats => {
                            if (operation !== pending) return;
                            pending.stats = stats;
                            if (views.get(pending.itemId)?.local) updateView(pending.itemId, {stats});
                        },
                        onState: status => {
                            if (operation !== pending) return;
                            pending.connectionState = status;
                            if (views.get(pending.itemId)?.local) updateView(pending.itemId, {connectionState: status});
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
        const view = [...views.values()].find(value => value.requestId === message.requestId);
        if (!view || view.finished) return;
        if (message.type === 'desktop:watching' && !view.peer && message.itemId === view.itemId) {
            view.peerId = message.peerId;
            try {
                view.peer = makePeer({client, connection: message, Stream, videoEnabled: view.videoEnabled,
                    onVideoError: videoError => {
                        if (views.get(view.itemId) === view && !view.finished) updateView(view.itemId, {videoError});
                    },
                    onStream: stream => {
                        if (views.get(view.itemId) === view && !view.finished) updateView(view.itemId, {stream, error: ''});
                    },
                    onStats: stats => {
                        if (views.get(view.itemId) === view && !view.finished) updateView(view.itemId, {stats});
                    },
                    onState: status => {
                        if (views.get(view.itemId) !== view || view.finished) return;
                        updateView(view.itemId, {connectionState: status});
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
        else if (message.type === 'desktop:stopped') closeView(view.itemId, false);
    });

    const unsubscribeRoom = client.state.subscribe(room => {
        const joined = room.joined && room.status === 'connected' && room.room;
        const items = joined ? room.room.desktops ?? (room.room.current?.kind === 'desktop' ? [room.room.current] : []) : [];
        const itemIds = new Set(items.map(item => item.id));
        if (operation) {
            if (!joined || room.room.id !== operation.roomId) {
                stop('Desktop sharing stopped because you left the room or lost the connection.', false);
            } else if (operation.itemId && !itemIds.has(operation.itemId)) stop('', false);
        }
        const roomId = joined ? room.room.id : null;
        for (const itemId of views.keys()) {
            if (viewingRoom !== roomId || !itemIds.has(itemId)) closeView(itemId, !!joined && viewingRoom === roomId);
        }
        viewingRoom = roomId;
        for (const itemId of itemIds) {
            if (views.has(itemId)) continue;
            if (operation?.itemId === itemId) {
                views.set(itemId, {itemId, local: true});
                updateView(itemId, {...emptyPlayback(), itemId, stream: operation.stream, local: true,
                    stats: operation.stats || null, connectionState: operation.connectionState || 'new'});
            } else if (watchRemote) watch(itemId, 0, items.find(item => item.id === itemId)?.provider !== 'spotify');
        }
    });

    function setVideoEnabled(itemId, enabled, retry = false) {
        const view = views.get(itemId);
        if (!view || view.local || view.finished || (!retry && view.videoEnabled === enabled)) return;
        view.videoEnabled = !!enabled;
        updateView(itemId, {videoEnabled: view.videoEnabled, videoError: ''});
        void view.peer?.setVideoEnabled(view.videoEnabled).catch(error => {
            if (views.get(itemId) === view && !view.finished) updateView(itemId, {videoError: error.message});
        });
    }
    return {state, playback, start, stop, active: () => !!operation,
        setVideoBitrate, setVideoEnabled,
        retryVideo(itemId) { setVideoEnabled(itemId, views.get(itemId)?.videoEnabled, true); },
        retryView(itemId) {
            const view = views.get(itemId);
            if (view && !view.local) watch(itemId);
        },
        dispose() {
            unsubscribeMessages(); unsubscribeRoom();
            for (const itemId of views.keys()) closeView(itemId);
            stop();
        }};
}
