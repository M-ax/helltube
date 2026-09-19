import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { httpError, text } from './config.js';
import { sponsorPosition } from '../shared/sponsorblock.js';
import { sourceKind, spotifyLink } from '../shared/media-source.js';
import { roomNowPlayingTitle } from '../shared/room-title.js';

export function makeItem(source, extra = {}) {
  return { id: randomUUID(), title: 'Untitled video', duration: null, thumbnail: null,
    addedBy: '', kind: source.kind, source, playlistId: null, playlistTitle: null,
    startAt: 0, status: 'queued', error: null, media: null, ...extra };
}

export class Rooms extends EventEmitter {
  constructor({ now = Date.now, maxQueue = 500, maxRooms = 30, store } = {}) {
    super();
    this.now = now;
    this.maxQueue = maxQueue;
    this.maxRooms = maxRooms;
    this.store = store;
    this.saved = new Map();
    this.rooms = new Map();
    for (const saved of store?.load('rooms') || []) {
      const room = { ownerId: null, ...saved, desktops: [], members: new Map() };
      for (const item of [room.current, ...room.queue, ...room.history].filter(Boolean)) {
        item.media = null;
        item.preparation = null;
        if (item.status !== 'error') item.status = item.kind === 'spotify' ? 'ready' : item.kind === 'upload' && !item.source.complete ? 'uploading' : 'queued';
        item.source.startAt = item.startAt || 0;
      }
      room.resumeWhenReady = !saved.playback.paused || saved.resumeWhenReady;
      room.playback = { ...saved.playback, paused: true, updatedAt: this.now(), revision: saved.playback.revision + 1 };
      if (room.current) room.current.source.startAt = room.playback.position;
      this.rooms.set(room.id, room);
    }
    if (!this.rooms.size && !store?.load('settings').some(setting => setting.id === 'rooms-initialized')) this.create('The living room', 'lobby');
    store?.save('settings', 'rooms-initialized', { id: 'rooms-initialized' });
  }

  persist(room) {
    if (!this.store) return;
    // Live captures cannot survive a restart and must not appear in history.
    // Persist the interrupted video/queue as the resumable room instead.
    if (room.current?.kind === 'desktop') {
      const current = room.queue[0] || null;
      room = {...room, current, queue: room.queue.slice(1), resumeWhenReady: !!current,
        playback: {...room.playback, paused: true, position: current?.resumeAt ?? current?.startAt ?? 0}};
    }
    const itemState = item => item ? { ...item, media: null, preparation: null } : null;
    const state = { id: room.id, name: room.name, ownerId: room.ownerId, current: itemState(room.current),
      queue: room.queue.map(itemState), history: room.history.map(itemState), version: room.version,
      resumeWhenReady: room.resumeWhenReady,
      playback: { ...room.playback, position: this.position(room),
        updatedAt: room.playback.paused ? room.playback.updatedAt : this.now() } };
    const serialized = JSON.stringify(state);
    if (this.saved.get(room.id) === serialized) return;
    this.store.save('rooms', room.id, state);
    if (!this.store.inTransaction) this.saved.set(room.id, serialized);
  }

  checkpoint() {
    if (!this.store) return;
    this.store.transaction(() => {
      for (const room of this.rooms.values()) this.persist(room);
    });
  }

  create(name, id = randomUUID(), ownerId = null) {
    if (this.rooms.size >= this.maxRooms) throw httpError(409, 'Room limit reached.');
    const room = { id, ownerId, name: text(name, 'Room name', 50), members: new Map(), current: null,
      desktops: [], queue: [], history: [], playback: { paused: true, position: 0, updatedAt: this.now(), revision: 0 },
      version: 0, resumeWhenReady: false };
    this.rooms.set(id, room);
    this.persist(room);
    this.emit('rooms');
    return room;
  }

  get(id) {
    const room = this.rooms.get(id);
    if (!room) throw httpError(404, 'Room not found.');
    return room;
  }

  manage(id, user) {
    const room = this.get(id);
    if (user.role !== 'admin' && room.ownerId !== user.id) throw httpError(403, 'Only the room owner or an administrator can manage this room.');
    return room;
  }

  rename(id, name, user) {
    const room = this.manage(id, user);
    const draft = { ...room, name: text(name, 'Room name', 50), version: room.version + 1 };
    this.persist(draft);
    Object.assign(room, draft);
    this.emit('state', room);
    this.emit('rooms');
    return this.snapshot(room);
  }

  remove(id, user) {
    const room = this.manage(id, user);
    this.store?.delete('rooms', id);
    this.rooms.delete(id);
    this.saved.delete(id);
    this.emit('deleted', room);
    room.members.clear();
    this.emit('rooms');
    this.emit('prepare');
  }

