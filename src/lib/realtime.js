import {get, writable} from 'svelte/store';
import {api} from './api.js';

export function createRealtime({onMessage, onSessionEnded}) {
    const state = writable({
        status: 'offline', rooms: [], room: null, selectedRoomId: null,
        joined: false, clockOffset: 0, rtt: null, clockReady: false, overlay: null,
    });
    let socket;
    let stopped = true;
    let retryTimer;
    let heartbeat;
    let attempt = 0;
    let generation = 0;
    let lastResponse = 0;
    let storageKey;
    let samples = [];

    function send(message) {
        if (!socket || socket.readyState !== WebSocket.OPEN) return false;
        socket.send(JSON.stringify(message));
        return true;
    }

    function join(roomId) {
        state.update((current) => ({...current, selectedRoomId: roomId, joined: false, room: null, overlay: null}));
        try {
            localStorage.setItem(storageKey, roomId);
        } catch { /* Storage can be unavailable in private browsing. */
        }
        send({type: 'join', roomId});
    }

    function open() {
        if (stopped) return;
        if (navigator.onLine === false) {
            state.update((current) => ({...current, status: 'offline', joined: false}));
            return;
        }
        const activeGeneration = ++generation;
        state.update((current) => ({...current, status: attempt ? 'reconnecting' : 'connecting', joined: false}));
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
        const currentSocket = socket;

        socket.onopen = () => {
            if (generation !== activeGeneration || stopped) return;
            attempt = 0;
            lastResponse = Date.now();
            state.update((current) => ({...current, status: 'connected'}));
            send({type: 'ping', sentAt: Date.now()});
            const roomId = get(state).selectedRoomId;
            if (roomId) send({type: 'join', roomId});
            clearInterval(heartbeat);
            heartbeat = setInterval(() => {
                if (Date.now() - lastResponse > 5000) currentSocket.close();
                else send({type: 'ping', sentAt: Date.now()});
            }, 1500);
        };

        socket.onmessage = ({data}) => {
            if (generation !== activeGeneration || stopped) return;
            let message;
            try {
                message = JSON.parse(data);
            } catch {
                return;
            }
            lastResponse = Date.now();
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

        socket.onerror = () => currentSocket.close();
        socket.onclose = (event) => {
            if (generation !== activeGeneration || stopped) return;
            clearInterval(heartbeat);
            if ([1008, 4001, 4401].includes(event.code)) {
                disconnect();
                onSessionEnded();
                return;
            }
            state.update((current) => ({...current, status: 'reconnecting', joined: false}));
            void api('/api/me').catch((error) => {
                if (error.status === 401 && generation === activeGeneration && !stopped) {
                    disconnect();
                    onSessionEnded();
                }
            });
            const delay = Math.min(15000, 750 * 2 ** attempt++) + Math.random() * 350;
            retryTimer = setTimeout(open, delay);
        };
    }

    function connect(userId) {
        disconnect();
        stopped = false;
        storageKey = `helltube:room:${userId}`;
        let selectedRoomId = null;
        try {
            selectedRoomId = localStorage.getItem(storageKey);
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
        window.addEventListener('offline', offline);
        window.addEventListener('online', retry);
        open();
    }

    function offline() {
        generation++;
        clearTimeout(retryTimer);
        clearInterval(heartbeat);
        socket?.close();
        socket = null;
        state.update((current) => ({...current, status: 'offline', joined: false}));
    }

    function disconnect() {
        stopped = true;
        window.removeEventListener('offline', offline);
        window.removeEventListener('online', retry);
        generation++;
        clearTimeout(retryTimer);
        clearInterval(heartbeat);
        socket?.close();
        socket = null;
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
        generation++;
        socket?.close();
        clearTimeout(retryTimer);
        clearInterval(heartbeat);
        attempt = 0;
        open();
    }

    return {state, connect, disconnect, join, command, retry};
}