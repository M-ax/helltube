import {randomUUID} from 'node:crypto';
import {mkdir, open, rm, readdir, lstat} from 'node:fs/promises';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {httpError} from './config.js';
import {chunkSize} from './uploads.js';

export class RoomFiles {
  constructor(config, rooms, store, uploads) {
    Object.assign(this, {config, rooms, store, uploads});
    this.dir = path.join(config.dataDir, 'room-files');
    this.files = new Map();
    this.pending = new Set();
    this.now = config.now || Date.now;
    this.broadcast = () => {};
    uploads.otherReservations = () => [...this.files.values()];
  }

  diskPath(id) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid stored file ID.');
    return path.join(this.dir, id);
  }

  async init() {
    await mkdir(this.dir, {recursive: true});
    for (const saved of this.store.load('room-files')) {
      const info = await lstat(this.diskPath(saved.id)).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!this.rooms.rooms.has(saved.roomId) || !info?.isFile() || info.isSymbolicLink() ||
          !Number.isSafeInteger(saved.size) || !Number.isSafeInteger(saved.received) ||
          saved.received < 0 || saved.received > saved.size || info.size < saved.received) {
        this.store.delete('room-files', saved.id);
        continue;
      }
      // Discard bytes written before a crash but never committed to SQLite.
      if (info.size !== saved.received) {
        const handle = await open(this.diskPath(saved.id), 'r+');
        try { await handle.truncate(saved.received); } finally { await handle.close(); }
      }
      this.files.set(saved.id, {...saved, complete: saved.received === saved.size});
    }
    await this.cleanup();
    for (const entry of await readdir(this.dir)) {
      if (/^[a-f0-9-]{36}$/.test(entry) && !this.files.has(entry)) await rm(this.diskPath(entry), {force: true});
    }
  }

  publicFile(file) {
    const {id, roomId, userId, addedBy, name, size, received, complete, createdAt, lastModified} = file;
    return {id, roomId, userId, addedBy, name, size, received, complete, createdAt, lastModified};
  }

  snapshot(roomId) {
    return {type: 'files:state', roomId, files: [...this.files.values()]
      .filter(file => file.roomId === roomId && !file.creating && !file.cancelled)
      .sort((a, b) => b.createdAt - a.createdAt).map(file => this.publicFile(file))};
  }

  changed(roomId) { this.broadcast(roomId, this.snapshot(roomId)); }

  persist(file) {
    this.store.save('room-files', file.id, {...this.publicFile(file), lastProgressAt: file.lastProgressAt});
  }

  get(id) {
    const file = this.files.get(id);
    if (!file || file.creating || file.cancelled) throw httpError(404, 'Shared file no longer exists.');
    return file;
  }

  async create(room, user, body, authorize) {
    const name = body.name;
    if (typeof name !== 'string' || !name.trim() || name.length > 200) throw httpError(400, 'Filename must be between 1 and 200 characters.');
    if (/[\\/\x00-\x1f\x7f]/.test(name) || ['.', '..'].includes(name)) throw httpError(400, 'Invalid filename.');
    if (!Number.isSafeInteger(body.size) || body.size < 0 || body.size > this.config.maxUploadBytes) {
      throw httpError(400, `File size must be between 0 and ${this.config.maxUploadBytes} bytes.`);
    }
    if (body.lastModified != null && (!Number.isSafeInteger(body.lastModified) || body.lastModified < 0)) {
      throw httpError(400, 'Invalid file modification time.');
    }
    const reservations = [...this.uploads.uploads.values(), ...this.files.values()];
    const own = reservations.filter(file => file.userId === user.id);
    if (own.length >= this.config.maxUserUploads ||
        own.reduce((sum, file) => sum + file.size, body.size) > this.config.maxUserStorageBytes) {
      throw httpError(409, 'Your upload storage limit is full. Remove unneeded files or uploads.');
    }
    if (reservations.length >= this.config.maxUploads ||
        reservations.reduce((sum, file) => sum + file.size, body.size) > this.config.maxStorageBytes) {
      throw httpError(507, 'Shared storage is full. Remove unneeded files or uploads.');
    }
    const file = {id: randomUUID(), roomId: room.id, userId: user.id, addedBy: user.displayName,
      name, size: body.size, lastModified: body.lastModified ?? null, received: 0, complete: body.size === 0,
      createdAt: this.now(), lastProgressAt: this.now(), creating: true, busy: true};
    this.files.set(file.id, file); // Reserve storage before yielding.
    try {
      const handle = await open(this.diskPath(file.id), 'wx');
      await handle.close();
      authorize();
      if (file.cancelled || this.rooms.rooms.get(room.id) !== room) throw httpError(404, 'Room no longer exists.');
      this.persist(file);
      file.creating = false;
      this.changed(room.id);
      return {...this.publicFile(file), chunkSize};
    } catch (error) {
      this.files.delete(file.id);
      await rm(this.diskPath(file.id), {force: true});
      throw error;
    } finally { file.busy = false; }
  }

  async append(file, offset, bytes, authorize) {
    if (file.busy) throw httpError(409, 'Only one file chunk may be in flight.');
    if (!Number.isSafeInteger(offset) || offset !== file.received) throw httpError(409, 'File offset mismatch; check status to resume.');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > chunkSize || offset + bytes.length > file.size) {
      throw httpError(400, 'Invalid file chunk size.');
    }
    file.busy = true;
    try {
      const handle = await open(this.diskPath(file.id), 'r+');
      try {
        authorize();
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('Unable to write file chunk.');
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      authorize();
      if (file.cancelled) throw httpError(404, 'Shared file no longer exists.');
      const next = {...file, received: offset + bytes.length, complete: offset + bytes.length === file.size, lastProgressAt: this.now()};
      this.persist(next);
      Object.assign(file, next);
      if (file.complete || this.now() - (file.lastBroadcastAt || 0) >= 1000) {
        file.lastBroadcastAt = this.now();
        this.changed(file.roomId);
      }
    } finally { file.busy = false; }
  }

  async discard(file) {
    if (file.cancelled) return file.removal;
    this.store.delete('room-files', file.id);
    file.cancelled = true;
    // Keep the reservation until its bytes have actually been removed.
    file.removal = (async () => {
      while (file.busy) await sleep(20);
      await rm(this.diskPath(file.id), {force: true, maxRetries: 10, retryDelay: 100});
      this.files.delete(file.id);
      this.changed(file.roomId);
    })();
    this.pending.add(file.removal);
    try { await file.removal; } finally { this.pending.delete(file.removal); }
  }

  async removeRoom(roomId) {
    await Promise.all([...this.files.values()].filter(file => file.roomId === roomId).map(file => this.discard(file)));
  }

  async cleanup() {
    await Promise.all([...this.files.values()].filter(file => !file.busy && !file.creating &&
      (!this.rooms.rooms.has(file.roomId) || (!file.complete && this.now() - file.lastProgressAt >= this.config.uploadIdleTimeoutMs)))
      .map(file => this.discard(file)));
  }

  async close() {
    for (const file of this.files.values()) while (file.busy) await sleep(20);
    await Promise.all(this.pending);
  }
}
