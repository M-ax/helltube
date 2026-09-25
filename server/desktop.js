import {randomUUID, randomInt} from 'node:crypto';
import {makeItem} from './rooms.js';
import {httpError} from './config.js';
import {DesktopRelay, desktopRelayOptions} from './desktop-relay.js';

const MAX_SHARE_MS = 4 * 60 * 60 * 1000;
const validRequest = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const endpoint = (ws, requestId) => ({id: randomUUID(), ws, requestId, consumers: new Map(), queued: 0, chain: Promise.resolve()});
const transportOptions = transport => ({id: transport.id, iceParameters: transport.iceParameters,
  iceCandidates: transport.iceCandidates, dtlsParameters: transport.dtlsParameters});

// The authenticated WebSocket controls SFU resources. Encoded audio/video is
// uploaded to metal once and forwarded by mediasoup, without decoding or HLS.
export class DesktopShares {
  constructor(rooms, send, {rtcConfig = () => ({iceServers: []}), maxViewers = 50, now = Date.now, relay, config = {}} = {}) {
    Object.assign(this, {rooms, send, rtcConfig, maxViewers, now});
    this.sessions = new Map();
    this.relay = relay || new DesktopRelay(desktopRelayOptions(config), error => {
      for (const session of this.sessions.values()) this.stop(session.ws, error);
    });
    rooms.on('state', room => {
      for (const session of this.sessions.values()) {
        if (session.room !== room || session.starting) continue;
        if (session.external && room.current?.kind !== 'spotify') this.stop(session.ws);
        else if (!room.desktops.some(item => item.id === session.item.id)) this.stop(session.ws);
        else if (session.item.status === 'error') this.stop(session.ws, session.item.error);
      }
    });
    rooms.on('deleted', room => {
      for (const session of this.sessions.values()) if (session.room === room) this.stop(session.ws);
    });
  }

  active(session, peer) {
    if (this.closed || this.sessions.get(session.ws.id) !== session || peer?.closed) throw httpError(409, 'This desktop connection has ended.');
  }

  async start(room, ws, user, message, {prepare, h264Level} = {}) {
    this.rooms.requireManual(room);
    if (!validRequest(message.requestId)) throw httpError(400, 'Invalid sharing request.');
    if (message.transport !== 'mediasoup') throw httpError(400, 'Reload the page to use metal desktop sharing.');
    if (this.closed || this.sessions.has(ws.id)) {
      throw httpError(409, 'You are already sharing a desktop. Stop it before starting another.');
    }
    if (room.current && room.current.kind !== 'desktop' && !room.desktops.some(item => item.provider !== 'spotify') && room.queue.length >= this.rooms.maxQueue) throw httpError(409, 'The room queue is full.');
    const item = makeItem({kind: 'desktop'}, {
      title: user.displayName + '’s desktop', addedBy: user.displayName, sharedBy: user.id,
      sharedByUsername: user.username,
      status: 'ready', transport: 'mediasoup',
    });
    const session = {room, ws, item, requestId: message.requestId, started: this.now(), starting: true,
      publisher: endpoint(ws, message.requestId), producers: new Map(), viewers: new Map()};
    this.sessions.set(ws.id, session);
    try {
      const router = await this.relay.createRouter({h264Level});
      try { this.active(session); } catch (error) { router.close(); throw error; }
      session.router = router;
      await this.createTransport(session, session.publisher);
      if (prepare) await prepare(session);
      this.active(session);
      if (this.rooms.rooms.get(room.id) !== room) throw httpError(404, 'Room not found.');
      if (room.current?.kind !== 'desktop' && !room.desktops.some(item => item.provider !== 'spotify')) {
        if (room.current && room.queue.length >= this.rooms.maxQueue) throw httpError(409, 'The room queue is full.');
        if (room.current) {
          room.current.resumeAt = this.rooms.position(room);
          room.queue.unshift(room.current);
        }
        room.current = item;
        room.resumeWhenReady = false;
        this.rooms.stamp(room, 0, false);
      }
      room.desktops.push(item);
      session.starting = false;
      this.send(ws, {type: 'desktop:started', itemId: item.id, roomId: room.id, ...this.connection(session, session.publisher)});
      this.rooms.changed(room);
      this.rooms.emit('rooms');
    } catch (error) {
      if (this.sessions.get(ws.id) === session) this.stop(ws, 'The metal desktop relay could not start. Check its media address and port.');
      if (error.status) throw error;
      console.error('Desktop relay startup:', error.message);
      throw httpError(503, 'The metal desktop relay could not start. Check its media address and port.');
    }
  }

