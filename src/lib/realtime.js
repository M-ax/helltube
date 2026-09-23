import {get, writable} from 'svelte/store';
import {api} from './api.js';
import {emptyWhiteboard, reduceWhiteboard} from '../../shared/whiteboard.js';
import {closeDetails, diagnosticText, MAX_DISCONNECT_REPORTS} from '../../shared/connection-diagnostics.js';

const HEARTBEAT_INTERVAL = 1500;
const RESPONSE_TIMEOUT = 15000;
const CONNECTION_TIMEOUT = 15000;
const SESSION_CHECK_TIMEOUT = 10000;
const REPORT_RETRY_INTERVAL = 60000;

export function createRealtime({onMessage, onSessionEnded, windowTarget = window, documentTarget = document,
    WebSocketImpl = WebSocket, now = () => performance.now(), request = api}) {
    const emptyReactions = () => ({roomId: null, clientId: null, ball: null, fingers: [], serverTime: 0, events: []});
    const reactions = writable(emptyReactions());
    const whiteboard = writable(emptyWhiteboard());
    const sharedFiles = writable(null);
    const desktopMessages = writable(null);
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
    let connection;
    let reports = [];
    let reportSequence = 0;
    let lastReportSend = 0;
    const reportPrefix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

    function recordFailure(cause, {event, error} = {}) {
        if (connection?.report) return connection.report;
        const report = {
            id: `${reportPrefix}-${++reportSequence}`, cause, at: Date.now(),
            connectionId: connection?.id || null, roomId: get(state).selectedRoomId,
            connectionAgeMs: connection ? Math.max(0, Math.round(now() - connection.startedAt)) : null,
            lastResponseAgeMs: connection?.opened ? Math.max(0, Math.round(now() - lastResponse)) : null,
            attempt, droppedReports: 0, readyState: socket?.readyState ?? null,
            online: typeof windowTarget.navigator.onLine === 'boolean' ? windowTarget.navigator.onLine : null,
            visibility: documentTarget.visibilityState || 'unknown',
            ...closeDetails(event),
            error: diagnosticText(error?.message || (cause === 'socket-error'
                ? 'WebSocket error; browser did not expose further details.' : '')),
        };
        if (connection) connection.report = report;
        if (reports.length >= MAX_DISCONNECT_REPORTS) {
            // Retain the original failure and the most recent attempts.
            const removed = reports.splice(1, 1)[0];
            report.droppedReports = removed.droppedReports + 1;
        }
        reports.push(report);
        return report;
    }

    function sendReports() {
        lastReportSend = now();
        // A successful send is not delivery: keep each report until acknowledged.
        for (const report of [...reports]) {
            if (!send({type: 'client:disconnect', report})) return false;
        }
        return true;
    }

    function send(message) {
        if (!socket || socket.readyState !== WebSocketImpl.OPEN) return false;
        try {
            socket.send(JSON.stringify(message));
            return true;
        } catch (error) {
            reconnect('send-error', {error});
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
        connection = null;
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

    function reconnect(cause, details = {}) {
        if (stopped) return;
        recordFailure(cause, details);
        // Retire the socket immediately: a broken transport may never deliver close.
        closeSocket();
        if ([1008, 4001, 4401].includes(details.event?.code)) {
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
        whiteboard.set(emptyWhiteboard());
        sharedFiles.set(null);
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
        if (time - lastResponse >= RESPONSE_TIMEOUT) reconnect('response-timeout');
        else if (send({type: 'ping', sentAt: Date.now()}) && time - lastReportSend >= REPORT_RETRY_INTERVAL) sendReports();
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
        whiteboard.set(emptyWhiteboard());
        sharedFiles.set(null);
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
        whiteboard.set(emptyWhiteboard());
        sharedFiles.set(null);
        if (windowTarget.navigator.onLine === false) {
            state.update((current) => ({...current, status: 'offline', joined: false}));
            return;
        }
        const activeGeneration = ++generation;
        const activeConnection = connection = {id: null, startedAt: now(), opened: false, report: null};
        state.update((current) => ({...current, status: attempt ? 'reconnecting' : 'connecting', joined: false}));
        const {location} = windowTarget;
        try {
            socket = new WebSocketImpl(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
        } catch (error) {
            reconnect('connection-error', {error});
            return;
        }
        connectionTimer = setTimeout(() => {
            if (generation === activeGeneration && !stopped) reconnect('connection-timeout');
        }, CONNECTION_TIMEOUT);

        socket.onopen = () => {
            if (generation !== activeGeneration || stopped) return;
            clearTimeout(connectionTimer);
            cancelSessionCheck();
            lastResponse = lastHeartbeat = now();
            activeConnection.opened = true;
            resetClock();
            state.update((current) => ({...current, status: 'connected'}));
            clearInterval(heartbeat);
            heartbeat = setInterval(beat, HEARTBEAT_INTERVAL);
            if (!send({type: 'ping', sentAt: Date.now()})) return;
            if (!sendReports()) return;
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
            if (message.type === 'client:disconnect:ack') {
                reports = reports.filter(report => report.id !== message.id);
            } else if (message.type?.startsWith('desktop:')) {
                desktopMessages.set(message);
            } else if (message.type === 'pong') {
                const rtt = Date.now() - message.sentAt;
                if (!Number.isFinite(rtt) || rtt < 0 || rtt > 20000 || !Number.isFinite(message.serverTime)) return;
                samples.push({rtt, offset: message.serverTime - (message.sentAt + rtt / 2)});
                samples = samples.slice(-12);
                const best = samples.reduce((a, b) => a.rtt < b.rtt ? a : b);
                state.update((current) => ({...current, clockOffset: best.offset, rtt, clockReady: true}));
            } else if (message.type === 'rooms') {
                if (typeof message.clientId === 'string') activeConnection.id = message.clientId;
                state.update((current) => ({...current, rooms: message.rooms}));
                const selected = get(state).selectedRoomId;
                if (selected && !message.rooms.some((room) => room.id === selected)) {
                    reactions.set(emptyReactions());
                    whiteboard.set(emptyWhiteboard());
                    sharedFiles.set(null);
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
            } else if (message.type === 'files:state') {
                const current = get(state);
                if (current.joined && message.roomId === current.selectedRoomId) sharedFiles.set(message);
            } else if (message.type === 'reactions:state' || message.type === 'reaction') {
                const current = get(state);
                if (!current.joined || message.roomId !== current.selectedRoomId) return;
                reactions.update(value => message.type === 'reactions:state'
                    ? {...value, roomId: message.roomId, clientId: message.clientId || value.clientId,
                        ball: message.ball, fingers: message.fingers || [], serverTime: message.serverTime}
                    : {...value, roomId: message.roomId,
                        events: [...value.events.filter(event => event.serverTime > message.serverTime - 2000), message].slice(-40)});
            } else if (['whiteboard:state', 'whiteboard:event', 'whiteboard:error'].includes(message.type)) {
                const current = get(state);
                if (!current.joined || message.roomId !== current.selectedRoomId) return;
                whiteboard.update(value => reduceWhiteboard(value, message));
                if (message.type === 'whiteboard:error') onMessage(message.message, 'error');
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

        socket.onerror = (event) => {
            if (generation === activeGeneration && !stopped) reconnect('socket-error', {error: event?.error || event});
        };
        socket.onclose = (event) => {
            // Browsers usually emit error then close. Enrich that queued report
            // even though this socket has already been retired for recovery.
            if (activeConnection.report) Object.assign(activeConnection.report, closeDetails(event));
            if (generation !== activeGeneration || stopped) return;
            reconnect('socket-close', {event});
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
        if (socket && !stopped) recordFailure('browser-offline');
        reactions.set(emptyReactions());
        whiteboard.set(emptyWhiteboard());
        sharedFiles.set(null);
        closeSocket();
        cancelSessionCheck();
        state.update((current) => ({...current, status: 'offline', joined: false}));
    }

    function disconnect() {
        reactions.set(emptyReactions());
        whiteboard.set(emptyWhiteboard());
        sharedFiles.set(null);
        stopped = true;
        windowTarget.removeEventListener('offline', offline);
        windowTarget.removeEventListener('online', wake);
        windowTarget.removeEventListener('focus', wake);
        windowTarget.removeEventListener('pageshow', wake);
        documentTarget.removeEventListener('visibilitychange', wake);
        closeSocket();
        cancelSessionCheck();
        reports = [];
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
        if (socket) recordFailure('manual-retry');
        closeSocket();
        attempt = 0;
        open();
    }

    return {state, reactions, whiteboard, sharedFiles, desktopMessages, connect, disconnect, join, command, retry};
}
