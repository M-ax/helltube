import {get, writable} from 'svelte/store';
import {api} from './api.js';

const HEARTBEAT_INTERVAL = 1500;
const RESPONSE_TIMEOUT = 15000;
const CONNECTION_TIMEOUT = 15000;
const SESSION_CHECK_TIMEOUT = 10000;

export function createRealtime({onMessage, onSessionEnded, windowTarget = window, documentTarget = document,
    WebSocketImpl = WebSocket, now = () => performance.now(), request = api}) {
    const emptyReactions = () => ({roomId: null, ball: null, serverTime: 0, events: []});
    const reactions = writable(emptyReactions());
    const state = writable({
        status: 'offline', rooms: [], room: null, selectedRoomId: null,
        joined: false, clockOffset: 0, rtt: null, clockReady: false, overlay: null,
    });
    let socket;
    let stopped = true;
    let retryTimer;
    let heartbeat;
    let connectionTimer;
    let sessionCheck;
    let sessionTimer;
    let attempt = 0;
    let generation = 0;
    let lastResponse = 0;
    let lastHeartbeat = 0;
    let storageKey;
    let samples = [];

    function send(message) {
        if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch {
            reconnect();
            return false;
        }
    }

    function closeSocket() {
        generation++;
        clearTimeout(retryTimer);
        clearTimeout(connectionTimer);
        clearInterval(heartbeat);
        const previous = socket;
        socket = null;
        previous?.close();
    }

    function cancelSessionCheck() {
        sessionCheck?.abort();
        sessionCheck = null;
        clearTimeout(sessionTimer);
    }

    function checkSession() {
        if (sessionCheck) return;
        const controller = new AbortController();
        sessionCheck = controller;
        sessionTimer = setTimeout(cancelSessionCheck, SESSION_CHECK_TIMEOUT);
        void request('/api/me', {signal: controller.signal}).catch(error => {
            if (error.status === 401 && sessionCheck === controller && !stopped) {
                disconnect();
                onSessionEnded();
            }
        }).finally(() => {
            if (sessionCheck === controller) cancelSessionCheck();
        });
    }

    function reconnect(event) {
        if (stopped) return;
        // Retire the socket immediately: a broken transport may never deliver close.
        closeSocket();
        if ([1008, 4001, 4401].includes(event?.code)) {
            disconnect();
            onSessionEnded();
            return;
        }
        if (windowTarget.navigator.onLine === false) {
            offline();
            return;
        }
        state.update(current => ({...current, status: 'reconnecting', joined: false}));
        reactions.set(emptyReactions());
        checkSession();
        const delay = Math.min(15000, 750 * 2 ** attempt++) + Math.random() * 350;
        retryTimer = setTimeout(open, delay);
    }

    function resetClock() {
        samples = [];
        state.update(current => ({...current, clockReady: false, rtt: null}));
    }

    function beat() {
        const time = now();
        const delayed = time - lastHeartbeat > RESPONSE_TIMEOUT;
        // Hidden/frozen tabs cannot meet a foreground deadline. Probe again after
        // a delayed callback, giving queued messages time to run before judging it.
        if (documentTarget.visibilityState === 'hidden' || delayed) {
            lastResponse = time;
        }
        if (delayed) resetClock();
        lastHeartbeat = time;
        if (time - lastResponse >= RESPONSE_TIMEOUT) reconnect();
        else send({type: 'ping', sentAt: Date.now()});
    }

    function wake() {
        if (stopped || documentTarget.visibilityState === 'hidden' || windowTarget.navigator.onLine === false) return;
        if (socket?.readyState === WebSocketImpl.OPEN) {
            const time = now();
            if (time - lastResponse >= RESPONSE_TIMEOUT) {
                lastResponse = time;
                resetClock();
            }
            lastHeartbeat = time;
            send({type: 'ping', sentAt: Date.now()});
        } else if (socket?.readyState !== WebSocketImpl.CONNECTING) {
            retry();
        }
    }

    function join(roomId) {
        reactions.set(emptyReactions());
        state.update((current) => ({...current, selectedRoomId: roomId, joined: false, room: null, overlay: null}));
        try {
            windowTarget.localStorage.setItem(storageKey, roomId);
        } catch { /* Storage can be unavailable in private browsing. */
        }
        send({type: 'join', roomId});
    }

    function open() {
        if (stopped) return;
        reactions.set(emptyReactions());
        if (windowTarget.navigator.onLine === false) {
            state.update((current) => ({...current, status: 'offline', joined: false}));
            return;
        }
        const activeGeneration = ++generation;
        state.update((current) => ({...current, status: attempt ? 'reconnecting' : 'connecting', joined: false}));
        const {location} = windowTarget;
        try {
            socket = new WebSocketImpl(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
        } catch {
            reconnect();
            return;
        }
        connectionTimer = setTimeout(() => {
            if (generation === activeGeneration && !stopped) reconnect();
        }, CONNECTION_TIMEOUT);

        socket.onopen = () => {
            if (generation !== activeGeneration || stopped) return;
            clearTimeout(connectionTimer);
            cancelSessionCheck();
            lastResponse = lastHeartbeat = now();
            resetClock();
            state.update((current) => ({...current, status: 'connected'}));
            clearInterval(heartbeat);
            heartbeat = setInterval(beat, HEARTBEAT_INTERVAL);
            if (!send({type: 'ping', sentAt: Date.now()})) return;
            const roomId = get(state).selectedRoomId;
            if (roomId) send({type: 'join', roomId});
        };

        socket.onmessage = ({data}) => {
            if (generation !== activeGeneration || stopped) return;
            let message;
            try {
                message = JSON.parse(data);
            } catch {
                return;
            }
            if (!message || typeof message !== 'object') return;
            lastResponse = now();
            attempt = 0;
            if (message.type === 'pong') {
                const rtt = Date.now() - message.sentAt;
                if (!Number.isFinite(rtt) || rtt < 0 || rtt > 20000 || !Number.isFinite(message.serverTime)) return;
                samples.push({rtt, offset: message.serverTime - (message.sentAt + rtt / 2)});
                samples = samples.slice(-12);
                const best = samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
                state.update((current) => ({...current, clockOffset: best.offset, rtt, clockReady: true}));
            } else if (message.type === 'rooms') {
                state.update((current) => ({...current, rooms: message.rooms}));
                const selected = get(state).selectedRoomId;
                if (selected && !message.rooms.some((room) => room.id === selected)) {
                    reactions.set(emptyReactions());
                    state.update((current) => ({...current, selectedRoomId: null, room: null, joined: false}));
                }
            } else if (message.type === 'state') {
                state.update((current) => {
                    if (message.room.id !== current.selectedRoomId) return current;
                    if (current.joined && current.room?.version > message.room.version) return current;
                    return {
                        ...current, room: message.room, joined: true,
                        clockOffset: current.clockReady ? current.clockOffset : message.serverTime - Date.now(),
                    };
                });
            } else if (message.type === 'reactions:state' || message.type === 'reaction') {
                const current = get(state);
                if (!current.joined || message.roomId !== current.selectedRoomId) return;
                reactions.update(value => message.type === 'reactions:state'
                    ? {...value, roomId: message.roomId, ball: message.ball, serverTime: message.serverTime}
                    : {...value, roomId: message.roomId,
                        events: [...value.events.filter(event => event.serverTime > message.serverTime - 2000), message].slice(-40)});
            } else if (message.type === 'overlay') {
                state.update((current) => ({
                    ...current,
                    overlay: {message: message.message, expiresAt: message.expiresAt}
                }));
            } else if (message.type === 'session-ended') {
                disconnect();
                onSessionEnded();
            } else if (message.type === 'error' || message.type === 'notice') {
                onMessage(message.message, message.type);
            }
        };

        socket.onerror = () => {
            if (generation === activeGeneration && !stopped) reconnect();
        };
        socket.onclose = (event) => {
            if (generation !== activeGeneration || stopped) return;
            reconnect(event);
        };
    }

    function connect(userId) {
        disconnect();
        stopped = false;
        storageKey = `helltube:room:${userId}`;
        let selectedRoomId = null;
        try {
            selectedRoomId = windowTarget.localStorage.getItem(storageKey);
        } catch { /* Optional room preference. */
        }
        state.update((current) => ({
            ...current,
            selectedRoomId,
            room: null,
            rooms: [],
            clockReady: false,
            rtt: null,
            overlay: null
        }));
        samples = [];
        attempt = 0;
        windowTarget.addEventListener('offline', offline);
        windowTarget.addEventListener('online', wake);
        windowTarget.addEventListener('focus', wake);
        windowTarget.addEventListener('pageshow', wake);
        documentTarget.addEventListener('visibilitychange', wake);
        open();
    }

    function offline() {
        reactions.set(emptyReactions());
        closeSocket();
        cancelSessionCheck();
        state.update((current) => ({...current, status: 'offline', joined: false}));
    }

    function disconnect() {
        reactions.set(emptyReactions());
        stopped = true;
        windowTarget.removeEventListener('offline', offline);
        windowTarget.removeEventListener('online', wake);
        windowTarget.removeEventListener('focus', wake);
        windowTarget.removeEventListener('pageshow', wake);
        documentTarget.removeEventListener('visibilitychange', wake);
        closeSocket();
        cancelSessionCheck();
        state.update((current) => ({...current, status: 'offline', joined: false}));
    }

    function command(message) {
        const current = get(state);
        if (!current.joined || current.status !== 'connected' || !current.room) {
            onMessage('Waiting for a fresh room connection. Please try again when you’re connected.', 'error');
            return false;
        }
        return send(message.type === 'control'
            ? {...message, revision: current.room.playback.revision}
            : message);
    }

    function retry() {
        if (stopped) return;
        closeSocket();
        attempt = 0;
        open();
    }

    return {state, reactions, connect, disconnect, join, command, retry};
}
