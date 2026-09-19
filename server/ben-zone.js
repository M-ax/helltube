import { makeItem } from './rooms.js';
import { cartoonChannels, benZoneTracks } from './ben-zone-catalog.js';

export const BEN_ZONE_ID = 'the-ben-zone';

export class BenZone {
  constructor(rooms, youtube, media, { now = Date.now, random = Math.random,
    channels = cartoonChannels, tracks = benZoneTracks, cartoonMs = 10 * 60 * 1000,
    discoveryMs = 5 * 60 * 1000, maxSongSeconds = 360 } = {}) {
    Object.assign(this, { rooms, youtube, media, now, random, channels, tracks, cartoonMs, discoveryMs, maxSongSeconds });
    this.streams = [];
    this.bag = [];
    this.cacheUntil = 0;
    this.retryAt = 0;
    this.failures = 0;
    this.closed = false;
    this.onAdvance = (room, action) => {
      if (room.id !== BEN_ZONE_ID || !room.members.size || this.controller) return;
      if (action === 'next-cartoon') this.streamUntil = 0;
      this.clearCurrent(room);
      this.retryAt = 0;
      this.tick();
    };
    this.onDelete = room => { if (room.id === BEN_ZONE_ID) this.stop(room); };
    rooms.on('automation:advance', this.onAdvance);
    rooms.on('deleted', this.onDelete);
    const room = this.room();
    if (room) {
      // Retain any manually queued media from before this became an automatic channel.
      this.clearCurrent(room);
      room.automation = this.status('idle', 'Starts automatically when someone joins.');
      rooms.persist(room);
    }
  }

  room() { return this.rooms.rooms.get(BEN_ZONE_ID); }

  status(state, message) {
    return { type: 'ben-zone', state, message, channels: this.channels.map(channel => channel.name),
      tracks: this.tracks, cartoonIntervalSeconds: this.cartoonMs / 1000 };
  }

  publish(room, state, message) {
    room.automation = this.status(state, message);
    this.rooms.emit('state', room);
    this.rooms.emit('rooms');
  }

  clearCurrent(room) {
    if (room.current && !room.current.source.benZone) room.queue.unshift(room.current);
    room.current = null;
    room.resumeWhenReady = false;
    this.rooms.stamp(room, 0, true);
    for (const job of [...this.media.jobs.values()]) if (job.item.source?.benZone) this.media.dispose(job);
  }

  membershipChanged(room) {
    if (room.id !== BEN_ZONE_ID || this.closed) return;
    if (!room.members.size) this.stop(room);
    else this.tick();
  }

  stop(room = this.room()) {
    this.controller?.abort();
    this.controller = null;
    this.stream = null;
    this.streamUntil = 0;
    this.retryAt = 0;
    this.failures = 0;
    if (!room) return;
    this.clearCurrent(room);
    this.publish(room, 'idle', 'Starts automatically when someone joins.');
    if (this.room() === room) this.rooms.persist(room);
  }

  nextTrack() {
    if (!this.bag.length) {
      this.bag = [...this.tracks];
      for (let i = this.bag.length - 1; i > 0; i--) {
        const j = Math.floor(this.random() * (i + 1));
        [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
      }
      if (this.bag.length > 1 && this.bag.at(-1).url === this.lastTrack) this.bag.unshift(this.bag.pop());
    }
    const track = this.bag.pop();
    this.lastTrack = track?.url;
    return track;
  }

  tick() {
    const room = this.room();
    if (this.closed || !room || !room.members.size || this.controller) return;
    if (room.current?.source.benZone) {
      if (room.current.status !== 'error') {
        if (room.current.status === 'ready') {
          this.failures = 0;
          if (room.automation.state !== 'playing') this.publish(room, 'playing', 'Live cartoons. SoundCloud soundtrack.');
        }
        return;
      }
      if (room.current.automationFailure !== 'track') {
        this.streams = this.streams.filter(stream => stream.id !== this.stream?.id);
        this.streamUntil = 0;
      }
      this.clearCurrent(room);
      this.retry(room);
    }
    if (this.now() < this.retryAt) return;
    const controller = new AbortController();
    this.controller = controller;
    this.publish(room, 'discovering', 'Finding a live cartoon and the next track…');
    this.pending = this.start(room, controller).catch(() => {
      if (!controller.signal.aborted && this.room() === room && room.members.size) this.retry(room);
    }).finally(() => { if (this.controller === controller) this.controller = null; });
  }

  retry(room) {
    this.retryAt = this.now() + Math.min(60000, 5000 * 2 ** Math.min(this.failures++, 4));
    this.publish(room, 'waiting', 'No playable mix right now. Trying another stream or track shortly.');
    this.rooms.persist(room);
  }

  async start(room, controller) {
    const { signal } = controller;
    if (!this.stream || this.now() >= this.streamUntil) {
      if (this.now() >= this.cacheUntil || !this.streams.length) {
        const streams = await this.youtube.liveStreams(this.channels, { signal });
        signal.throwIfAborted();
        this.streams = streams;
        this.cacheUntil = this.now() + this.discoveryMs;
      }
      if (!this.streams.length) throw new Error('No cartoons are broadcasting live.');
      const differentChannel = this.streams.filter(stream => stream.channel !== this.stream?.channel);
      const differentStream = this.streams.filter(stream => stream.id !== this.stream?.id);
      const choices = differentChannel.length ? differentChannel : differentStream.length ? differentStream : this.streams;
      this.stream = choices[Math.floor(this.random() * choices.length)];
      this.streamUntil = this.now() + this.cartoonMs;
    }
    const track = this.nextTrack();
    if (!track) throw new Error('No soundtrack tracks configured.');
    signal.throwIfAborted();
    if (this.closed || this.room() !== room || !room.members.size) return;
    const stream = this.stream;
    const item = makeItem({ kind: 'youtube', url: stream.url, benZone: true, soundtrackUrl: track.url,
      maxDuration: this.maxSongSeconds, startAt: 0 }, {
      title: `${stream.channel} × ${track.title}`, thumbnail: stream.thumbnail, addedBy: 'The Ben Zone',
      live: true, cartoon: { title: stream.title, channel: stream.channel, url: stream.url }, soundtrack: track,
      duration: this.maxSongSeconds,
    });
    this.clearCurrent(room);
    room.current = item;
    room.resumeWhenReady = true;
    this.publish(room, 'preparing', 'Tuning in and replacing the cartoon audio…');
    this.rooms.changed(room);
    this.rooms.emit('rooms');
  }

  close() {
    this.closed = true;
    this.stop();
    this.rooms.off('automation:advance', this.onAdvance);
    this.rooms.off('deleted', this.onDelete);
    return this.pending;
  }
}