  position(room) {
    return sponsorPosition(room.current, room.playback.position,
      room.playback.paused ? 0 : Math.max(0, (this.now() - room.playback.updatedAt) / 1000));
  }

  stamp(room, position = this.position(room), paused = room.playback.paused) {
    room.playback = { position, paused, updatedAt: this.now(), revision: room.playback.revision + 1 };
  }

  changed(room) {
    room.version++;
    this.persist(room);
    this.emit('state', room);
    this.emit('prepare', room);
  }

  add(room, items, insertAt = room.queue.length, persistItems = () => {}) {
    if (this.get(room.id) !== room) throw httpError(404, 'Room not found.');
    if (!Number.isInteger(insertAt) || insertAt < 0 || insertAt > room.queue.length) {
      throw httpError(400, 'Invalid queue insertion position.');
    }
    if (!items.length) throw httpError(400, 'No playable videos were found.');
    if (room.queue.length + items.length > this.maxQueue) throw httpError(409, 'The room queue is full.');
    const draft = { ...room, queue: [...room.queue], version: room.version + 1 };
    draft.queue.splice(insertAt, 0, ...items);
    const starting = !room.current;
    if (starting) {
      draft.current = draft.queue.shift();
      draft.resumeWhenReady = true;
      this.stamp(draft, sponsorPosition(draft.current, draft.current.startAt || 0), true);
    }
    const save = () => { persistItems(); this.persist(draft); };
    if (this.store) this.store.transaction(save);
    else save();
    Object.assign(room, draft);
    if (starting && (room.current.source.startAt || 0) !== room.playback.position) {
      this.emit('seek', room, room.playback.position);
    }
    this.emit('state', room);
    this.emit('prepare', room);
    if (starting) this.emit('rooms');
  }

  advance(room) {
    // Consecutive Spotify entries share one VM capture and the same subscriptions.
    room.desktops = this.spotifyDesktopEnabled && room.current?.kind === 'spotify' && room.queue[0]?.kind === 'spotify'
      ? room.desktops.filter(item => item.provider === 'spotify') : [];
    if (room.current && room.current.kind !== 'desktop') room.history = [room.current, ...room.history.filter(i => i.id !== room.current.id)].slice(0, 5);
    room.current = room.queue.shift() || null;
    room.resumeWhenReady = !!room.current;
    this.stamp(room, sponsorPosition(room.current, room.current?.resumeAt ?? room.current?.startAt ?? 0), true);
    if (room.current) delete room.current.resumeAt;
    if (room.current && (room.current.source.startAt || 0) !== room.playback.position) {
      this.emit('seek', room, room.playback.position);
    }
    this.changed(room);
    this.emit('rooms');
  }

  replay(room, itemId) {
    if (room.current?.kind === 'desktop') throw httpError(409, 'Stop desktop sharing before playing a video from history.');
    const index = room.history.findIndex(i => i.id === itemId);
    if (index < 0) throw httpError(404, 'This video is no longer in the recent history.');
    const [item] = room.history.splice(index, 1);
    if (room.current) room.queue.unshift(room.current);
    room.current = item;
    room.resumeWhenReady = true;
    this.stamp(room, sponsorPosition(item, item.startAt || 0), true);
    this.emit('seek', room, room.playback.position);
    this.changed(room);
    this.emit('rooms');
  }

  control(room, message) {
    if (message.revision !== room.playback.revision) throw httpError(409, 'Playback changed. Please try again.');
    const { action } = message;
    if (action === 'skip') return this.advance(room);
    if (room.current?.kind === 'desktop') throw httpError(409, 'Desktop sharing is live. Stop or skip the share to return to videos.');
    if (action === 'previous') {
      if (!room.history.length) throw httpError(409, 'No previous video yet.');
      return this.replay(room, room.history[0].id);
    }
    if (!room.current) throw httpError(409, 'Add a video first.');
    if (room.current.kind === 'spotify') throw httpError(409, 'Use the Spotify player on your device. Skip advances the shared queue.');
    if (action === 'play') {
      room.resumeWhenReady = true;
      this.stamp(room, this.position(room), !this.canPlay(room));
    } else if (action === 'pause') {
      room.resumeWhenReady = false;
      this.stamp(room, this.position(room), true);
    } else if (action === 'seek') {
      let position = message.position;
      if (!Number.isFinite(position) || position < 0 || (room.current.duration && position > room.current.duration)) {
        throw httpError(400, 'Invalid seek position.');
      }
      position = sponsorPosition(room.current, position);
      const media = room.current.media;
      const outside = !media || position < media.baseTime || position > media.bufferedUntil - 1;
      if (outside && room.current.kind === 'upload' && !room.current.source.complete) {
        throw httpError(409, 'That part has not arrived from the uploader yet.');
      }
      const resume = !room.playback.paused || room.resumeWhenReady;
      this.stamp(room, position, outside || !resume);
      room.resumeWhenReady = resume;
      if (outside) this.emit('seek', room, position);
    } else {
      throw httpError(400, 'Unknown playback action.');
    }
    this.changed(room);
  }

