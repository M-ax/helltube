import {randomUUID} from 'node:crypto';
import {httpError} from './config.js';
import {WHITEBOARD_TOOLS, SPRAY_TIPS, WHITEBOARD_COLORS, WHITEBOARD_WIDTHS, WHITEBOARD_BATCH,
    WHITEBOARD_MAX_POINTS, WHITEBOARD_MAX_SHAPES, WHITEBOARD_ROOM_POINTS,
    validWhiteboardPoint, whiteboardPoint} from '../shared/whiteboard.js';

export class Whiteboards {
    constructor({broadcast}) {
        this.broadcast = broadcast;
        this.rooms = new Map();
    }

    ensure(roomId) {
        if (!this.rooms.has(roomId)) this.rooms.set(roomId, {epoch: randomUUID(), revision: 0, shapes: new Map()});
        return this.rooms.get(roomId);
    }

    snapshot(roomId) {
        const state = this.ensure(roomId);
        return {type: 'whiteboard:state', roomId, epoch: state.epoch, revision: state.revision,
            shapes: [...state.shapes.values()]};
    }

    publish(roomId, state, event) {
        this.broadcast(roomId, {type: 'whiteboard:event', roomId, epoch: state.epoch,
            revision: ++state.revision, ...event});
    }

    // Bound both the snapshot size and rendering work, retaining the newest marks.
    makeSpace(state, points, adding = false) {
        let count = [...state.shapes.values()].reduce((sum, shape) => sum + shape.points.length, 0);
        const removed = [];
        for (const shape of state.shapes.values()) {
            if (count + points <= WHITEBOARD_ROOM_POINTS
                && state.shapes.size - removed.length + Number(adding) <= WHITEBOARD_MAX_SHAPES) break;
            if (!shape.complete) continue;
            count -= shape.points.length;
            removed.push(shape.id);
        }
        if (count + points > WHITEBOARD_ROOM_POINTS
            || state.shapes.size - removed.length + Number(adding) > WHITEBOARD_MAX_SHAPES) {
            throw httpError(409, 'The whiteboard is busy. Finish a drawing or erase a mark first.');
        }
        for (const id of removed) state.shapes.delete(id);
        return removed;
    }

    command(roomId, clientId, user, message) {
        // Queued input from a previous room must never modify the newly joined room.
        if (message.roomId !== roomId) throw httpError(409, 'The whiteboard room changed.');
        const state = this.ensure(roomId);
        if (message.epoch !== state.epoch) return false;
        const {action, id} = message;
        if (action === 'begin') {
            if (typeof id !== 'string' || !/^[\w-]{1,64}$/.test(id)
                || !WHITEBOARD_TOOLS.includes(message.tool) || !WHITEBOARD_COLORS.includes(message.color)
                || (message.tool === 'spray' && !SPRAY_TIPS.some(tip => tip.id === message.tip))
                || !WHITEBOARD_WIDTHS.includes(message.width) || !validWhiteboardPoint(message.point)) {
                throw httpError(400, 'Invalid whiteboard drawing.');
            }
            if (state.shapes.has(id) || [...state.shapes.values()].some(shape => shape.clientId === clientId && !shape.complete)) {
                throw httpError(409, 'Finish the current drawing first.');
            }
            const removed = this.makeSpace(state, 1, true);
            const shape = {id, clientId, userId: user.id, author: user.displayName || user.username,
                tool: message.tool, color: message.color, width: message.width,
                ...(message.tool === 'spray' ? {tip: message.tip} : {}),
                points: [whiteboardPoint(message.point)], complete: false};
            state.shapes.set(id, shape);
            this.publish(roomId, state, {action, shape, removed});
        } else if (action === 'draw' || action === 'end') {
            const shape = state.shapes.get(id);
            // Another participant may have erased this stroke while it was in flight.
            if (!shape) return false;
            if (shape.clientId !== clientId) throw httpError(403, 'Only the drawing author can extend a mark.');
            if (shape.complete) return true;
            if (action === 'end') {
                shape.complete = true;
                this.publish(roomId, state, {action, id});
                return true;
            }
            if (!Array.isArray(message.points) || !message.points.length || message.points.length > WHITEBOARD_BATCH
                || !message.points.every(validWhiteboardPoint)
                || (['pen', 'spray'].includes(shape.tool) && shape.points.length + message.points.length > WHITEBOARD_MAX_POINTS)) {
                throw httpError(400, 'Invalid whiteboard points.');
            }
            const points = message.points.map(whiteboardPoint);
            const extra = ['pen', 'spray'].includes(shape.tool) ? points.length : Number(shape.points.length === 1);
            const removed = this.makeSpace(state, extra);
            shape.points = ['pen', 'spray'].includes(shape.tool) ? [...shape.points, ...points] : [shape.points[0], points.at(-1)];
            this.publish(roomId, state, {action, id, points, removed});
        } else if (action === 'erase' || action === 'undo') {
            if (action === 'erase' && (!Array.isArray(message.ids) || message.ids.length > WHITEBOARD_BATCH
                || !message.ids.every(value => typeof value === 'string' && value.length <= 64))) {
                throw httpError(400, 'Invalid whiteboard eraser.');
            }
            const ids = action === 'undo'
                ? [[...state.shapes.values()].reverse().find(shape => shape.userId === user.id && shape.complete)?.id]
                : message.ids;
            const removed = ids.filter(value => state.shapes.delete(value));
            if (removed.length) this.publish(roomId, state, {action, removed});
        } else if (action === 'clear') {
            state.shapes.clear();
            state.epoch = randomUUID();
            state.revision = 0;
            this.broadcast(roomId, this.snapshot(roomId));
        } else throw httpError(400, 'Unknown whiteboard action.');
        return true;
    }

    leave(roomId, clientId, empty = false) {
        if (empty) { this.rooms.delete(roomId); return; }
        const state = this.rooms.get(roomId);
        if (!state) return;
        for (const shape of state.shapes.values()) {
            if (shape.clientId !== clientId || shape.complete) continue;
            shape.complete = true;
            this.publish(roomId, state, {action: 'end', id: shape.id});
        }
    }
}
