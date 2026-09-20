import express from 'express';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {httpError} from './config.js';
import {parseObsOffer, obsRtpParameters, obsAnswer} from './obs-sdp.js';
import {desktopLimits} from '../shared/desktop-quality.js';

const digest = value => createHash('sha256').update(value).digest('hex');

export class ObsStreams {
  constructor({accounts, rooms, desktop, store, rtcConfig}) {
    Object.assign(this, {accounts, rooms, desktop, store, rtcConfig});
    this.keys = new Map(store.load('obs-keys').map(key => [key.id, key]));
    this.resources = new Map();
    this.tick();
  }

  valid(key) {
    return key && this.accounts.authenticate(`session=${key.sessionToken}`)?.user.id === key.userId && this.rooms.rooms.has(key.roomId);
  }

  issue(auth, room) {
    this.rooms.requireManual(room);
    this.tick();
    if (this.keys.size >= 10000) throw httpError(503, 'Too many OBS stream tokens. Revoke an unused token first.');
    this.revoke(auth.user.id, room.id);
    const token = randomBytes(32).toString('hex');
    const key = {id: digest(token), userId: auth.user.id, roomId: room.id, sessionToken: auth.token};
    this.store.save('obs-keys', key.id, key);
    this.keys.set(key.id, key);
    return {token, path: `/api/whip/${encodeURIComponent(room.id)}`, expires: this.accounts.sessions.get(auth.token).expires};
  }

  remove(key) {
    this.store.delete('obs-keys', key.id);
    this.keys.delete(key.id);
    for (const [id, resource] of this.resources) {
      if (resource.key !== key) continue;
      this.desktop.stop(resource.ws);
      this.resources.delete(id);
    }
  }

  revoke(userId, roomId) {
    for (const key of this.keys.values()) if (key.userId === userId && key.roomId === roomId) this.remove(key);
  }

  authenticate(header, roomId) {
    const token = /^Bearer ([a-f0-9]{64})$/i.exec(header || '')?.[1];
    const key = token && this.keys.get(digest(token));
    if (!this.valid(key)) {
      if (key) this.remove(key);
      throw httpError(401, 'Invalid or expired OBS stream token. Create a new token in the room.');
    }
    if (key.roomId !== roomId) throw httpError(403, 'This OBS stream token belongs to another room.');
    return key;
  }

  links(key) {
    return (this.rtcConfig(key.id).iceServers || []).flatMap(server => {
      const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
      return urls.map(url => `<${url}>; rel="ice-server"${server.username ?
        `; username=${JSON.stringify(server.username)}; credential=${JSON.stringify(server.credential)}; credential-type="password"` : ''}`);
    });
  }

  async publish(key, body) {
    if (!this.valid(key) || this.keys.get(key.id) !== key) throw httpError(401, 'OBS stream token was revoked.');
    this.tick();
    const offer = parseObsOffer(body);
    const room = this.rooms.get(key.roomId);
    const user = this.accounts.users.find(u => u.id === key.userId);
    const id = randomUUID();
    const ws = {id: `obs-${id}`};
    // Reserve before the first await. One publisher per room-scoped key.
    if ([...this.resources.values()].some(r => r.key === key)) throw httpError(409, 'This OBS token is already streaming.');
    this.resources.set(id, {key, ws});
    let answer;
    try {
      await this.desktop.start(room, ws, user, {requestId: id, transport: 'mediasoup'}, {h264Level: '2a', prepare: async session => {
        const transport = session.publisher.transport;
        session.item.title = `${user.displayName}’s OBS stream`;
        const tracks = offer.media.map(m => obsRtpParameters(m, session.router.rtpCapabilities));
        const first = offer.media[0];
        const fingerprint = first.fingerprint || offer.fingerprint;
        await transport.connect({dtlsParameters: {role: (first.setup || offer.setup) === 'passive' ? 'server' : 'client',
          fingerprints: [{algorithm: fingerprint.type, value: fingerprint.hash}]}});
        for (const [index, media] of offer.media.entries()) {
          this.desktop.active(session);
          await this.desktop.perform(session, session.publisher, {action: 'produce', kind: media.type, rtpParameters: tracks[index]});
        }
        if (!this.valid(key) || this.keys.get(key.id) !== key) throw httpError(401, 'OBS stream token was revoked.');
        // Leave room for Opus audio and transport overhead above the video ceiling.
        await transport.setMaxIncomingBitrate(desktopLimits.videoBitrate + 200_000);
        this.desktop.active(session);
        if (!this.valid(key) || this.keys.get(key.id) !== key) throw httpError(401, 'OBS stream token was revoked.');
        transport.on('dtlsstatechange', state => {
          if (state === 'connected' && this.desktop.sessions.get(ws.id) === session) {
            this.desktop.perform(session, session.publisher, {action: 'ready'}).catch(() => this.desktop.stop(ws));
          }
        });
        answer = obsAnswer(offer, transport, tracks);
      }});
      return {id, answer};
    } catch (error) {
      this.resources.delete(id);
      this.desktop.stop(ws);
      throw error;
    }
  }