  connection(session, peer) {
    return {requestId: peer.requestId, peerId: peer.id, routerRtpCapabilities: session.router.rtpCapabilities,
      transportOptions: transportOptions(peer.transport), rtcConfig: this.rtcConfig(peer.ws.id)};
  }

  // Trusted server-side capture only. RTP stays on loopback; viewers use the
  // same authenticated WebRTC subscriptions as ordinary desktop shares.
  async prepareExternal(room, sourceItem) {
    const ws = {id: randomUUID()};
    const item = makeItem({kind: 'desktop'}, {id: sourceItem.id, title: `Spotify · ${sourceItem.title}`,
      addedBy: sourceItem.addedBy, status: 'ready', transport: 'mediasoup', provider: 'spotify'});
    const session = {room, ws, item, sourceItem, external: true, requestId: randomUUID(), started: this.now(), starting: true,
      publisher: endpoint(ws, randomUUID()), producers: new Map(), viewers: new Map()};
    this.sessions.set(ws.id, session);
    const check = () => {
      this.active(session);
      if (room.current !== sourceItem || !this.rooms.rooms.has(room.id)) throw httpError(409, 'Spotify playback changed.');
    };
    try {
      check();
      const router = await this.relay.createRouter({fullHd: true});
      session.router = router;
      check();
      const targets = {};
      for (const [kind, mimeType, payloadType] of [['video', 'video/H264', 102], ['audio', 'audio/opus', 111]]) {
        const transport = await router.createPlainTransport({listenInfo: {protocol: 'udp', ip: '127.0.0.1'},
          rtcpMux: false, comedia: true});
        check();
        const codec = router.rtpCapabilities.codecs.find(value => value.mimeType === mimeType &&
          (kind !== 'video' || value.parameters['profile-level-id'] === '42e028'));
        const ssrc = randomInt(1, 2147483647);
        const producer = await transport.produce({kind, rtpParameters: {
          codecs: [{mimeType, payloadType, clockRate: codec.clockRate,
            ...(codec.channels ? {channels: codec.channels} : {}), parameters: codec.parameters,
            rtcpFeedback: []}], encodings: [{ssrc}], rtcp: {cname: 'spotify-desktop'},
        }});
        check();
        session.producers.set(kind, producer);
        targets[kind] = {port: transport.tuple.localPort, rtcpPort: transport.rtcpTuple.localPort, ssrc};
      }
      return {session, targets};
    } catch (error) {
      this.stop(ws);
      session.router?.close(); // Also release a router that arrived after cancellation.
      throw error;
    }
  }

  activateExternal(session) {
    this.active(session);
    if (session.room.current !== session.sourceItem || !session.external) throw httpError(409, 'Spotify playback changed.');
    session.ready = true;
    session.starting = false;
    session.room.desktops.push(session.item);
    this.rooms.changed(session.room);
  }

  retargetExternal(session, sourceItem) {
    this.active(session);
    if (!session.external || !session.ready || session.room.current !== sourceItem || sourceItem.kind !== 'spotify') {
      throw httpError(409, 'Spotify playback changed.');
    }
    session.sourceItem = sourceItem;
    session.item.title = `Spotify · ${sourceItem.title}`;
    session.item.addedBy = sourceItem.addedBy;
  }

  async createTransport(session, peer) {
    const transport = await this.relay.createTransport(session.router);
    try { this.active(session, peer); } catch (error) { transport.close(); throw error; }
    peer.transport = transport;
    transport.on('dtlsstatechange', state => {
      if (peer.transport !== transport) return;
      if (state !== 'failed' && state !== 'closed') return;
      this.failPeer(session, peer, 'The connection to the metal desktop relay was lost.');
    });
    transport.on('icestatechange', state => {
      if (peer.transport !== transport) return;
      clearTimeout(peer.disconnectTimer);
      if (state === 'disconnected') peer.disconnectTimer = setTimeout(() =>
        this.failPeer(session, peer, 'The connection to the metal desktop relay timed out.'), 15000);
    });
    return transport;
  }

  current(room, itemId) {
    const session = [...this.sessions.values()].find(value => value.room === room && value.item.id === itemId);
    if (!session || session.starting || !room.desktops.some(item => item.id === itemId)) throw httpError(409, 'This desktop share has ended.');
    return session;
  }

