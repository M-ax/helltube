import test from 'node:test';
import assert from 'node:assert/strict';
import {Rooms, makeItem} from '../server/rooms.js';
import {DesktopShares} from '../server/desktop.js';
import {DesktopRelay, desktopRelayOptions} from '../server/desktop-relay.js';
import {SpotifyDesktop, spotifyDesktopUri} from '../server/spotify-desktop.js';

const trackUrl = 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC';
const spotifyItem = () => makeItem({kind: 'spotify', url: trackUrl}, {title: 'Spotify test', status: 'ready'});

test('Spotify desktop URIs normalize official links and reject unrelated destinations', () => {
  assert.equal(spotifyDesktopUri(trackUrl + '?si=example'), 'spotify:track:4uLU6hMCjMI75M1A2tKUQC');
  for (const url of ['http://127.0.0.1/', 'https://open.spotify.com.evil.test/track/4uLU6hMCjMI75M1A2tKUQC', 'file:///etc/passwd']) {
    assert.throws(() => spotifyDesktopUri(url));
  }
});

test('VM capture uses loopback transports and preserves the Spotify queue and history', async t => {
  const rooms = new Rooms();
  const room = rooms.get('lobby');
  const desktop = new DesktopShares(rooms, () => {}, {config: {desktopPort: 0}});
  t.after(() => desktop.close());
  const item = spotifyItem();
  const next = makeItem({kind: 'http', url: 'https://example.com/next.mp4'});
  rooms.add(room, [item, next]);
  const {session, targets} = await desktop.prepareExternal(room, item);
  assert.equal(session.producers.size, 2);
  assert.equal(session.producers.get('video').rtpParameters.codecs[0].parameters['profile-level-id'], '42e028',
    '1080p capture is advertised as H.264 level 4.0');
  assert.deepEqual(room.desktops, [], 'Capture is hidden until media arrives');
  assert.ok(targets.video.port > 0 && targets.audio.port > 0);
  assert.notEqual(targets.video.ssrc, targets.audio.ssrc);
  desktop.activateExternal(session);
  assert.equal(room.current, item);
  assert.deepEqual(room.queue, [next]);
  assert.equal(room.desktops[0].id, item.id);
  assert.equal(rooms.snapshot(room).current.kind, 'spotify');
  await desktop.watch(room, {id: 'viewer'}, {requestId: 'watch-vm', itemId: item.id});
  assert.equal(session.viewers.size, 1);
  desktop.stop(session.ws);
  assert.equal(room.current, item, 'Disconnect does not silently skip the requested song');
  assert.deepEqual(room.history, []);
  assert.ok(session.router.closed);
  const restarted = await desktop.prepareExternal(room, item);
  desktop.activateExternal(restarted.session);
  rooms.advance(room);
  assert.equal(room.current, next);
  assert.equal(room.history[0], item);
  assert.equal(desktop.sessions.size, 0);
});

test('cancelling VM startup closes a router that arrives late', async t => {
  const rooms = new Rooms();
  const relay = new DesktopRelay(desktopRelayOptions({desktopPort: 0}));
  const router = await relay.createRouter();
  let release;
  const desktop = new DesktopShares(rooms, () => {}, {relay: {
    createRouter: () => new Promise(resolve => { release = resolve; }), close: () => relay.close(),
  }});
  t.after(() => desktop.close());
  const room = rooms.get('lobby'), item = spotifyItem();
  rooms.add(room, [item]);
  const pending = desktop.prepareExternal(room, item);
  desktop.stop([...desktop.sessions.values()][0].ws);
  release(router);
  await assert.rejects(pending, /ended/);
  assert.equal(router.closed, true);
});

function fixture(t) {
  const rooms = new Rooms();
  const room = rooms.get('lobby');
  room.members.set('viewer', {id: 'viewer'});
  const item = spotifyItem();
  rooms.add(room, [item]);
  const calls = [];
  const status = {enabled: false, available: true, playback: 'Stopped', url: '', capturing: false};
  let packets = 1, now = 1000;
  const bridge = {
    async request(action, data) {
      calls.push({action, data});
      if (action === 'status') return {...status};
      if (action === 'open') { status.url = data.uri; status.playback = 'Playing'; }
      if (action === 'capture') status.capturing = true;
      if (action === 'stop') status.capturing = false;
      if (action === 'pause') status.playback = 'Paused';
      if (action === 'play') status.playback = 'Playing';
      return {};
    },
    close() {},
  };
  const desktop = {
    sessions: new Map(),
    async prepareExternal(target, source) {
      const session = {ws: {id: source.id}, room: target, sourceItem: source, item: {...source, kind: 'desktop', provider: 'spotify'},
        producers: new Map(['video', 'audio'].map(kind => [kind, {async getStats() { return [{packetCount: packets}]; }}]))};
      this.sessions.set(session.ws.id, session);
      return {session, targets: {video: {}, audio: {}}};
    },
    activateExternal(session) { session.ready = true; session.room.desktops.push(session.item); },
    retargetExternal(session, source) { session.sourceItem = source; session.item.title = source.title; },
    stop(ws) {
      const session = this.sessions.get(ws.id);
      if (session) session.room.desktops = [];
      this.sessions.delete(ws.id);
    },
  };
  const manager = new SpotifyDesktop(rooms, desktop, {spotifyDesktopKey: 'configured'}, {bridge, now: () => now});
  t.after(() => manager.close());
  const share = async () => { status.enabled = true; for (let i = 0; i < 3; i++) await manager.tick(); };
  return {rooms, room, item, desktop, manager, status, calls, share,
    packets: value => packets = value, advance: value => now += value};
}