  stop(key, id) {
    const resource = this.resources.get(id);
    if (!resource || resource.key !== key) throw httpError(404, 'OBS stream not found.');
    this.desktop.stop(resource.ws);
    this.resources.delete(id);
  }

  tick() {
    for (const key of this.keys.values()) if (!this.valid(key)) this.remove(key);
    for (const [id, resource] of this.resources) {
      if (!this.desktop.sessions.has(resource.ws.id)) this.resources.delete(id);
    }
  }
}

export function obsIngestRoutes(app, obs, {limit, clientIP}) {
  const identify = (req, res, next) => {
    res.set({'Cache-Control': 'no-store', 'WWW-Authenticate': 'Bearer realm="Helltube OBS"'});
    req.obsKey = obs.authenticate(req.headers.authorization, req.params.roomId);
    next();
  };
  const endpoint = '/api/whip/:roomId';
  app.options(endpoint, identify, (req, res) => {
    const links = obs.links(req.obsKey);
    if (links.length) res.set('Link', links.join(', '));
    res.set({'Allow': 'POST, GET, HEAD, OPTIONS', 'Accept-Post': 'application/sdp'}).status(200).end();
  });
  app.get(endpoint, identify, (_req, res) => res.status(204).end());
  app.post(endpoint, (req, _res, next) => { limit(`obs-ip:${clientIP(req)}`, 30); next(); }, identify,
    (req, _res, next) => {
      limit(`obs-start:${req.obsKey.userId}`, 12);
      if (!req.is('application/sdp')) throw httpError(415, 'Content-Type must be application/sdp.');
      next();
    }, express.text({type: 'application/sdp', limit: '64kb'}), async (req, res) => {
      const result = await obs.publish(req.obsKey, req.body);
      if (res.destroyed) { obs.stop(req.obsKey, result.id); return; }
      res.once('close', () => {
        if (!res.writableFinished) { try { obs.stop(req.obsKey, result.id); } catch { /* Already stopped. */ } }
      });
      const links = obs.links(req.obsKey);
      if (links.length) res.set('Link', links.join(', '));
      res.status(201).set('Location', `/api/whip/${encodeURIComponent(req.params.roomId)}/${result.id}`)
        .type('application/sdp').send(result.answer);
    });
  app.delete(`${endpoint}/:resourceId`, identify, (req, res) => {
    obs.stop(req.obsKey, req.params.resourceId);
    res.status(200).end();
  });
  app.get(`${endpoint}/:resourceId`, identify, (req, res) => {
    if (obs.resources.get(req.params.resourceId)?.key !== req.obsKey) throw httpError(404, 'OBS stream not found.');
    res.status(204).end();
  });
  // OBS uses a complete ICE-lite answer. Trickle PATCH and ICE restart are not supported.
  app.all(`${endpoint}/:resourceId`, identify, (_req, res) => res.set('Allow', 'DELETE, GET, HEAD').status(405).end());
  app.all(endpoint, identify, (_req, res) => res.set('Allow', 'POST, GET, HEAD, OPTIONS').status(405).end());
}