  canPlay(room) {
    const item = room.current;
    const media = item?.media;
    const position = this.position(room);
    return !!media && item.status === 'ready' && position >= media.baseTime &&
      (media.complete || media.bufferedUntil - position >= 4);
  }

  mutateQueue(room, message) {
    const index = room.queue.findIndex(i => i.id === message.itemId);
    if (message.type === 'queue:remove-playlist') {
      if (!message.playlistId || !room.queue.some(i => i.playlistId === message.playlistId)) {
        throw httpError(404, 'Playlist not found in queue.');
      }
      room.queue = room.queue.filter(i => i.playlistId !== message.playlistId);
    } else {
      if (index < 0) throw httpError(404, 'Queue item not found.');
      if (message.type === 'queue:remove') room.queue.splice(index, 1);
      else if (message.type === 'queue:move') {
        if (!Number.isInteger(message.toIndex) || message.toIndex < 0 || message.toIndex >= room.queue.length) {
          throw httpError(400, 'Invalid queue position.');
        }
        const [item] = room.queue.splice(index, 1);
        room.queue.splice(message.toIndex, 0, item);
      } else throw httpError(400, 'Unknown queue action.');
    }
    this.changed(room);
  }

  tick() {
    for (const room of this.rooms.values()) {
      const item = room.current;
      if (['desktop', 'spotify'].includes(item?.kind)) {
        this.persist(room);
        this.emit('state', room);
        continue;
      }
      const elapsed = room.playback.paused ? 0 : Math.max(0, (this.now() - room.playback.updatedAt) / 1000);
      const position = sponsorPosition(item, room.playback.position, elapsed);
      const linearPosition = room.playback.position + elapsed;
      const skipped = position > linearPosition;
      const sponsorEnd = item?.kind === 'youtube' && item.sponsorSegments?.at(-1)?.[1];
      if (item?.duration > 0 && sponsorEnd >= item.duration && position >= item.duration &&
        (!room.playback.paused || room.resumeWhenReady)) {
        this.advance(room);
        continue;
      }
      if (skipped) {
        const media = item.media;
        const outside = !media || position < media.baseTime || position > media.bufferedUntil - 1;
        const resume = !room.playback.paused || room.resumeWhenReady;
        room.resumeWhenReady = resume;
        this.stamp(room, position, outside || !resume);
        if (outside) {
          this.emit('seek', room, position);
          this.emit('prepare', room);
        }
      }
      if (item?.media?.complete && !room.playback.paused && position >= (item.duration || item.media.bufferedUntil)) {
        this.advance(room);
        continue;
      }
      if (item && !room.playback.paused && !item.media?.complete && position >= (item.media?.bufferedUntil || 0) - 0.75) {
        room.resumeWhenReady = true;
        this.stamp(room, Math.max(0, Math.min(position, (item.media?.bufferedUntil || 0) - 0.75)), true);
      } else if (room.playback.paused && room.resumeWhenReady && this.canPlay(room)) {
        this.stamp(room, position, false);
      }
      this.persist(room);
      this.emit('state', room);
    }
  }

  list() {
    return [...this.rooms.values()].map(room => ({ id: room.id, name: room.name, ownerId: room.ownerId,
      memberCount: new Set([...room.members.values()].map(u => u.id)).size,
      currentTitle: roomNowPlayingTitle(room), currentKind: room.current?.kind || null }));
  }

  snapshot(room) {
    const expose = item => {
      if (!item) return null;
      const { source, ...safe } = item;
      return { ...safe, ...(item.kind === 'spotify' ? {embed: spotifyLink(source.url).embed} : {}),
        hasOriginalStream: item.kind !== 'upload' && !!sourceKind(source?.url) };
    };
    return { id: room.id, name: room.name, ownerId: room.ownerId, version: room.version,
      members: [...new Map([...room.members.values()].map(u => [u.id, { id: u.id, displayName: u.displayName }])).values()],
      current: expose(room.current), desktops: room.desktops.map(expose), queue: room.queue.map(expose), history: room.history.map(expose),
      preparation: room.preparations?.values().next().value || null,
      ...(room.current?.kind === 'spotify' && this.spotifyDesktopEnabled ? {
        spotifyDesktop: room.spotifyDesktop || {state: 'starting', message: 'Connecting to the shared Spotify desktop…'},
      } : {}),
      playback: { ...room.playback } };
  }

  allItems() {
    return [...this.rooms.values()].flatMap(r => [r.current, ...r.queue, ...r.history].filter(Boolean));
  }
}
