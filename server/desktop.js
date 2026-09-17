import { PassThrough } from 'node:stream';
import { makeItem } from './rooms.js';
import { httpError } from './config.js';

const MAX_PENDING_BYTES = 4 * 1024 * 1024;
const MAX_SHARE_MS = 4 * 60 * 60 * 1000;

// Capture belongs to a particular connection, not just an account. Reconnecting
// must never silently resume access to somebody's screen.
export class DesktopShares {
  constructor(rooms, media, send, now = Date.now) {
    Object.assign(this, { rooms, media, send, now });
    this.sessions = new Map();
    rooms.on('state', room => {
      for (const session of this.sessions.values()) {
        if (session.room !== room) continue;
        if (room.current?.id !== session.item.id) this.stop(session.ws);
        else if (session.item.status === 'error') this.stop(session.ws, session.item.error);
      }
    });
    rooms.on('deleted', room => {
      for (const session of this.sessions.values()) if (session.room === room) this.stop(session.ws);
    });
  }

  start(room, ws, user, message) {
    if (typeof message.requestId !== 'string' || !/^[\w-]{1,80}$/.test(message.requestId)) throw httpError(400, 'Invalid sharing request.');
    if (!['video/webm;codecs=vp8,opus', 'video/webm;codecs=vp8'].includes(message.mimeType)) {
      throw httpError(400, 'Desktop sharing requires WebM video.');
    }
    if (this.sessions.has(ws.id) || room.current?.kind === 'desktop') {
      throw httpError(409, 'A desktop is already being shared. Stop it before starting another.');
    }
    if ([...this.media.jobs.values()].filter(job => !job.done).length >= this.media.config.maxTranscoders) {
      throw httpError(409, 'All video converters are busy. Try desktop sharing again shortly.');
    }
    if (room.current && room.queue.length >= this.rooms.maxQueue) throw httpError(409, 'The room queue is full.');
    const item = makeItem({kind: 'desktop'}, {
      title: `${user.displayName}’s desktop`, addedBy: user.displayName, sharedBy: user.id,
    });
    const input = new PassThrough();
    const session = {room, ws, item, input, requestId: message.requestId, started: this.now(), lastData: this.now()};
    this.sessions.set(ws.id, session);
    if (room.current) {
      room.current.resumeAt = this.rooms.position(room);
      room.queue.unshift(room.current);
    }
    room.current = item;
    room.resumeWhenReady = true;
    this.rooms.stamp(room, 0, true);
    this.media.start(item, 0, input);
    this.rooms.changed(room);
    this.rooms.emit('rooms');
    this.send(ws, {type: 'desktop:started', requestId: session.requestId, itemId: item.id, roomId: room.id});
  }

  write(ws, bytes) {
    const session = this.sessions.get(ws.id);
    if (!session) throw httpError(409, 'Start desktop sharing before sending video.');
    if (session.input.destroyed || session.input.readableLength + session.input.writableLength + bytes.length > MAX_PENDING_BYTES) {
      this.stop(ws, 'Desktop sharing stopped because the server could not keep up. Please try again.');
      return;
    }
    session.lastData = this.now();
    session.input.write(bytes);
  }

  stop(ws, error = '') {
    const session = this.sessions.get(ws.id);
    if (!session) return;
    this.sessions.delete(ws.id);
    session.input.destroy();
    const job = this.media.jobs.get(session.item.id);
    if (job) this.media.dispose(job);
    this.send(ws, {type: 'desktop:stopped', requestId: session.requestId, itemId: session.item.id, message: error});
    if (this.rooms.rooms.has(session.room.id) && session.room.current?.id === session.item.id) {
      this.rooms.advance(session.room);
    }
  }

  tick() {
    for (const session of this.sessions.values()) {
      if (this.now() - session.lastData > 20000) this.stop(session.ws, 'Desktop sharing stopped because the capture connection stalled.');
      else if (this.now() - session.started > MAX_SHARE_MS) this.stop(session.ws, 'The four-hour sharing limit was reached. Start a new share to continue.');
    }
  }
}