test('sharing requires opt-in, has one owner room, and shares play/pause controls', async t => {
  const h = fixture(t);
  await h.manager.tick();
  assert.equal(h.room.spotifyDesktop.state, 'disabled');
  assert.deepEqual(h.calls.map(call => call.action), ['status']);
  await h.share();
  assert.equal(h.room.spotifyDesktop.state, 'sharing');
  const other = h.rooms.create('Other');
  other.members.set('another', {id: 'another'});
  h.rooms.add(other, [spotifyItem()]);
  await h.manager.tick();
  assert.equal(other.spotifyDesktop.state, 'busy');
  assert.equal(other.spotifyDesktop.exclusive, true);
  assert.equal(other.spotifyDesktop.ownerRoomId, h.room.id);
  assert.match(other.spotifyDesktop.message, /Only one room/);
  assert.equal(h.calls.filter(call => call.action === 'open').length, 1);
  assert.equal(await h.manager.control(h.room, {action: 'pause', revision: h.room.playback.revision}), true);
  assert.equal(h.status.playback, 'Paused');
  assert.equal(h.room.playback.paused, true);
  await assert.rejects(h.manager.control(other, {action: 'play', revision: other.playback.revision}), /not ready/);
  await assert.rejects(h.manager.control(h.room, {action: 'play', revision: -1}), /Playback changed/);
});

test('dedicated Spotify track controls preserve the room queue and obey ownership and playback revision', async t => {
  const h = fixture(t);
  await h.share();
  const session = h.manager.active.session, revision = h.room.playback.revision;
  const other = h.rooms.create('Other');
  h.rooms.add(other, [spotifyItem()]);
  for (const [action, command] of [['spotify-previous', 'previous'], ['spotify-next', 'next']]) {
    assert.equal(await h.manager.control(h.room, {action, revision}), true);
    assert.equal(h.calls.at(-1).action, command);
    assert.equal(h.room.current, h.item);
    assert.equal(h.manager.active.session, session);
    assert.equal(h.room.playback.revision, revision);
    await assert.rejects(h.manager.control(other, {action, revision: other.playback.revision}), /not ready/);
    await assert.rejects(h.manager.control(h.room, {action, revision: -1}), /Playback changed/);
  }
  assert.equal(await h.manager.control(h.room, {action: 'constructor', revision}), false);
  assert.equal(await h.manager.control(h.room, {action: 'skip', revision}), false, 'Skip still belongs to the Helltube queue');
});

test('skip and the last viewer leaving immediately detach the stream', async t => {
  const h = fixture(t);
  await h.share();
  h.rooms.advance(h.room);
  assert.equal(h.desktop.sessions.size, 0);
  await h.manager.tick();
  assert.equal(h.status.capturing, false);
  assert.equal(h.room.history[0], h.item);
  h.rooms.add(h.room, [spotifyItem()]);
  await h.share();
  h.room.members.clear();
  h.rooms.emit('state', h.room);
  assert.equal(h.desktop.sessions.size, 0);
  await h.manager.tick();
  assert.equal(h.status.capturing, false);
});

