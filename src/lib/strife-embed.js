import {writable} from 'svelte/store';

const channel = 'helltube.strife';
const validId = value => typeof value === 'string' && /^[\w-]{1,128}$/.test(value);

export function embedConfiguration(location) {
    try {
        const args = new URLSearchParams(location.hash.slice(1));
        const parent = new URL(args.get('parent'));
        const session = args.get('session');
        if (parent.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parent.hostname) ||
            !parent.port || parent.href !== parent.origin + '/' || !validId(session)) return null;
        return {parent: parent.origin, session};
    } catch { return null; }
}

// This channel controls Helltube only. It never receives Strife's native capability.
export function createStrifeEmbed({enabled, request, join, playback, windowTarget = window}) {
    const config = enabled && windowTarget.parent !== windowTarget && embedConfiguration(windowTarget.location);
    const state = writable({nativeShare: false, status: 'idle', error: ''});
    let context = {userId: null, room: null, rooms: [], connected: false, playback: {volume: .8, muted: false}};
    let serialized = '', generation = 0, connected = false, nativeShare = false, status = 'idle', connection = null;
    let share = null, credential = null, disposed = false;
    const handled = new Set();
    const send = (type, data = {}) => {
        if (config && !disposed) windowTarget.parent.postMessage({channel, version: 1, session: config.session, connection, type, ...data}, config.parent);
    };
    const update = (error = '') => state.set({nativeShare, status, error});
    async function revoke(value) {
        if (value?.token) await request(`/api/rooms/${encodeURIComponent(value.roomId)}/strife-token`,
            {method: 'DELETE', body: {token: value.token}, keepalive: true}).catch(() => {});
    }
    function cancel() {
        share = null;
        const old = credential; credential = null;
        void revoke(old);
        status = 'idle'; update();
    }
    function setContext(value) {
        const identity = current => [current.userId, current.room?.id, current.connected, current.room?.automated].join(':');
        if (identity(value) !== identity(context)) { generation++; cancel(); }
        context = value;
        const next = JSON.stringify(value);
        if (serialized !== next) { serialized = next; if (connected) send('state', {context, generation}); }
    }
    function start() {
        if (!nativeShare || !context.connected || !context.room || context.room.automated || share) return;
        share = {id: crypto.randomUUID(), roomId: context.room.id, generation};
        status = 'choosing'; update();
        send('share-request', {share: {...share}, context});
    }
    function stop() {
        if (share) send('stop-request', {shareId: share.id});
        cancel();
    }
    async function receive(event) {
        const m = event.data;
        if (!config || event.source !== windowTarget.parent || event.origin !== config.parent || !m ||
            m.channel !== channel || m.version !== 1 || m.session !== config.session) return;
        if (m.type === 'hello' && validId(m.connection)) {
            if (connection !== m.connection) { cancel(); handled.clear(); }
            connection = m.connection;
            connected = true; nativeShare = m.nativeShare === true; update();
            send('ready'); send('state', {context, generation}); return;
        }
        if (!connected || m.connection !== connection) return;
        if (m.type === 'share-status' && m.shareId === share?.id &&
            ['idle', 'choosing', 'starting', 'streaming', 'error'].includes(m.status)) {
            if (['idle', 'error'].includes(m.status)) cancel();
            else status = m.status;
            update(typeof m.error === 'string' ? m.error.slice(0, 300) : ''); return;
        }
        if (m.type !== 'command' || !validId(m.id) || handled.has(m.id) || handled.size >= 10000) return;
        handled.add(m.id);
        try {
            let result = {};
            if (m.action === 'selectRoom' && context.userId && context.rooms.some(r => r.id === m.roomId)) join(m.roomId);
            else if (m.action === 'playback' && context.userId && typeof m.muted === 'boolean' &&
                Number.isFinite(m.volume) && m.volume >= 0 && m.volume <= 1) playback({volume: m.volume, muted: m.muted});
            else if (m.action === 'share') start();
            else if (m.action === 'credential' && share?.id === m.shareId && share.generation === generation && context.connected && !credential) {
                const pending = share;
                // Mark before awaiting: repeated requests must not replace a live credential.
                credential = {pending: true};
                let issued;
                try { issued = await request(`/api/rooms/${encodeURIComponent(pending.roomId)}/strife-token`, {method: 'POST'}); }
                catch (error) { if (share === pending) credential = null; throw error; }
                const value = {...issued, roomId: pending.roomId};
                if (share !== pending || disposed) { await revoke(value); throw new Error('The selected room changed.'); }
                credential = value;
                result = {credential: value};
            } else throw new Error('This action is unavailable in the current room.');
            send('result', {id: m.id, ok: true, ...result});
        } catch (error) { send('result', {id: m.id, ok: false, error: error.message}); }
    }
    if (config) {
        windowTarget.addEventListener('message', receive);
        windowTarget.addEventListener('pagehide', stop);
    }
    return {state, setContext, start, stop,
        dispose() { cancel(); disposed = true; windowTarget.removeEventListener('message', receive); windowTarget.removeEventListener('pagehide', stop); },
    };
}
