import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config as defaults, httpError, text } from './config.js';
import { Accounts, publicUser } from './auth.js';
import { Rooms } from './rooms.js';
import { Uploads, chunkSize } from './uploads.js';
import { YouTube } from './youtube.js';
import { Media, available } from './media.js';
import { StateStore } from './store.js';
import { DirectAccess, equalSecret } from './direct-access.js';
import { deploymentOrigin, securityHeaders } from '../shared/deployment.js';

export function validOrigin(origin, host, config) {
  return !origin || origin === `http://${host}` || origin === `https://${host}` || config.origins.includes(origin);
}

export async function createApp(overrides = {}) {
  const config = { ...defaults, ...overrides };
  config.bareMetalOrigin = deploymentOrigin(config.bareMetalOrigin);
  if (config.edgeProxySecret && config.edgeProxySecret.length < 32) throw new Error('EDGE_PROXY_SECRET must be at least 32 characters.');
  const store = new StateStore(config.dataDir);
  await store.init();
  try {
    store.transaction(() => {
      const owner = store.load('runtime').find(value => value.id === 'owner');
      if (owner) {
        let alive = true;
        try { process.kill(owner.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
        if (alive) throw new Error('This data directory is already in use by another Helltube server. Stop it before restarting.');
      }
      store.save('runtime', 'owner', { id: 'owner', pid: process.pid });
    });
  } catch (error) { store.close(); throw error; }
  const accounts = new Accounts(config.dataDir, store);
  const youtube = new YouTube(config);
  let rooms;
  let uploads;
  let media;
  try {
    await accounts.init();
    rooms = new Rooms({ ...config, store });
    uploads = new Uploads(config, rooms, store);
    media = new Media(config, rooms, uploads, youtube);
    await uploads.init();
    await media.init();
  } catch (error) {
    store.delete('runtime', 'owner');
    store.close();
    throw error;
  }
  const capabilities = { ffmpeg: await available(config.ffmpeg), youtube: await available(config.ytdlp, ['--version']) };
  const directAccess = new DirectAccess(accounts);
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 8192, perMessageDeflate: false });
  server.requestTimeout = 120000;
  server.headersTimeout = 20000;
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    req.startedAt = performance.now();
    res.set(securityHeaders(config.bareMetalOrigin));
    if (/^\/(api|media|direct|internal)(\/|$)/.test(req.path)) res.set('Cache-Control', 'no-store');
    req.edge = equalSecret(req.headers['x-helltube-edge'], config.edgeProxySecret);
    if (req.headers['x-helltube-edge'] !== undefined && !req.edge) return next(httpError(403, 'Invalid edge proxy credentials.'));
    const direct = req.path === '/direct' || req.path.startsWith('/direct/');
    const trustedDirect = direct && config.bareMetalOrigin && config.origins.includes(req.headers.origin);
    if (!validOrigin(req.headers.origin, req.headers.host, config) ||
      (req.headers['sec-fetch-site'] === 'cross-site' && !trustedDirect)) {
      return next(httpError(403, 'Cross-origin requests are not allowed.'));
    }
    if (direct) {
      if (req.edge) return next(httpError(403, 'Direct traffic must bypass the edge proxy.'));
      if (trustedDirect) {
        res.set('Access-Control-Allow-Origin', req.headers.origin);
        res.vary('Origin');
        res.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
      }
      if (req.method === 'OPTIONS') {
        const headers = String(req.headers['access-control-request-headers'] || '').toLowerCase().split(',').map(value => value.trim()).filter(Boolean);
        if (!trustedDirect || !['GET', 'HEAD', 'PUT'].includes(req.headers['access-control-request-method']) ||
          headers.some(header => !['content-type', 'range'].includes(header))) return next(httpError(403, 'Invalid direct request preflight.'));
        res.set({ 'Access-Control-Allow-Methods': 'GET, HEAD, PUT', 'Access-Control-Allow-Headers': 'Content-Type, Range',
          'Access-Control-Max-Age': '600' });
        return res.status(204).end();
      }
    }
    next();
  });
  app.get('/internal/uploads/:id', (req, res) => uploads.serve(req, res, req.params.id));
  app.use('/api/rooms/:id/uploads/batch', express.json({ limit: '256kb' }));
  app.use(express.json({ limit: '32kb' }));
  app.use((req, _res, next) => { req.body ??= {}; next(); });

  const limits = new Map();
  function limit(key, max, windowMs = 60000) {
    const now = Date.now();
    let value = limits.get(key);
    if (!value || value.until < now) { value = { count: 0, until: now + windowMs }; limits.set(key, value); }
    if (++value.count > max) throw httpError(429, 'Too many requests. Please wait a moment.');
  }
  const cookie = token => `session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${token ? 604800 : 0}${config.secureCookies ? '; Secure' : ''}`;
  const identify = (req, _res, next) => {
    const session = accounts.authenticate(req.headers.cookie);
    if (!session) return next(httpError(401, 'Please sign in.'));
    req.auth = session;
    next();
  };
  const admin = (req, _res, next) => next(req.auth.user.role === 'admin' ? undefined : httpError(403, 'Administrator access required.'));
  const membership = (req, id = req.params.id) => {
    const room = rooms.get(id);
    if (![...room.members.values()].some(u => u.id === req.auth.user.id)) throw httpError(403, 'Join this room before adding videos.');
    return room;
  };
  const requireMedia = () => { if (!capabilities.ffmpeg) throw httpError(503, 'FFmpeg is missing. Install it and restart the server.'); };
  const directUrl = (route, auth, scope) => `${config.bareMetalOrigin}${route}?grant=${directAccess.issue(auth, scope)}`;
  const uploadStatus = (upload, auth, status = uploads.status(upload)) => ({ ...status,
    ...(config.bareMetalOrigin ? { transferUrl: directUrl(`/direct/uploads/${upload.id}`, auth, `upload:${upload.id}`) } : {}) });
  const identifyDirect = scope => (req, res, next) => {
    if (req.query.grant !== undefined) {
      req.auth = directAccess.authenticate(req.query.grant, scope(req));
      return next();
    }
    if (config.bareMetalOrigin) return next(httpError(401, 'A direct access grant is required.'));
    identify(req, res, next);
  };
  const mediaJob = (jobId, auth) => {
    const job = [...media.jobs.values()].find(value => value.id === jobId && !value.cancelled);
    if (!job) throw httpError(404, 'Media not found.');
    const allowed = [...rooms.rooms.values()].some(room => [...room.members.values()].some(user => user.id === auth.user.id) &&
      [room.current, ...room.queue, ...room.history].some(item => item?.id === job.item.id));
    if (!allowed) throw httpError(403, 'Join the room to watch its media.');
    return job;
  };
  app.get('/api/health', (_req, res) => res.json({ ok: true, capabilities }));
  app.post('/api/login', async (req, res) => {
    limit(`login:${req.socket.remoteAddress}`, 10);
    const { user, token } = await accounts.login(req.body.username, req.body.password);
    res.set('Set-Cookie', cookie(token)).json({ user: publicUser(user), capabilities });
  });
  app.use('/api', identify, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/config', (_req, res) => res.json({ bareMetalOrigin: config.bareMetalOrigin }));
  app.get('/api/media/:jobId/access', (req, res) => {
    const job = mediaJob(req.params.jobId, req.auth);
    res.json({ url: config.bareMetalOrigin && job.item.kind === 'upload'
      ? directUrl(`/direct/media/${job.id}/index.m3u8`, req.auth, `media:${job.id}`)
      : `/media/${job.id}/index.m3u8` });
  });
  app.get('/api/edge/media/:jobId/:file', async (req, res) => {
    if (!req.edge) throw httpError(403, 'Edge proxy credentials required.');
    const job = mediaJob(req.params.jobId, req.auth);
    if (job.item.kind !== 'youtube' || !Buffer.isBuffer(job.key) || job.key.length !== 16 ||
      !/^segment-\d{6,}\.ts$/.test(req.params.file)) throw httpError(403, 'This media is not edge-cacheable.');
    const file = await stat(path.join(job.dir, req.params.file)).catch(() => null);
    if (!file?.isFile()) throw httpError(404, 'Media not found.');
    res.json({ cacheable: true });
  });
  app.post('/api/logout', (req, res) => {
    accounts.logout(req.auth.token);
    expireSockets();
    res.set('Set-Cookie', cookie('')).json({ ok: true });
  });
  app.get('/api/me', (req, res) => res.json({ user: publicUser(req.auth.user), capabilities }));
  app.patch('/api/me/preferences', async (req, res) => {
    limit(`preferences:${req.auth.user.id}`, 120);
    res.json({ user: publicUser(await accounts.updatePreferences(req.auth.user.id, req.body)) });
  });
  app.patch('/api/me', async (req, res) => {
    limit(`account:${req.auth.user.id}`, 20);
    const user = await accounts.update(req.auth.user.id, req.body, { self: true, token: req.auth.token });
    expireSockets();
    broadcastRooms();
    res.json({ user: publicUser(user) });
  });
  app.get('/api/users', admin, (_req, res) => res.json({ users: accounts.users.map(publicUser) }));
  app.post('/api/users', admin, async (req, res) => {
    limit(`account:${req.auth.user.id}`, 20);
    res.status(201).json({ user: publicUser(await accounts.create(req.body)) });
  });
  app.patch('/api/users/:id', admin, async (req, res) => {
    limit(`account:${req.auth.user.id}`, 20);
    const user = await accounts.update(req.params.id, req.body);
    expireSockets();
    res.json({ user: publicUser(user) });
  });
  app.delete('/api/users/:id', admin, async (req, res) => {
    await accounts.remove(req.params.id, req.auth.user.id);
    expireSockets();
    res.json({ ok: true });
  });
  app.get('/api/rooms', (_req, res) => res.json({ rooms: rooms.list() }));
  app.post('/api/rooms', (req, res) => {
    limit(`rooms:${req.auth.user.id}`, 10);
    const room = rooms.create(req.body.name);
    res.status(201).json({ room: { id: room.id, name: room.name } });
  });
  app.post('/api/rooms/:id/youtube', async (req, res) => {
    requireMedia();
    if (!capabilities.youtube) throw httpError(503, 'yt-dlp is missing. Install it and restart the server.');
    limit(`submissions:${req.auth.user.id}`, 12);
    const room = membership(req);
    const items = await youtube.items(text(req.body.url, 'URL', 2048), req.auth.user, req.body.startAt);
    if (!accounts.authenticate(req.headers.cookie)) throw httpError(401, 'Session expired.');
    membership(req);
    rooms.add(room, items, req.body.insertAt);
    res.status(201).json({ added: items.length });
  });
  app.post('/api/rooms/:id/uploads', async (req, res) => {
    requireMedia();
    limit(`submissions:${req.auth.user.id}`, 12);
    res.status(201).json(await uploads.create(membership(req), req.auth.user, req.body));
  });
  app.post('/api/rooms/:id/uploads/batch', async (req, res) => {
    requireMedia();
    limit(`submissions:${req.auth.user.id}`, 12);
    const result = await uploads.createBatch(membership(req), req.auth.user, req.body, () => {
      if (!accounts.authenticate(req.headers.cookie)) throw httpError(401, 'Session expired.');
      membership(req);
    });
    res.status(201).json(result);
  });
  app.get('/api/uploads', (req, res) => res.json({ uploads: uploads.list(req.auth.user.id) }));
  app.get('/api/uploads/:id', (req, res) => res.json(uploadStatus(uploads.get(req.params.id, req.auth.user.id), req.auth)));
  app.put('/api/uploads/:id', (req, _res, next) => next(config.bareMetalOrigin || req.edge
    ? httpError(409, 'Send upload bytes directly to the transferUrl from the upload status endpoint.') : undefined),
  express.raw({ type: 'application/octet-stream', limit: chunkSize }), async (req, res) => {
    const upload = uploads.get(req.params.id, req.auth.user.id);
    res.json(await uploads.append(upload, Number(req.query.offset), req.body, performance.now() - req.startedAt));
  });
  app.put('/direct/uploads/:id', identifyDirect(req => `upload:${req.params.id}`),
  express.raw({ type: 'application/octet-stream', limit: chunkSize }), async (req, res) => {
    const upload = uploads.get(req.params.id, req.auth.user.id);
    const status = await uploads.append(upload, Number(req.query.offset), req.body, performance.now() - req.startedAt);
    res.json(uploadStatus(upload, req.auth, status));
  });
  app.delete('/api/uploads/:id', async (req, res) => {
    const upload = uploads.get(req.params.id, req.auth.user.id);
    const room = rooms.get(upload.roomId);
    room.queue = room.queue.filter(i => i.id !== upload.item.id);
    room.history = room.history.filter(i => i.id !== upload.item.id);
    if (room.current?.id === upload.item.id) { room.current = null; rooms.advance(room); }
    else rooms.changed(room);
    if (uploads.uploads.has(upload.id)) await uploads.discard(upload);
    res.json({ ok: true });
  });

  const serveMedia = async (req, res, next) => {
    const job = mediaJob(req.params.jobId, req.auth);
    if (!/^(index\.m3u8|segment-\d{6,}\.ts)$/.test(req.params.file)) throw httpError(404, 'Media not found.');
    if (config.bareMetalOrigin && job.item.kind === 'upload' && !req.path.startsWith('/direct/')) {
      throw httpError(409, 'Uploaded media must be streamed directly from bare metal.');
    }
    res.set('Cache-Control', 'no-store');
    res.type(req.params.file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t');
    if (req.params.file === 'index.m3u8' && config.bareMetalOrigin) {
      let contents;
      try { contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') throw httpError(404, 'Media not found.'); throw error; }
      const scope = `media:${job.id}`;
      const keyUrl = directUrl(`/direct/media/${job.id}/key.bin`, req.auth, scope);
      contents = contents.replace(/URI="[^"]*"/g, `URI="${keyUrl}"`);
      if (job.item.kind === 'upload') {
        contents = contents.replace(/^segment-\d{6,}\.ts$/gm, file => directUrl(`/direct/media/${job.id}/${file}`, req.auth, scope));
      }
      return res.send(contents);
    }
    if (req.params.file.endsWith('.ts') && job.key?.length === 16) res.set('X-Helltube-Encrypted', 'aes-128');
    res.sendFile(path.join(job.dir, req.params.file), { cacheControl: false }, error => { if (error) next(error); });
  };
  app.get('/media/:jobId/:file', identify, serveMedia);
  app.get('/direct/media/:jobId/key.bin', identifyDirect(req => `media:${req.params.jobId}`), (req, res) => {
    const job = mediaJob(req.params.jobId, req.auth);
    if (!Buffer.isBuffer(job.key) || job.key.length !== 16) throw httpError(404, 'Media key not found.');
    res.set('Cache-Control', 'no-store').type('application/octet-stream').send(job.key);
  });
  app.get('/direct/media/:jobId/:file', identifyDirect(req => `media:${req.params.jobId}`), serveMedia);
  app.use(['/media', '/direct'], (_req, _res, next) => next(httpError(404, 'Media endpoint not found.')));
  app.use('/api', (_req, _res, next) => next(httpError(404, 'API endpoint not found.')));
  const dist = path.resolve(fileURLToPath(new URL('../dist', import.meta.url)));
  app.use(express.static(dist));
  app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    res.set('Cache-Control', 'no-store');
    const status = error.status || (error.type === 'entity.too.large' ? 413 : 500);
    if (status >= 500) console.error('Request:', error.message);
    res.status(status).json({ error: status >= 500 && !error.status ? 'The server could not complete this request. Check the server log.' : error.message });
  });

  function send(ws, value) {
    if (ws.readyState !== WebSocket.OPEN) return;
    if (ws.bufferedAmount > 1024 * 1024) return ws.close(1013, 'Client too slow; reconnect.');
    ws.send(JSON.stringify(value));
  }
  function broadcastRooms() { for (const ws of wss.clients) send(ws, { type: 'rooms', rooms: rooms.list() }); }
  function broadcastState(room) {
    const value = { type: 'state', room: rooms.snapshot(room), serverTime: Date.now() };
    for (const ws of wss.clients) if (ws.roomId === room.id) send(ws, value);
  }
  function leave(ws) {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    room.members.delete(ws.id);
    ws.roomId = null;
    broadcastState(room);
    broadcastRooms();
  }
  function expireSockets() {
    for (const ws of wss.clients) {
      if (!accounts.authenticate(ws.cookie)) { send(ws, { type: 'session-ended' }); leave(ws); ws.close(1008, 'Session expired'); }
    }
  }
  rooms.on('state', broadcastState);
  rooms.on('rooms', broadcastRooms);
  rooms.on('overlay', (room, message) => {
    for (const ws of wss.clients) if (ws.roomId === room.id) send(ws, { type: 'overlay', message, expiresAt: Date.now() + 10000 });
  });
  server.on('upgrade', (req, socket, head) => {
    const auth = accounts.authenticate(req.headers.cookie);
    if (req.url !== '/ws' || !auth || !req.headers.origin || !validOrigin(req.headers.origin, req.headers.host, config) ||
      wss.clients.size >= 500 || [...wss.clients].filter(ws => ws.userId === auth.user.id).length >= 8) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req, auth));
  });
  wss.on('connection', (ws, req, auth) => {
    ws.id = randomUUID();
    ws.userId = auth.user.id;
    ws.cookie = req.headers.cookie;
    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    send(ws, { type: 'rooms', rooms: rooms.list() });
    ws.on('message', bytes => {
      try {
        const current = accounts.authenticate(ws.cookie);
        if (!current) { expireSockets(); return; }
        limit(`ws:${ws.id}`, 40, 1000);
        const message = JSON.parse(bytes.toString());
        if (!message || typeof message !== 'object') throw httpError(400, 'Invalid message.');
        if (message.type === 'ping') return send(ws, { type: 'pong', sentAt: message.sentAt, serverTime: Date.now() });
        if (message.type === 'join') {
          const room = rooms.get(message.roomId);
          leave(ws);
          ws.roomId = room.id;
          room.members.set(ws.id, current.user);
          broadcastState(room);
          broadcastRooms();
          return;
        }
        if (!ws.roomId) throw httpError(403, 'Join a room first.');
        const room = rooms.get(ws.roomId);
        if (message.type === 'control') rooms.control(room, message);
        else if (message.type?.startsWith('queue:')) rooms.mutateQueue(room, message);
        else if (message.type === 'history:play') rooms.replay(room, message.itemId);
        else throw httpError(400, 'Unknown message type.');
      } catch (error) { send(ws, { type: 'error', message: error.status ? error.message : 'Invalid room command.' }); }
    });
    ws.on('close', () => { leave(ws); limits.delete(`ws:${ws.id}`); });
    ws.on('error', () => ws.terminate());
  });
  const tick = setInterval(() => { expireSockets(); rooms.tick(); }, 750);
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) { if (!ws.alive) ws.terminate(); else { ws.alive = false; ws.ping(); } }
    for (const [key, value] of limits) if (value.until < Date.now()) limits.delete(key);
    directAccess.prune();
  }, 15000);
  tick.unref();
  heartbeat.unref();
  let cleaning = null;
  let closing = null;
  const cleanup = () => {
    if (cleaning) return cleaning;
    cleaning = (async () => { await media.cleanup(); await uploads.cleanup(); })()
      .finally(() => { cleaning = null; });
    return cleaning;
  };
  const housekeeping = setInterval(() => {
    cleanup().catch(error => console.error('Storage cleanup:', error.message));
  }, Math.max(100, config.cleanupIntervalMs || 60000));
  housekeeping.unref();
  return { app, server, accounts, rooms, uploads, media, youtube, capabilities, store, cleanup,
    async listen(port = config.port) {
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, config.host, resolve); });
      media.port = server.address().port;
      media.listening = true;
      media.schedule();
      return `http://${config.host}:${media.port}`;
    },
    async close() {
      if (closing) return closing;
      closing = (async () => {
        clearInterval(tick);
        clearInterval(heartbeat);
        clearInterval(housekeeping);
        const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        for (const ws of wss.clients) ws.terminate();
        wss.close();
        for (const room of rooms.rooms.values()) {
          room.resumeWhenReady ||= !room.playback.paused;
          rooms.stamp(room, rooms.position(room), true);
        }
        rooms.checkpoint();
        await cleaning;
        await media.close();
        await uploads.close();
        server.closeAllConnections();
        await stopped;
        await accounts.close();
        store.delete('runtime', 'owner');
        store.close();
      })();
      return closing;
    },
  };
}