test('consecutive Spotify skips keep the capture, desktop identity and ownership until leaving Spotify', async t => {
  const h = fixture(t);
  const next = spotifyItem(), third = spotifyItem();
  const other = h.rooms.create('Waiting room');
  other.members.set('other', {id: 'other'});
  h.rooms.add(other, [spotifyItem()]);
  h.rooms.add(h.room, [next, third]);
  await h.share();
  const session = h.manager.active.session;
  const stream = h.room.desktops[0];
  const stopCount = h.calls.filter(call => call.action === 'stop').length;
  const states = [];
  h.rooms.on('state', room => { if (room === h.room) states.push(room.desktops.map(item => item.id)); });
  for (const item of [next, third]) {
    h.rooms.advance(h.room);
    assert.equal(h.manager.active.item, item);
    assert.equal(h.manager.active.session, session);
    assert.equal(h.room.desktops[0], stream);
    assert.equal(h.room.spotifyDesktop.state, 'switching');
    await h.manager.tick();
    assert.equal(h.calls.findLast(call => call.action === 'open').data.keepCapture, true);
    await h.manager.tick();
    assert.equal(h.room.spotifyDesktop.state, 'sharing');
    assert.equal(other.spotifyDesktop.state, 'busy');
  }
  assert.ok(states.every(ids => ids.length === 1 && ids[0] === stream.id), 'No empty desktop snapshot between songs');
  assert.equal(h.calls.filter(call => call.action === 'capture').length, 1);
  assert.equal(h.calls.filter(call => call.action === 'stop').length, stopCount);
  assert.deepEqual(h.room.history, [next, h.item]);
  h.rooms.advance(h.room);
  await h.manager.tick();
  assert.equal(h.desktop.sessions.has(session.ws.id), false);
  assert.equal(h.manager.active.room, other, 'The waiting room takes ownership after the Spotify run finishes');
});

test('natural track completion reuses the Spotify stream for the next queued song', async t => {
  const h = fixture(t), next = spotifyItem();
  h.rooms.add(h.room, [next]);
  await h.share();
  const session = h.manager.active.session;
  h.status.url = 'spotify:track:7ouMYWpwJ422jRcDASZB7P';
  await h.manager.tick();
  assert.equal(h.room.current, next);
  assert.equal(h.manager.active.session, session);
  assert.equal(h.status.capturing, true);
  await h.manager.tick();
  await h.manager.tick();
  assert.equal(h.room.spotifyDesktop.state, 'sharing');
  assert.equal(h.calls.filter(call => call.action === 'capture').length, 1);
});

test('a skip during a pending media-status read cannot tear down the retained Spotify stream', async t => {
  const h = fixture(t), next = spotifyItem();
  h.rooms.add(h.room, [next]);
  await h.share();
  const session = h.manager.active.session;
  const producer = session.producers.get('video');
  const original = producer.getStats;
  let release;
  producer.getStats = () => new Promise(resolve => { release = resolve; });
  const pending = h.manager.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  h.rooms.advance(h.room);
  release([{packetCount: 2}]);
  await pending;
  producer.getStats = original;
  await h.manager.tick();
  await h.manager.tick();
  assert.equal(h.manager.active.item, next);
  assert.equal(h.manager.active.session, session);
  assert.equal(h.room.spotifyDesktop.state, 'sharing');
  assert.equal(h.calls.filter(call => call.action === 'capture').length, 1);
  assert.equal(h.calls.filter(call => call.action === 'stop').length, 0);
});

test('disabling sharing and stalled media stop capture without losing the current song', async t => {
  const h = fixture(t);
  await h.share();
  h.status.enabled = false;
  await h.manager.tick();
  assert.equal(h.room.spotifyDesktop.state, 'disabled');
  assert.equal(h.desktop.sessions.size, 0);
  assert.equal(h.room.current, h.item);
  await h.share();
  h.advance(11000);
  await h.manager.tick();
  assert.equal(h.room.spotifyDesktop.state, 'error');
  assert.equal(h.status.capturing, false);
  assert.equal(h.room.current, h.item);
});

test('a finished single track advances the queue instead of broadcasting Spotify autoplay', async t => {
  const h = fixture(t);
  const next = makeItem({kind: 'http', url: 'https://example.com/next.mp4'});
  h.rooms.add(h.room, [next]);
  await h.share();
  h.status.url = 'spotify:track:7ouMYWpwJ422jRcDASZB7P';
  await h.manager.tick();
  assert.equal(h.room.current, next);
  assert.equal(h.status.capturing, false);
  assert.deepEqual(h.room.history, [h.item]);
});

test('shutdown drains an in-flight capture setup without leaving a stream behind', async t => {
  const h = fixture(t);
  h.status.enabled = true;
  await h.manager.tick();
  const original = h.desktop.prepareExternal.bind(h.desktop);
  let release;
  h.desktop.prepareExternal = async (...args) => {
    await new Promise(resolve => { release = resolve; });
    return original(...args);
  };
  const tick = h.manager.tick();
  while (!release) await new Promise(resolve => setImmediate(resolve));
  const closing = h.manager.close();
  release();
  await Promise.all([tick, closing]);
  assert.equal(h.desktop.sessions.size, 0);
  assert.equal(h.status.capturing, false);
});
