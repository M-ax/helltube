import { randomUUID, randomBytes } from 'node:crypto';
import { mkdir, open, rm, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { httpError, text } from './config.js';
import { makeItem } from './rooms.js';
import { inferPlaylistTitle } from './upload-playlist.js';

export const chunkSize = 512 * 1024;

export function uploadHealth({ size, duration, received, position, transferBytes, transferMs, samples, ready, complete }) {
  const bytesPerSecond = duration > 0 ? size / duration : 0;
  const bufferSeconds = bytesPerSecond ? Math.max(0, received / bytesPerSecond - position) : 0;
  const rate = transferMs > 0 ? transferBytes / (transferMs / 1000) : Infinity;
  const slow = !complete && samples >= 3 && transferMs >= 12000 && bytesPerSecond > 0 &&
    rate < bytesPerSecond * 1.05 && bufferSeconds < 10;
  const delayMs = !complete && ready && bufferSeconds > 45
    ? Math.min(3000, Math.ceil((bufferSeconds - 45) * 1000)) : 0;
  return { bufferSeconds, slow, delayMs };
}

export class Uploads {
  constructor(config, rooms, store) {
    this.config = config;
    this.now = config.now || Date.now;
    this.rooms = rooms;
    this.store = store;
    this.uploads = new Map();
    this.dir = path.join(config.dataDir, 'uploads');
    this.secret = randomBytes(32).toString('hex');
    this.cleanups = new Set();
    this.retiring = new Set();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    const items = new Map(this.rooms.allItems().map(item => [item.id, item]));
    for (const saved of this.store?.load('uploads') || []) {
      const item = items.get(saved.itemId);
      if (!item || item.source.uploadId !== saved.id || !/^[a-f0-9-]{36}$/.test(saved.id)) {
        this.store.delete('uploads', saved.id);
        continue;
      }
      const file = path.join(this.dir, saved.id);
      const info = await lstat(file).catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (!info?.isFile()) {
        this.store.delete('uploads', saved.id);
        continue;
      }
      const received = Math.min(saved.received, info.size, saved.size);
      if (info.size !== received) {
        const handle = await open(file, 'r+');
        try { await handle.truncate(received); } finally { await handle.close(); }
      }
      const upload = { ...saved, item, file, received, complete: received === saved.size,
        lastProgressAt: saved.lastProgressAt ?? saved.createdAt,
        busy: false, cancelled: false, readers: new Set() };
      item.source.complete = upload.complete;
      item.uploadProgress = { received, total: upload.size, complete: upload.complete };
      this.uploads.set(upload.id, upload);
      this.persist(upload);
    }
    for (const item of items.values()) {
      if (item.kind === 'upload' && !this.uploads.has(item.source.uploadId)) {
        item.status = 'error';
        item.error = 'The uploaded source is missing. Remove this entry and upload the file again.';
      }
    }
    await this.cleanup();
    this.rooms.checkpoint();
  }

  persist(upload) {
    if (upload.cancelled) return;
    const { id, roomId, userId, size, received, complete, samples, lastWarning, createdAt, lastModified, lastProgressAt } = upload;
    this.store?.save('uploads', id, { id, itemId: upload.item.id, roomId, userId, size, received,
      complete, samples, lastWarning, createdAt, lastModified, lastProgressAt });
  }

  list(userId) {
    return [...this.uploads.values()].filter(u => u.userId === userId && !u.complete && !u.creating).map(u => ({
      id: u.id, roomId: u.roomId, roomName: this.rooms.get(u.roomId).name, name: u.item.title,
      size: u.size, lastModified: u.lastModified, received: u.received, duration: u.item.duration, chunkSize,
    }));
  }

  async cleanup() {
    const expired = [...this.uploads.values()].filter(u => !u.creating && !u.busy && !u.complete &&
      this.now() - u.lastProgressAt >= this.config.uploadIdleTimeoutMs);
    const expiredIds = new Set(expired.map(u => u.item.id));
    // Cancel sources before notifying media preparation, so expired streams stop
    // and an expired current item cannot be retained in the replay history.
    const removals = expired.map(u => this.discard(u));
    for (const room of this.rooms.rooms.values()) {
      if (![room.current, ...room.queue, ...room.history].some(item => item && expiredIds.has(item.id))) continue;
      room.queue = room.queue.filter(item => !expiredIds.has(item.id));
      room.history = room.history.filter(item => !expiredIds.has(item.id));
      if (expiredIds.has(room.current?.id)) {
        room.current = null;
        this.rooms.advance(room);
      } else this.rooms.changed(room);
    }
    await Promise.all(removals);
    const referenced = new Set(this.rooms.allItems().map(item => item.id));
    await Promise.all([...this.uploads.values()].filter(u => !u.creating && !referenced.has(u.item.id)).map(u => this.discard(u)));
    for (const entry of await readdir(this.dir)) {
      if (this.uploads.has(entry) || this.retiring.has(entry)) continue;
      await rm(path.join(this.dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  validateFile(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid upload file.');
    const name = text(body.name, 'Filename', 200);
    if (!Number.isSafeInteger(body.size) || body.size <= 0 || body.size > this.config.maxUploadBytes) {
      throw httpError(400, `Upload size must be between 1 byte and ${this.config.maxUploadBytes} bytes.`);
    }
    const duration = Number(body.duration);
    if (body.duration != null && (!Number.isFinite(duration) || duration <= 0 || duration > 86400)) {
      throw httpError(400, 'Invalid video duration (maximum 24 hours).');
    }
    if (body.lastModified != null && (!Number.isSafeInteger(body.lastModified) || body.lastModified < 0)) {
      throw httpError(400, 'Invalid file modification time.');
    }
    return { name, size: body.size, duration: duration || null, lastModified: body.lastModified ?? null };
  }

  async create(room, user, body, beforeCommit) {
    const result = await this.createBatch(room, user, { files: [body], insertAt: body.insertAt }, beforeCommit);
    return result.uploads[0];
  }

  async createBatch(room, user, body, beforeCommit = () => {}) {
    this.rooms.requireManual(room);
    if (!Array.isArray(body.files) || !body.files.length || body.files.length > 100) {
      throw httpError(400, 'Choose between 1 and 100 videos per upload batch.');
    }
    const files = body.files.map(file => this.validateFile(file));
    if (room.queue.length + files.length > this.rooms.maxQueue) throw httpError(409, 'The room queue is full.');
    const reserved = [...this.uploads.values()].reduce((total, upload) => total + upload.size, 0);
    const requested = files.reduce((total, file) => total + file.size, 0);
    const own = [...this.uploads.values()].filter(upload => upload.userId === user.id);
    if (own.length + files.length > this.config.maxUserUploads ||
      own.reduce((total, upload) => total + upload.size, 0) + requested > this.config.maxUserStorageBytes) {
      throw httpError(409, 'Your upload reservation limit is full. Remove unneeded uploads before adding more.');
    }
    if (this.uploads.size + files.length > this.config.maxUploads || reserved + requested > this.config.maxStorageBytes) {
      throw httpError(507, 'Upload storage budget is full. Remove unneeded queue items.');
    }
    const playlistId = files.length > 1 ? randomUUID() : null;
    const playlistTitle = playlistId ? inferPlaylistTitle(files.map(file => file.name)) : null;
    const batch = files.map(file => {
      const id = randomUUID();
      const item = makeItem({ kind: 'upload', uploadId: id, complete: false }, {
        title: file.name, duration: file.duration, addedBy: user.displayName, status: 'uploading', playlistId, playlistTitle,
        uploadProgress: { received: 0, total: file.size, complete: false },
      });
      return { id, item, roomId: room.id, userId: user.id, size: file.size,
        received: 0, complete: false, busy: false, cancelled: false, file: path.join(this.dir, id),
        samples: [], lastWarning: 0, readers: new Set(), createdAt: this.now(), lastProgressAt: this.now(),
        lastModified: file.lastModified, creating: true };
    });
    for (const upload of batch) this.uploads.set(upload.id, upload);
    const createdFiles = [];
    try {
      for (const upload of batch) {
        const handle = await open(upload.file, 'wx');
        createdFiles.push(upload.file);
        await handle.close();
      }
      beforeCommit();
      this.rooms.add(room, batch.map(upload => upload.item), body.insertAt, () => {
        for (const upload of batch) this.persist(upload);
      });
    } catch (error) {
      for (const upload of batch) this.uploads.delete(upload.id);
      await Promise.all(createdFiles.map(file => rm(file, { force: true, maxRetries: 10, retryDelay: 100 })));
      throw error;
    }
    for (const upload of batch) upload.creating = false;
    return { uploads: batch.map(upload => ({ uploadId: upload.id, chunkSize })), playlistId, playlistTitle };
  }

  get(id, userId) {
    const upload = this.uploads.get(id);
    if (!upload || upload.cancelled) throw httpError(404, 'Upload no longer exists.');
    if (userId && upload.userId !== userId) throw httpError(403, 'This upload belongs to another user.');
    return upload;
  }

  status(upload) {
    const room = this.rooms.get(upload.roomId);
    const active = room.current?.id === upload.item.id || room.queue[0]?.id === upload.item.id;
    const health = uploadHealth({ size: upload.size, duration: upload.item.duration, received: upload.received,
      position: room.current?.id === upload.item.id ? this.rooms.position(room) : 0,
      transferBytes: upload.samples.reduce((n, s) => n + s.bytes, 0),
      transferMs: upload.samples.reduce((n, s) => n + s.ms, 0), samples: upload.samples.length,
      ready: !!upload.item.media, complete: upload.complete });
    if (health.slow && Date.now() - upload.lastWarning > 60000) {
      upload.lastWarning = Date.now();
      this.persist(upload);
      const user = [...room.members.values()].find(u => u.id === upload.userId);
      this.rooms.emit('overlay', room, `${user?.displayName || upload.item.addedBy} has shitternet, laugh at them.`);
    }
    return { received: upload.received, complete: upload.complete, active, ...health };
  }

  async append(upload, offset, bytes, transferMs, beforeCommit = () => {}) {
    if (upload.cancelled) throw httpError(404, 'Upload no longer exists.');
    if (upload.busy) throw httpError(409, 'Only one upload chunk may be in flight.');
    if (offset !== upload.received) throw httpError(409, 'Upload offset mismatch; request upload status to resume.');
    if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > chunkSize || upload.received + bytes.length > upload.size) {
      throw httpError(400, 'Invalid upload chunk size.');
    }
    upload.busy = true;
    try {
      const handle = await open(upload.file, 'r+');
      try {
        beforeCommit();
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, offset + written);
          if (!result.bytesWritten) throw new Error('Unable to write upload chunk.');
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally {
        await handle.close();
      }
      if (upload.cancelled) throw httpError(404, 'Upload no longer exists.');
      beforeCommit();
      upload.received += bytes.length;
      upload.lastProgressAt = this.now();
      upload.complete = upload.received === upload.size;
      upload.item.source.complete = upload.complete;
      upload.item.uploadProgress = { received: upload.received, total: upload.size, complete: upload.complete };
      upload.samples.push({ bytes: bytes.length, ms: Math.max(1, transferMs) });
      while (upload.samples.length > 30) upload.samples.shift();
      const save = () => {
        this.persist(upload);
        this.rooms.persist(this.rooms.get(upload.roomId));
      };
      if (this.store) this.store.transaction(save);
      else save();
      this.rooms.emit('prepare', this.rooms.get(upload.roomId));
      return this.status(upload);
    } finally {
      upload.busy = false;
    }
  }

  async serve(req, res, id) {
    if (req.query.key !== this.secret || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) {
      throw httpError(403, 'Local media source only.');
    }
    const upload = this.get(id);
    const range = req.headers.range;
    const match = range && /^bytes=(\d*)-(\d*)$/.exec(range);
    if (range && (!match || (!match[1] && !match[2]))) throw httpError(416, 'Invalid source range.');
    let start = match ? Number(match[1] || Math.max(0, upload.size - Number(match[2]))) : 0;
    const end = match?.[1] && match[2] ? Math.min(upload.size - 1, Number(match[2])) : upload.size - 1;
    if (!Number.isSafeInteger(start) || start > end || start < 0) throw httpError(416, 'Source range outside file.');
    res.status(range ? 206 : 200);
    res.set({ 'Content-Type': 'application/octet-stream', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 });
    if (range) res.set('Content-Range', `bytes ${start}-${end}/${upload.size}`);
    res.flushHeaders();
    if (req.method === 'HEAD') return res.end();
    const handle = await open(upload.file, 'r');
    upload.readers.add(res);
    try {
      while (start <= end && !res.destroyed && !upload.cancelled) {
        const length = Math.min(64 * 1024, end - start + 1, upload.received - start);
        if (length <= 0) {
          await sleep(100);
          continue;
        }
        const buffer = Buffer.allocUnsafe(length);
        const { bytesRead } = await handle.read(buffer, 0, length, start);
        if (!bytesRead) { await sleep(50); continue; }
        start += bytesRead;
        if (!res.write(buffer.subarray(0, bytesRead))) {
          await new Promise(resolve => {
            const done = () => { res.off('drain', done); res.off('close', done); resolve(); };
            res.once('drain', done);
            res.once('close', done);
          });
        }
      }
      res.end();
    } finally {
      upload.readers.delete(res);
      await handle.close();
    }
  }

  async discard(upload) {
    if (upload.cancelled) return upload.cleanup;
    upload.cancelled = true;
    this.uploads.delete(upload.id);
    this.store?.delete('uploads', upload.id);
    for (const res of upload.readers) res.destroy();
    upload.cleanup = (async () => {
      while (upload.busy) await sleep(20);
      await rm(upload.file, { force: true, maxRetries: 10, retryDelay: 100 });
    })();
    this.retiring.add(upload.id);
    this.cleanups.add(upload.cleanup);
    try { await upload.cleanup; } finally { this.cleanups.delete(upload.cleanup); this.retiring.delete(upload.id); }
  }

  async close() {
    for (const upload of this.uploads.values()) {
      for (const res of upload.readers) res.destroy();
      while (upload.busy) await sleep(20);
      this.persist(upload);
    }
    await Promise.all(this.cleanups);
  }
}
