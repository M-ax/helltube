import {randomUUID} from 'node:crypto';
import {httpError} from './config.js';
import {advanceBeachBall, bumpBeachBall, createBeachBall, BALL_WIDTH, BALL_HEIGHT} from '../shared/beach-ball.js';

export class Reactions {
    constructor({now = Date.now, broadcast}) {
        this.now = now;
        this.broadcast = broadcast;
        this.rooms = new Map();
    }

    snapshot(roomId) {
        return {type: 'reactions:state', roomId, ball: this.rooms.get(roomId)?.ball || null, serverTime: this.now()};
    }

    react(roomId, userId, message) {
        const {kind} = message;
        if (kind === 'beachball') {
            if (typeof message.enabled !== 'boolean') throw httpError(400, 'Choose whether to show the beach ball.');
            if (message.enabled && !this.rooms.has(roomId)) {
                this.rooms.set(roomId, {ball: createBeachBall(), pointers: new Map(), time: this.now()});
            } else if (!message.enabled) this.rooms.delete(roomId);
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

    pointer(roomId, clientId, message) {
        const state = this.rooms.get(roomId);
        if (message.x === null && message.y === null) {
            state?.pointers.delete(clientId);
            return;
        }
        if (![message.x, message.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1)) {
            throw httpError(400, 'Cursor position must be inside the player.');
        }
        if (!state) return;
        const now = this.now();
        const point = {x: message.x * BALL_WIDTH, y: message.y * BALL_HEIGHT, time: now};
        const previous = state.pointers.get(clientId);
        // Entering the player establishes a position; it must not sweep in from another screen.
        state.ball = bumpBeachBall(state.ball, previous || point, point, previous ? (now - previous.time) / 1000 : 0);
        state.pointers.set(clientId, point);
    }

    leave(roomId, clientId, empty = false) {
        if (empty) this.rooms.delete(roomId);
        else this.rooms.get(roomId)?.pointers.delete(clientId);
    }

    tick() {
        const now = this.now();
        for (const [roomId, state] of this.rooms) {
            state.ball = advanceBeachBall(state.ball, (now - state.time) / 1000);
            state.time = now;
            for (const [id, point] of state.pointers) {
                if (now - point.time > 1500) state.pointers.delete(id);
                else state.ball = bumpBeachBall(state.ball, point, point, 0.05);
            }
            this.broadcast(roomId, this.snapshot(roomId));
        }
    }
}
