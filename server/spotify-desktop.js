import {spotifyLink} from '../shared/media-source.js';
import {httpError} from './config.js';
import {SpotifyDesktopBridge} from './spotify-desktop-bridge.js';

export function spotifyDesktopUri(url) {
  const link = spotifyLink(url);
  return `spotify:${link.type}:${new URL(link.url).pathname.split('/').at(-1)}`;
}

function matches(uri, value) {
  if (uri === value) return true;
  try { return spotifyDesktopUri(value) === uri; } catch { return false; }
}

// One VM/account has one owner room at a time. Other rooms wait; queue entries
// remain Spotify entries so skipping, history, and restart persistence work.
export class SpotifyDesktop {
  constructor(rooms, desktop, config, {bridge = new SpotifyDesktopBridge(config), now = Date.now} = {}) {
    Object.assign(this, {rooms, desktop, bridge, now});
    this.enabled = !!config.spotifyDesktopKey;
    rooms.spotifyDesktopEnabled = this.enabled;
    this.active = null;
    this.retryAt = 0;
    this.onState = room => {
      const active = this.active;
      if (active?.room === room && !this.owns(active) && active.session) this.desktop.stop(active.session.ws);
    };
    rooms.on('state', this.onState);
  }

  start() {
    if (!this.enabled || this.timer) return;
    this.rooms.spotifyDesktopEnabled = true;
    this.timer = setInterval(() => { void this.tick(); }, 1000);
    this.timer.unref();
    void this.tick();
  }

  state(room, state, message) {
    const next = {state, message};
    if (JSON.stringify(next) === JSON.stringify(room.spotifyDesktop)) return;
    room.spotifyDesktop = next;
    this.rooms.emit('state', room);
  }

  owns(active = this.active) {
    return !this.closed && active && this.rooms.rooms.get(active.room.id) === active.room &&
      active.room.current === active.item && active.room.members.size > 0;
  }

  async stop() {
    const active = this.active;
    this.active = null;
    if (active?.session) this.desktop.stop(active.session.ws);
    if (active) await this.bridge.request('stop').catch(() => {});
  }

  tick() {
    if (!this.enabled || this.closed) return Promise.resolve();
    if (this.work) return this.work;
    this.work = (async () => {
      try { await this.poll(); }
      catch {
        const room = this.active?.room;
        await this.stop();
        this.retryAt = this.now() + 10000;
        if (!this.closed && room?.current?.kind === 'spotify') this.state(room, 'error', 'The Spotify desktop could not start playback. Check its private console; retrying shortly.');
      }
    })().finally(() => { this.work = null; });
    return this.work;
  }

  async poll() {
    if (this.active && !this.owns()) await this.stop();
    const candidates = [...this.rooms.rooms.values()].filter(room => room.current?.kind === 'spotify' && room.members.size);
    for (const room of this.rooms.rooms.values()) {
      if (room.current?.kind !== 'spotify' && room.spotifyDesktop) delete room.spotifyDesktop;
    }
    if (!candidates.length || this.closed) return;
    const owner = this.active?.room || candidates[0];
    for (const room of candidates) {
      if (room !== owner) this.state(room, 'busy', 'The Spotify desktop is playing in another room. Waiting for it to finish.');
    }
    if (this.now() < this.retryAt) return;
    let status;
    try { status = await this.bridge.request('status'); }
    catch {
      await this.stop();
      this.state(owner, 'offline', 'The Spotify desktop is offline. Waiting for it to reconnect.');
      this.retryAt = this.now() + 5000;
      return;
    }
    if (this.closed) return;
    if (!status.enabled || !status.available) {
      await this.stop();
      this.state(owner, 'disabled', 'Sign into Spotify and enable Helltube sharing on the private desktop.');
      return;
    }
    if (!this.active) {
      if (owner.current?.kind !== 'spotify' || !owner.members.size) return;
      const item = owner.current;
      this.active = {room: owner, item, uri: spotifyDesktopUri(item.source.url), phase: 'opening', started: this.now()};
      this.state(owner, 'starting', 'Opening Spotify on the shared desktop…');
      await this.bridge.request('open', {uri: this.active.uri});
      return;
    }
    const active = this.active;
    if (!this.owns(active)) { await this.stop(); return; }
    const single = /^spotify:(track|episode):/.test(active.uri);
    if (active.phase === 'opening') {
      if (!status.url || (single && !matches(active.uri, status.url))) {
        if (this.now() - active.started > 30000) throw new Error('Spotify did not open the requested item.');
        return;
      }
      const {session, targets} = await this.desktop.prepareExternal(active.room, active.item);
      active.session = session;
      if (!this.owns(active)) { await this.stop(); return; }
      await this.bridge.request('capture', targets);
      active.phase = 'capturing';
      active.started = this.now();
      return;
    }
    if (!status.capturing || !this.desktop.sessions.has(active.session.ws.id)) throw new Error('Capture ended.');
    const stats = await Promise.all([...active.session.producers.values()].map(producer => producer.getStats()));
    if (!this.owns(active)) { await this.stop(); return; }
    const packets = stats.map(reports => reports.reduce((count, report) => count + (report.packetCount || 0), 0));
    if (active.phase === 'capturing') {
      if (!packets.every(count => count > 0)) {
        if (this.now() - active.started > 15000) throw new Error('No desktop media received.');
        return;
      }
      active.phase = 'sharing';
      this.desktop.activateExternal(active.session);
      this.state(active.room, 'sharing', 'Playing from the shared Spotify desktop.');
    }
    if (packets.some((count, index) => count !== active.packets?.[index])) active.lastMedia = this.now();
    active.packets = packets;
    if (this.now() - active.lastMedia > 10000) throw new Error('Desktop media stopped.');
    if (single && status.url && !matches(active.uri, status.url)) {
      await this.stop();
      if (active.room.current === active.item) this.rooms.advance(active.room);
      return;
    }
    const paused = status.playback !== 'Playing';
    if (active.room.playback.paused !== paused) {
      this.rooms.stamp(active.room, this.rooms.position(active.room), paused);
      this.rooms.emit('state', active.room);
    }
  }

  async control(room, message) {
    if (!this.enabled || room.current?.kind !== 'spotify' || !['play', 'pause'].includes(message.action)) return false;
    if (message.revision !== room.playback.revision) throw httpError(409, 'Playback changed. Please try again.');
    const active = this.active;
    if (active?.room !== room || active.phase !== 'sharing') throw httpError(409, 'The shared Spotify desktop is not ready.');
    await this.bridge.request(message.action);
    if (this.active === active && this.owns(active)) {
      this.rooms.stamp(room, this.rooms.position(room), message.action === 'pause');
      this.rooms.changed(room);
    }
    return true;
  }

  async close() {
    this.closed = true;
    this.rooms.off('state', this.onState);
    clearInterval(this.timer);
    await this.work;
    await this.stop();
    this.bridge.close();
  }
}