  async watch(room, ws, message) {
    if (!validRequest(message.requestId)) throw httpError(400, 'Invalid viewing request.');
    const session = this.current(room, message.itemId);
    if (session.ws === ws) throw httpError(409, 'The sharer uses a local preview.');
    this.unwatch(ws, undefined, session.item.id);
    if (session.viewers.size >= this.maxViewers) throw httpError(409, 'This desktop share has reached its viewer limit.');
    const peer = endpoint(ws, message.requestId);
    session.viewers.set(peer.id, peer);
    try {
      await this.createTransport(session, peer);
      this.active(session, peer);
      this.send(ws, {type: 'desktop:watching', itemId: session.item.id, ...this.connection(session, peer),
        producers: session.ready ? this.producerList(session) : []});
    } catch (error) {
      this.closePeer(peer);
      session.viewers.delete(peer.id);
      if (error.status) throw error;
      throw httpError(503, 'The metal desktop relay could not create your connection.');
    }
  }

  producerList(session) {
    return [...session.producers.values()].map(producer => ({id: producer.id, kind: producer.kind}));
  }

  async request(room, ws, message) {
    if (!validRequest(message.rpcId)) throw httpError(400, 'Invalid desktop relay request.');
    const session = this.current(room, message.itemId);
    const peer = session.publisher.ws === ws ? session.publisher : session.viewers.get(message.peerId);
    if (!peer || peer.ws !== ws || peer.id !== message.peerId || peer.requestId !== message.requestId || peer.closed) {
      throw httpError(403, 'Desktop connection is not authorized.');
    }
    if (peer.queued >= 16) throw httpError(429, 'Too many pending desktop relay requests.');
    peer.queued++;
    const task = peer.chain.then(async () => {
      this.active(session, peer);
      const data = await this.perform(session, peer, message);
      this.active(session, peer);
      this.send(ws, {type: 'desktop:response', requestId: peer.requestId, rpcId: message.rpcId, data});
    });
    peer.chain = task.catch(() => {});
    try { await task; }
    catch (error) {
      if (error.status) throw error;
      throw httpError(400, 'The desktop relay could not complete the media request.');
    } finally { peer.queued--; }
  }

  async perform(session, peer, message) {
    const publishing = peer === session.publisher;
    switch (message.action) {
      case 'connect':
        await peer.transport.connect({dtlsParameters: message.dtlsParameters});
        return {};
      case 'restart-ice':
        return {iceParameters: await peer.transport.restartIce()};
      case 'retry-video': {
        const maxRetries = session.router.rtpCapabilities.codecs.filter(codec => /^video\/(h264|vp8)$/i.test(codec.mimeType)).length - 1;
        if (!publishing || session.ready || session.producers.size || (peer.videoRetries || 0) >= maxRetries) {
          throw httpError(409, 'Video codec retry is only available before publishing and within the codec limit.');
        }
        peer.videoRetries = (peer.videoRetries || 0) + 1;
        const previous = peer.transport;
        peer.transport = null;
        clearTimeout(peer.disconnectTimer);
        previous.close();
        await this.createTransport(session, peer);
        return transportOptions(peer.transport);
      }
      case 'produce': {
        if (!publishing || !['video', 'audio'].includes(message.kind) || session.producers.has(message.kind)) {
          throw httpError(403, 'Only the sharer can publish one video and one audio track.');
        }
        if (!Array.isArray(message.rtpParameters?.encodings) || message.rtpParameters.encodings.length !== 1) {
          throw httpError(400, 'Desktop sharing requires a single encoding per track.');
        }
        const producer = await peer.transport.produce({kind: message.kind, rtpParameters: message.rtpParameters});
        try { this.active(session, peer); } catch (error) { producer.close(); throw error; }
        session.producers.set(producer.kind, producer);
        return {id: producer.id};
      }
      case 'ready':
        if (!publishing || !session.producers.has('video')) throw httpError(409, 'Publish desktop video first.');
        session.ready = true;
        for (const viewer of session.viewers.values()) {
          if (viewer.transport) this.send(viewer.ws, {type: 'desktop:available', requestId: viewer.requestId,
            itemId: session.item.id, producers: this.producerList(session)});
        }
        return {};
      case 'consume': {
        if (publishing || !session.ready) throw httpError(409, 'The desktop is not ready to watch.');
        const producer = [...session.producers.values()].find(value => value.id === message.producerId);
        if (!producer || !session.router.canConsume({producerId: producer.id, rtpCapabilities: message.rtpCapabilities})) {
          throw httpError(400, 'This desktop track cannot be played in your browser.');
        }
        // A lost reply or failed browser negotiation can retry without leaking
        // another consumer or replacing the already-playing audio transport.
        const existing = [...peer.consumers.values()].find(value => value.producerId === producer.id);
        if (existing) return {id: existing.id, producerId: producer.id, kind: existing.kind, rtpParameters: existing.rtpParameters};
        const consumer = await peer.transport.consume({producerId: producer.id, rtpCapabilities: message.rtpCapabilities, paused: true});
        try { this.active(session, peer); } catch (error) { consumer.close(); throw error; }
        peer.consumers.set(consumer.id, consumer);
        consumer.on('producerclose', () => {
          peer.consumers.delete(consumer.id);
          if (!peer.closed) this.send(peer.ws, {type: 'desktop:producer-closed', requestId: peer.requestId, producerId: producer.id});
        });
        return {id: consumer.id, producerId: producer.id, kind: consumer.kind, rtpParameters: consumer.rtpParameters};
      }
      case 'resume': {
        const consumer = peer.consumers.get(message.consumerId);
        if (publishing || !consumer) throw httpError(403, 'Desktop track is not authorized.');
        await consumer.resume();
        return {};
      }
      case 'pause-video': {
        const consumer = peer.consumers.get(message.consumerId);
        if (publishing || consumer?.kind !== 'video') throw httpError(403, 'Desktop video track is not authorized.');
        // Pause this viewer's forwarding, never the producer or audio consumer.
        await consumer.pause();
        return {};
      }
      case 'close-producer': {
        const producer = session.producers.get('audio');
        if (!publishing || !producer || producer.id !== message.producerId) throw httpError(403, 'Desktop track is not authorized.');
        session.producers.delete('audio');
        producer.close();
        return {};
      }
      default: throw httpError(400, 'Unknown desktop relay action.');
    }
  }

