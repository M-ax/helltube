import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { config as defaults, httpError, text } from './config.js';
import { Accounts, publicUser } from './auth.js';
import { Rooms } from './rooms.js';
import { Reactions } from './reactions.js';
import { Uploads, chunkSize } from './uploads.js';
import { YouTube } from './youtube.js';
import { sponsorPlaylist } from './sponsorblock.js';
import { Twitch } from './twitch.js';
import { RemoteMedia } from './remote-media.js';
import { sourceKind } from '../shared/media-source.js';
import { Media, available } from './media.js';
import { StateStore } from './store.js';
import { DirectAccess, equalSecret } from './direct-access.js';
import { deploymentOrigin, securityHeaders, normalizeCommit } from '../shared/deployment.js';
import { Deployment } from './deployment.js';
import { DesktopShares } from './desktop.js';
import { encryptedMediaFile, publicMediaFile, mediaContentType } from '../shared/media-files.js';

export function validOrigin(origin, host, config) {
  return !origin || origin === `http://${host}` || origin === `https://${host}` || config.origins.includes(origin);
}

export async function createApp(overrides = {}) {
  const config = { ...defaults, ...overrides };
  for (const name of ['maxUserStorageBytes', 'maxUploads', 'maxUserUploads', 'uploadIdleTimeoutMs']) {
    if (!Number.isSafeInteger(config[name]) || config[name] <= 0) throw new Error(`${name} must be a positive safe integer.`);
  }
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
  const deployment = new Deployment(config, store);
  const youtube = new YouTube(config);
  const twitch = new Twitch(config);
  const remote = new RemoteMedia();
  let rooms;
  let uploads;
  let media;
  try {
    await deployment.init();
    await accounts.init();
    rooms = new Rooms({ ...config, store });
    uploads = new Uploads(config, rooms, store);
    media = new Media(config, rooms, uploads, youtube, twitch);
    await uploads.init();
    await media.init();
  } catch (error) {
    store.delete('runtime', 'owner');
    store.close();
    throw error;
  }
  const capabilities = { ffmpeg: await available(config.ffmpeg), youtube: await available(config.ytdlp, ['--version']) };
  capabilities.twitch = capabilities.youtube;
  capabilities.http = capabilities.ffmpeg;
  const directAccess = new DirectAccess(accounts);
  const app = express();
  const server = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024, perMessageDeflate: false });
  const desktop = new DesktopShares(rooms, media, send);
  const reactions = new Reactions({ broadcast(roomId, message) {
    for (const ws of wss.clients) if (ws.roomId === roomId) send(ws, message);
  } });
  server.requestTimeout = 120000;
  server.headersTimeout = 20000;
  app.disable('x-powered-by');
  // The managed nginx configuration replaces X-Forwarded-For with its peer IP.
  // Never trust forwarding headers from a non-loopback socket.
  app.set('trust proxy', config.trustProxy ? 'loopback' : false);
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
  app.get('/internal/remote/:jobId', async (req, res) => {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
      !equalSecret(req.query.key, media.sourceSecret)) throw httpError(403, 'Internal media access denied.');
    const job = [...media.jobs.values()].find(job => job.id === req.params.jobId && !job.cancelled && job.item.kind === 'http');
    if (!job) throw httpError(404, 'Media not found.');
    await remote.serve(req, res, job.item.source.url);
  });
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
    const job = media.allJobs().find(value => value.id === jobId && !value.cancelled && !value.failed);
    if (!job) throw httpError(404, 'Media not found.');
    const allowed = [...rooms.rooms.values()].some(room => [...room.members.values()].some(user => user.id === auth.user.id) &&
      [room.current, ...room.queue, ...room.history].some(item => item?.id === job.item.id));
    if (!allowed) throw httpError(403, 'Join the room to watch its media.');
    return job;
  };
  app.get('/api/health', (_req, res) => res.json({ ok: true, capabilities }));
  app.get('/api/version', (_req, res) => res.json({ commit: deployment.commit }));
  app.post('/api/edge/deployment', async (req, res) => {
    if (!req.edge) throw httpError(403, 'Edge credentials required.');
    const commit = normalizeCommit(req.body.commit);
    if (!commit) throw httpError(400, 'A full commit hash is required.');
    await deployment.announce(commit);
    res.json({ ok: true, commit: deployment.commit });
  });
  app.post('/api/login', async (req, res) => {
    const edgeIP = req.edge && req.headers['x-helltube-client-ip'];
    const clientIP = typeof edgeIP === 'string' && isIP(edgeIP) ? edgeIP : req.ip;
    limit(`login:${clientIP}`, 10);
    const { user, token } = await accounts.login(req.body.username, req.body.password);
    res.set('Set-Cookie', cookie(token)).json({ user: publicUser(user), capabilities });
  });
  app.use('/api', identify, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/config', (_req, res) => res.json({ bareMetalOrigin: config.bareMetalOrigin }));
  app.get('/api/media/:jobId/access', (req, res) => {
    const job = mediaJob(req.params.jobId, req.auth);
    const metalUrl = config.bareMetalOrigin
      ? directUrl(`/direct/media/${job.id}/index.m3u8`, req.auth, `media:${job.id}`) : null;
    res.json({ url: config.bareMetalOrigin && job.item.kind === 'upload'
      ? metalUrl : `/media/${job.id}/index.m3u8`,
      ...(metalUrl && job.item.kind !== 'upload' ? { fallbackUrl: metalUrl } : {}) });
  });
  app.get('/api/edge/media/:jobId/:file', async (req, res) => {
    if (!req.edge) throw httpError(403, 'Edge proxy credentials required.');
    const job = mediaJob(req.params.jobId, req.auth);
    if (!['youtube', 'twitch', 'http'].includes(job.item.kind) || !Buffer.isBuffer(job.key) || job.key.length !== 16 ||
      !encryptedMediaFile.test(req.params.file)) throw httpError(403, 'This media is not edge-cacheable.');
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
  app.get('/api/rooms/:id/items/:itemId/original', (req, res) => {
    const room = membership(req);
    const item = [room.current, ...room.queue, ...room.history].find(item => item?.id === req.params.itemId);
    if (!item || item.kind === 'upload' || !sourceKind(item.source?.url)) {
      throw httpError(404, 'Original stream not available.');
    }
    res.set('Referrer-Policy', 'no-referrer').redirect(item.source.url);
  });
  app.post('/api/rooms', (req, res) => {
    limit(`rooms:${req.auth.user.id}`, 10);
    const room = rooms.create(req.body.name, undefined, req.auth.user.id);
    res.status(201).json({ room: rooms.snapshot(room) });
  });
  app.patch('/api/rooms/:id', (req, res) => {
    res.json({ room: rooms.rename(req.params.id, req.body.name, req.auth.user) });
  });
  app.delete('/api/rooms/:id', async (req, res) => {
    rooms.remove(req.params.id, req.auth.user);
    await Promise.all([...uploads.uploads.values()].filter(upload => upload.roomId === req.params.id && !upload.creating)
      .map(upload => uploads.discard(upload)));
    res.json({ ok: true });
  });
  app.post(['/api/rooms/:id/youtube', '/api/rooms/:id/media'], async (req, res) => {
    requireMedia();
    limit(`submissions:${req.auth.user.id}`, 12);
    const room = membership(req);
    const url = text(req.body.url, 'URL', 8192);
    const kind = req.path.endsWith('/youtube') ? 'youtube' : sourceKind(url);
    if (!kind) throw httpError(400, 'Enter a YouTube, Twitch VOD, or HTTP/HTTPS media URL.');
    if ((kind === 'youtube' || kind === 'twitch') && !capabilities[kind]) throw httpError(503, 'yt-dlp is missing. Install it and restart the server.');
    const provider = { youtube, twitch, http: remote }[kind];
    const preparation = { id: randomUUID(), kind, stage: 'metadata' };
    room.preparations ||= new Map();
    room.preparations.set(preparation.id, preparation);
    rooms.emit('state', room);
    try {
      const items = await provider.items(url, req.auth.user, req.body.startAt);
      if (!accounts.authenticate(req.headers.cookie)) throw httpError(401, 'Session expired.');
      membership(req);
      rooms.add(room, items, req.body.insertAt);
      res.status(201).json({ added: items.length });
    } finally {
      room.preparations.delete(preparation.id);
      if (rooms.rooms.get(room.id) === room) rooms.emit('state', room);
    }
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
    if (!publicMediaFile.test(req.params.file)) throw httpError(404, 'Media not found.');
    if (config.bareMetalOrigin && job.item.kind === 'upload' && !req.path.startsWith('/direct/')) {
      throw httpError(409, 'Uploaded media must be streamed directly from bare metal.');
    }
    res.set('Cache-Control', 'no-store');
    res.type(mediaContentType(req.params.file));
    if (req.params.file === 'index.m3u8') {
      let contents;
      try { contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') throw httpError(404, 'Media not found.'); throw error; }
      contents = sponsorPlaylist(contents, job.item, job.baseTime);
      if (!config.bareMetalOrigin) return res.send(contents);
      const scope = `media:${job.id}`;
      const keyUrl = directUrl(`/direct/media/${job.id}/key.bin`, req.auth, scope);
      contents = contents.replace(/^#EXT-X-KEY:.*$/gm, line => line.replace(/URI="[^"]*"/, `URI="${keyUrl}"`));
      if (req.path.startsWith('/direct/')) {
        contents = contents.replace(/^segment-\d{6,}\.(?:ts|m4s)$/gm, file => directUrl(`/direct/media/${job.id}/${file}`, req.auth, scope));
        contents = contents.replace(/^(#EXT-X-MAP:)URI="init\.mp4"/gm,
          `$1URI="${directUrl(`/direct/media/${job.id}/init.mp4`, req.auth, scope)}"`);
      }
      return res.send(contents);
    }
    if (encryptedMediaFile.test(req.params.file) && job.key?.length === 16) res.set('X-Helltube-Encrypted', 'aes-128');
    res.sendFile(req.params.file, { root: job.dir, cacheControl: false }, error => { if (error) next(error); });
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
  app.use(express.static(dist, { setHeaders(res, file) {
    if (['index.html', 'version.json'].includes(path.basename(file))) res.set('Cache-Control', 'no-store');
  } }));
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
    desktop.stop(ws);
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    room.members.delete(ws.id);
    reactions.leave(room.id, ws.id, room.members.size === 0);
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
  rooms.on('deleted', room => {
    reactions.rooms.delete(room.id);
    for (const ws of wss.clients) if (ws.roomId === room.id) ws.roomId = null;
  });
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
    ws.on('message', (bytes, binary) => {
      let message;
      try {
        const current = accounts.authenticate(ws.cookie);
        if (!current) { expireSockets(); return; }
        if (binary) {
          limit(`capture:${ws.id}`, 80, 1000);
          return desktop.write(ws, bytes);
        }
        limit(`ws:${ws.id}`, 40, 1000);
        if (bytes.length > 8192) throw httpError(400, 'Room command is too large.');
        message = JSON.parse(bytes.toString());
        if (!message || typeof message !== 'object') throw httpError(400, 'Invalid message.');
        if (message.type === 'ping') return send(ws, { type: 'pong', sentAt: message.sentAt, serverTime: Date.now() });
        if (message.type === 'join') {
          const room = rooms.get(message.roomId);
          if (ws.roomId === room.id) return;
          leave(ws);
          ws.roomId = room.id;
          room.members.set(ws.id, current.user);
          broadcastState(room);
          broadcastRooms();
          send(ws, reactions.snapshot(room.id));
          return;
        }
        if (!ws.roomId) throw httpError(403, 'Join a room first.');
        const room = rooms.get(ws.roomId);
        if (message.type === 'desktop:start') {
          requireMedia();
          limit(`desktop:${ws.userId}`, 12);
          desktop.start(room, ws, current.user, message);
        } else if (message.type === 'desktop:stop') {
          if (desktop.sessions.get(ws.id)?.requestId === message.requestId) desktop.stop(ws);
        } else if (message.type === 'reaction') {
          limit(`reaction:${ws.id}`, 8, 1000);
          reactions.react(room.id, current.user.id, message);
        } else if (message.type === 'reaction:pointer') {
          limit(`pointer:${ws.id}`, 25, 1000);
          reactions.pointer(room.id, ws.id, message);
        } else if (message.type === 'control') rooms.control(room, message);
        else if (message.type?.startsWith('queue:')) rooms.mutateQueue(room, message);
        else if (message.type === 'history:play') rooms.replay(room, message.itemId);
        else throw httpError(400, 'Unknown message type.');
      } catch (error) {
        if (binary) desktop.stop(ws, error.status ? error.message : 'Desktop stream failed.');
        send(ws, { type: message?.type === 'desktop:start' ? 'desktop:error' : 'error',
          requestId: message?.requestId, message: error.status ? error.message : 'Invalid room command.' });
      }
    });
    ws.on('close', () => {
      leave(ws);
      for (const prefix of ['ws', 'reaction', 'pointer', 'capture']) limits.delete(`${prefix}:${ws.id}`);
    });
    ws.on('error', () => ws.terminate());
  });
  const tick = setInterval(() => { expireSockets(); desktop.tick(); rooms.tick(); }, 750);
  const reactionTick = setInterval(() => reactions.tick(), 50);
  reactionTick.unref();
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
  return { app, server, accounts, rooms, reactions, desktop, uploads, media, youtube, twitch, remote, capabilities, store, cleanup,
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
        clearInterval(reactionTick);
        clearInterval(heartbeat);
        clearInterval(housekeeping);
        const stopped = server.listening ? new Promise(resolve => server.close(resolve)) : Promise.resolve();
        for (const ws of wss.clients) { desktop.stop(ws); ws.terminate(); }
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
        await deployment.pending;
        await accounts.close();
        store.delete('runtime', 'owner');
        store.close();
      })();
      return closing;
    },
  };
}
