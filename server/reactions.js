import {randomUUID} from 'node:crypto';
import {httpError} from './config.js';
import {advanceBeachBall, bumpBeachBall, createBeachBall, BALL_WIDTH, BALL_HEIGHT} from '../shared/beach-ball.js';
import {FINGER_TAP_IMPACT_MS, POINTER_TIMEOUT_MS, validFinger} from '../shared/reaction-pointer.js';
import {FingerStatic, STATIC_RECOVERY_MS} from './finger-static.js';

export class Reactions {
    constructor({now = Date.now, broadcast}) {
        this.now = now;
        this.broadcast = broadcast;
        this.rooms = new Map();
        this.staticSurfaces = new Map();
    }

    snapshot(roomId) {
        const state = this.rooms.get(roomId);
        return {type: 'reactions:state', roomId, ball: state?.ball || null,
            fingers: [...(state?.fingers.values() || [])], serverTime: this.now()};
    }

    ensureRoom(roomId) {
        if (!this.rooms.has(roomId)) this.rooms.set(roomId, {ball: null, pointers: new Map(), fingers: new Map(), time: this.now()});
        return this.rooms.get(roomId);
    }

    react(roomId, userId, message) {
        const {kind} = message;
        if (kind === 'beachball') {
            if (typeof message.enabled !== 'boolean') throw httpError(400, 'Choose whether to show the beach ball.');
            if (message.enabled) {
                const state = this.ensureRoom(roomId);
                state.ball ||= createBeachBall();
            } else {
                const state = this.rooms.get(roomId);
                if (state) { state.ball = null; state.pointers.clear(); }
                if (!state?.fingers.size) this.rooms.delete(roomId);
            }
            this.broadcast(roomId, this.snapshot(roomId));
            return;
        }
        if (!['hitmarker', 'metalpipe', 'flashbang', 'biden', 'heart', 'laugh', 'clap'].includes(kind)) throw httpError(400, 'Unknown reaction.');
        if (![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
            throw httpError(400, 'Reaction position must be inside the player.');
        }
        this.broadcast(roomId, {type: 'reaction', roomId, id: randomUUID(), userId, kind,
            x: message.x, y: message.y, serverTime: this.now()});
    }

    pointer(roomId, clientId, message, userId) {
        const absent = message.x === null && message.y === null;
        if (!absent && ![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
            throw httpError(400, 'Cursor position must be inside the player.');
        }
        if (message.finger != null && !validFinger(message.finger)) throw httpError(400, 'Invalid pointing finger.');
        const state = message.finger ? this.ensureRoom(roomId) : this.rooms.get(roomId);
        if (!state) return;
        const now = this.now();
        const previousFinger = state.fingers.get(clientId);
        if (message.finger) {
            const {x, y, pressed, taps} = message.finger;
            const pivot = previousFinger?.pivot || {...message.finger.pivot};
            const count = Math.max(previousFinger?.taps || 0, taps);
            const tapTime = count > (previousFinger?.taps || 0) ? now : previousFinger?.tapTime ?? null;
            state.fingers.set(clientId, {clientId, userId, x, y, pivot, pressed, taps: count, tapTime, time: now});
            if (count > (previousFinger?.taps || 0)) {
                this.broadcast(roomId, {type: 'reaction', roomId, id: randomUUID(), clientId, userId,
                    kind: 'fingertap', x, y, serverTime: now});
            }
            if (pressed && previousFinger?.pressed && now - previousFinger.time < POINTER_TIMEOUT_MS
                && (tapTime === null || now - tapTime >= FINGER_TAP_IMPACT_MS)
                && (x !== previousFinger.x || y !== previousFinger.y)) {
                let surface = this.staticSurfaces.get(roomId);
                if (!surface) { surface = new FingerStatic(); this.staticSurfaces.set(roomId, surface); }
                const discharged = surface.rub(previousFinger, {x, y}, now);
                // Bundle every crossed patch into this cursor tick, preserving their order without extra messages.
                const sweep = Math.min(.04, Math.max(0, now - previousFinger.time) / 1000);
                if (discharged.length) this.broadcast(roomId, {type: 'reaction', roomId, id: randomUUID(), clientId, userId,
                    kind: 'fingerstatic', x, y, clusters: discharged.map(({strength, fraction}) => ({strength, offset: fraction * sweep})),
                    serverTime: now});
            }
        } else state.fingers.delete(clientId);
        if (absent || !state.ball) state.pointers.delete(clientId);
        else {
            const point = {x: message.x * BALL_WIDTH, y: message.y * BALL_HEIGHT, time: now};
            const previous = state.pointers.get(clientId);
            // Entering the player establishes a position; it must not sweep in from another screen.
            state.ball = bumpBeachBall(state.ball, previous || point, point, previous ? (now - previous.time) / 1000 : 0);
            state.pointers.set(clientId, point);
        }
        if (previousFinger && !message.finger) this.broadcast(roomId, this.snapshot(roomId));
        if (!state.ball && !state.fingers.size) this.rooms.delete(roomId);
    }

    leave(roomId, clientId, empty = false) {
        if (empty) { this.rooms.delete(roomId); this.staticSurfaces.delete(roomId); }
        else {
            const state = this.rooms.get(roomId);
            state?.pointers.delete(clientId);
            if (state?.fingers.delete(clientId)) this.broadcast(roomId, this.snapshot(roomId));
            if (state && !state.ball && !state.fingers.size) this.rooms.delete(roomId);
        }
    }

    tick() {
        const now = this.now();
        for (const [roomId, surface] of this.staticSurfaces) {
            if (now - surface.lastRub >= STATIC_RECOVERY_MS) this.staticSurfaces.delete(roomId);
        }
        for (const [roomId, state] of this.rooms) {
            if (state.ball) state.ball = advanceBeachBall(state.ball, (now - state.time) / 1000);
            state.time = now;
            for (const [id, point] of state.pointers) {
                if (now - point.time > POINTER_TIMEOUT_MS) state.pointers.delete(id);
                else if (state.ball) state.ball = bumpBeachBall(state.ball, point, point, 1 / 60);
            }
            for (const [id, finger] of state.fingers) if (now - finger.time > POINTER_TIMEOUT_MS) state.fingers.delete(id);
            this.broadcast(roomId, this.snapshot(roomId));
            if (!state.ball && !state.fingers.size) this.rooms.delete(roomId);
        }
    }
}