  closePeer(peer) {
    peer.closed = true;
    clearTimeout(peer.disconnectTimer);
    peer.transport?.close();
    peer.consumers.clear();
  }

  failPeer(session, peer, error) {
    if (peer.closed || this.sessions.get(session.ws.id) !== session) return;
    if (peer === session.publisher) this.stop(session.ws, error);
    else {
      this.closePeer(peer);
      session.viewers.delete(peer.id);
      this.send(peer.ws, {type: 'desktop:error', requestId: peer.requestId, message: error});
    }
  }

  unwatch(ws, requestId, itemId) {
    for (const session of this.sessions.values()) {
      if (itemId && session.item.id !== itemId) continue;
      for (const [peerId, viewer] of session.viewers) {
        if (viewer.ws !== ws || (requestId && viewer.requestId !== requestId)) continue;
        this.closePeer(viewer);
        session.viewers.delete(peerId);
      }
    }
  }

  leave(ws) { this.unwatch(ws); this.stop(ws); }

  stop(ws, error = '') {
    const session = this.sessions.get(ws.id);
    if (!session) return;
    this.sessions.delete(ws.id);
    this.closePeer(session.publisher);
    for (const viewer of session.viewers.values()) {
      this.closePeer(viewer);
      this.send(viewer.ws, {type: 'desktop:stopped', requestId: viewer.requestId, itemId: session.item.id, message: error});
    }
    session.viewers.clear();
    session.producers.clear();
    session.router?.close();
    this.send(ws, {type: 'desktop:stopped', requestId: session.requestId, itemId: session.item.id, message: error});
    const room = session.room;
    const included = room.desktops.some(item => item.id === session.item.id);
    room.desktops = room.desktops.filter(item => item.id !== session.item.id);
    if (this.rooms.rooms.has(room.id) && included) {
      if (session.external) this.rooms.changed(room);
      else if (!room.desktops.length && room.current?.id === session.item.id) this.rooms.advance(room);
      else {
        if (room.current?.id === session.item.id) room.current = room.desktops[0];
        this.rooms.changed(room);
        this.rooms.emit('rooms');
      }
    }
  }

  tick() {
    for (const session of this.sessions.values()) {
      if (!session.ready && this.now() - session.started > 30000) this.stop(session.ws, 'The desktop could not connect to metal. Check the media port or TURN configuration.');
      else if (this.now() - session.started > MAX_SHARE_MS) this.stop(session.ws, 'The four-hour sharing limit was reached. Start a new share to continue.');
    }
  }

  async close() {
    this.closed = true;
    for (const session of this.sessions.values()) this.stop(session.ws);
    await this.relay.close();
  }
}
