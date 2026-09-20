import {EventEmitter} from 'node:events';
import {WebSocket} from 'ws';

export function frontendOrigin(input) {
    let url;
    try { url = new URL(input); } catch { throw new Error('Enter a complete Helltube frontend URL.'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
        throw new Error('Use the frontend origin, for example https://helltube.example, without a path or credentials.');
    }
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
        throw new Error('Use HTTPS for remote Helltube servers. HTTP is supported on localhost.');
    }
    return url.origin;
}

export class CasterConnection extends EventEmitter {
    constructor({fetcher = fetch, Socket = WebSocket} = {}) {
        super(); Object.assign(this, {fetcher, Socket}); this.generation = 0;
    }
    async request(route, {body, cookie = this.cookie, origin = this.origin} = {}) {
        const response = await this.fetcher(`${origin}${route}`, {method: body ? 'POST' : 'GET',
            redirect: 'error', signal: AbortSignal.timeout(15000),
            headers: {Origin: origin, ...(cookie ? {Cookie: cookie} : {}), ...(body ? {'Content-Type': 'application/json'} : {})},
            ...(body ? {body: JSON.stringify(body)} : {})});
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const error = new Error(data.error || data.message || `Helltube returned HTTP ${response.status}.`);
            error.status = response.status; throw error;
        }
        return {response, data};
    }
    async login({url, username, password}) {
        const origin = frontendOrigin(url);
        if (typeof username !== 'string' || typeof password !== 'string' || !username.trim() || password.length > 128) {
            throw new Error('Enter your Helltube username and password.');
        }
        await this.logout();
        const generation = this.generation;
        const {response, data} = await this.request('/api/login', {origin, cookie: '', body: {username: username.trim(), password}});
        const cookie = response.headers.getSetCookie().find(value => /^session=[a-f0-9]{64};/i.test(value))?.split(';')[0];
        if (!cookie || !data.user) throw new Error('The frontend did not return a Helltube session.');
        if (generation !== this.generation) {
            await this.request('/api/logout', {origin, cookie, body: {}}).catch(() => {});
            throw new Error('Sign-in was cancelled.');
        }
        Object.assign(this, {origin, cookie, user: data.user, attempt: 0});
        this.connect();
        return {user: data.user, origin};
    }
    connect() {
        if (!this.cookie) return;
        const generation = this.generation;
        this.emit('event', {type: 'connection', status: 'connecting'});
        const socket = new this.Socket(this.origin.replace(/^http/, 'ws') + '/ws', {
            headers: {Origin: this.origin, Cookie: this.cookie}, handshakeTimeout: 15000, maxPayload: 1024 * 1024,
            followRedirects: false,
        });
        this.socket = socket;
        let lastMessage = Date.now();
        socket.on('open', () => {
            if (this.socket !== socket) return;
            this.attempt = 0;
            this.emit('event', {type: 'connection', status: 'connected'});
            this.heartbeat = setInterval(() => {
                if (Date.now() - lastMessage > 20000) socket.terminate();
                else this.send({type: 'ping', sentAt: Date.now()});
            }, 5000);
        });
        socket.on('message', bytes => {
            if (this.socket !== socket) return;
            lastMessage = Date.now();
            let message;
            try { message = JSON.parse(bytes.toString()); } catch { socket.terminate(); return; }
            this.emit('event', message);
            if (message.type === 'session-ended') this.disconnect();
        });
        socket.on('error', () => {}); // close handles failure without leaking URLs/cookies.
        socket.on('close', async () => {
            if (this.socket !== socket) return;
            clearInterval(this.heartbeat); this.socket = null;
            this.emit('event', {type: 'connection', status: 'disconnected'});
            try { await this.request('/api/me'); }
            catch (error) {
                if (generation !== this.generation) return;
                if ([401, 403].includes(error.status)) {
                    this.disconnect(); this.emit('event', {type: 'session-ended'}); return;
                }
            }
            if (generation === this.generation && this.cookie) {
                this.retry = setTimeout(() => this.connect(), Math.min(15000, 1000 * 2 ** this.attempt++));
            }
        });
    }
    send(message) {
        if (this.socket?.readyState !== WebSocket.OPEN) return false;
        const data = JSON.stringify(message);
        if (data.length > 65536 || this.socket.bufferedAmount > 262144) return false;
        this.socket.send(data); return true;
    }
    disconnect() {
        this.generation++;
        clearTimeout(this.retry); clearInterval(this.heartbeat);
        const socket = this.socket; this.socket = null;
        socket?.terminate(); this.cookie = null; this.user = null;
        this.emit('event', {type: 'connection', status: 'disconnected'});
    }
    async logout() {
        const cookie = this.cookie, origin = this.origin;
        this.disconnect();
        if (cookie) await this.request('/api/logout', {origin, cookie, body: {}}).catch(() => {});
    }
}
