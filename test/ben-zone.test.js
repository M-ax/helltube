import test from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, makeItem } from '../server/rooms.js';
import { BenZone, BEN_ZONE_ID } from '../server/ben-zone.js';
import { YouTube } from '../server/youtube.js';
import { SoundCloud } from '../server/soundcloud.js';
import { start, until } from './helpers.js';

const streams = [
  { id: 'aaaaaaaaaaa', channel: 'PAW Patrol', title: 'Pups live', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' },
  { id: 'bbbbbbbbbbb', channel: 'Bluey', title: 'Bluey live', url: 'https://www.youtube.com/watch?v=bbbbbbbbbbb' },
];
const tracks = ['one', 'two', 'three'].map(title => ({title, url: `https://soundcloud.com/test/${title}`, genre: 'Hardstyle'}));

function fixture(t, options = {}) {
  let now = 1000;
  const rooms = new Rooms({now: () => now});
  const room = rooms.get(BEN_ZONE_ID);
  let discoveries = 0;
  const youtube = {liveStreams: async () => { discoveries++; return streams; }};
  const disposed = [];
  const media = {jobs: new Map(), dispose(job) { disposed.push(job); this.jobs.delete(job.item.id); }};
  const channel = new BenZone(rooms, youtube, media, {now: () => now, random: () => 0, tracks,
    cartoonMs: 10000, ...options});
  t.after(() => channel.close());
  return {rooms, room, channel, youtube, media, disposed, discoveries: () => discoveries,
    elapse: ms => { now += ms; },
    join: async (id = 'viewer') => {room.members.set(id, {id}); channel.membershipChanged(room); await channel.pending;},
    leave: (id = 'viewer') => {room.members.delete(id); channel.membershipChanged(room);}};
}

test('automatic channel stays idle until occupied, shares one mix, and stops only after the last viewer leaves', async t => {
  const f = fixture(t);
  f.channel.tick();
  assert.equal(f.discoveries(), 0);
  assert.equal(f.room.automation.state, 'idle');
  await f.join();
  const item = f.room.current;
  assert.equal(item.live, true);
  assert.equal(item.source.soundtrackUrl, item.soundtrack.url);
  await f.join('second-tab');
  assert.equal(f.room.current, item);
  assert.equal(f.discoveries(), 1);
  f.media.jobs.set(item.id, {item});
  f.leave();
  assert.equal(f.disposed.length, 0);
  f.leave('second-tab');
  assert.equal(f.disposed.length, 1);
  assert.equal(f.room.current, null);
  assert.equal(f.room.resumeWhenReady, false);
  assert.equal(f.room.automation.state, 'idle');
  f.elapse(100000);
  f.channel.tick();
  assert.equal(f.discoveries(), 1);
  await f.join();
  assert.notEqual(f.room.current.id, item.id);
  assert.equal(f.room.playback.position, 0);
});

test('songs rotate without repeats, cartoons rotate between songs, and automatic completion uses the same path', async t => {
  const f = fixture(t);
  await f.join();
  const first = f.room.current;
  const heard = [first.soundtrack.url];
  const skip = async action => {
    f.rooms.control(f.room, {action, revision: f.room.playback.revision});
    await f.channel.pending;
    return f.room.current;
  };
  heard.push((await skip('skip')).soundtrack.url);
  assert.equal(f.room.current.cartoon.channel, first.cartoon.channel);
  f.elapse(11000);
  heard.push((await skip('skip')).soundtrack.url);
  assert.equal(new Set(heard).size, tracks.length);
  assert.notEqual(f.room.current.cartoon.channel, first.cartoon.channel);
  const previous = f.room.current;
  const next = await skip('next-cartoon');
  assert.notEqual(next.cartoon.channel, previous.cartoon.channel);
  assert.notEqual(next.soundtrack.url, previous.soundtrack.url);
  next.status = 'ready';
  next.duration = 2;
  next.media = {baseTime: 0, bufferedUntil: 2, complete: true};
  f.rooms.tick();
  f.elapse(2100);
  f.rooms.tick();
  await f.channel.pending;
  assert.notEqual(f.room.current.id, next.id);
  for (const action of ['pause', 'play', 'seek', 'previous']) {
    assert.throws(() => f.rooms.control(f.room, {action, revision: f.room.playback.revision}), /automatically/);
  }
  assert.throws(() => f.rooms.add(f.room, [makeItem({kind: 'youtube'})]), /automatically/);
  assert.throws(() => f.rooms.replay(f.room, 'old'), /automatically/);
});

test('leaving cancels discovery and an old completion cannot replace a new visit', async t => {
  const f = fixture(t);
  const calls = [];
  f.youtube.liveStreams = (_channels, {signal}) => new Promise(resolve => calls.push({signal, resolve}));
  const firstJoin = f.join();
  assert.equal(calls.length, 1);
  f.leave();
  assert.equal(calls[0].signal.aborted, true);
  const secondJoin = f.join();
  assert.equal(calls.length, 2);
  calls[1].resolve([streams[1]]);
  await secondJoin;
  const current = f.room.current;
  calls[0].resolve([streams[0]]);
  await firstJoin;
  assert.equal(f.room.current, current);
  assert.deepEqual(f.channel.streams, [streams[1]]);
});

test('unavailable streams and failed songs back off, skip failures, and stop retrying when empty', async t => {
  const f = fixture(t, {cartoonMs: 60000});
  let calls = 0;
  f.youtube.liveStreams = async () => {calls++; return calls === 1 ? [] : streams;};
  await f.join();
  assert.equal(f.room.automation.state, 'waiting');
  f.channel.tick();
  assert.equal(calls, 1);
  f.elapse(5000);
  f.channel.tick();
  await f.channel.pending;
  const failed = f.room.current;
  failed.status = 'error';
  failed.automationFailure = 'track';
  f.channel.tick();
  assert.equal(f.room.current, null);
  f.elapse(10000);
  f.channel.tick();
  await f.channel.pending;
  assert.notEqual(f.room.current.soundtrack.url, failed.soundtrack.url);
  assert.equal(f.room.current.cartoon.channel, failed.cartoon.channel);
  f.leave();
  f.elapse(100000);
  f.channel.tick();
  assert.equal(calls, 2);
});

test('discovery accepts only live entries, tolerates offline channels, and revalidates live media hosts', async t => {
  const youtube = new YouTube({});
  t.after(() => youtube.close());
  t.mock.method(youtube, 'extract', async args => {
    if (args.at(-1).includes('offline')) throw new Error('offline');
    return {entries: [{id: 'aaaaaaaaaaa', title: 'Live', live_status: 'is_live'},
      {id: 'bbbbbbbbbbb', live_status: 'was_live'}, {id: 'ccccccccccc', live_status: 'is_upcoming'}, null]};
  });
  assert.deepEqual((await youtube.liveStreams([{name: 'Pups', url: 'pups'}, {name: 'Offline', url: 'offline'}]))
    .map(stream => stream.id), ['aaaaaaaaaaa']);
  youtube.extract = async () => ({is_live: false, url: 'https://video.googlevideo.com/live'});
  await assert.rejects(youtube.resolveLive(streams[0].url), /no longer live/);
  youtube.extract = async () => ({is_live: true, url: 'http://127.0.0.1/live'});
  await assert.rejects(youtube.resolveLive(streams[0].url), /unsupported/);
  youtube.extract = async () => ({is_live: true, url: 'https://video.googlevideo.com/live'});
  assert.equal((await youtube.resolveLive(streams[0].url)).inputs[0].url, 'https://video.googlevideo.com/live');
  const aborted = AbortSignal.abort();
  await assert.rejects(youtube.liveStreams([], {signal: aborted}), {name: 'AbortError'});
});

test('automatic soundtracks reject short subscription previews', async t => {
  const soundcloud = new SoundCloud({});
  t.after(() => soundcloud.close());
  t.mock.method(soundcloud, 'extract', async () => ({duration: 30, url: 'https://media.sndcdn.com/preview.mp3'}));
  await assert.rejects(soundcloud.resolve(tracks[0].url, {fullTrack: true}), /preview/);
  assert.equal((await soundcloud.resolve(tracks[0].url)).duration, 30, 'Ordinary SoundCloud playback keeps its existing behavior.');
});

test('restarting the automatic service drops old live media and preserves older manual queue items without playing them', async t => {
  const f = fixture(t);
  await f.join();
  const old = f.room.current;
  const manual = makeItem({kind: 'youtube', url: streams[0].url});
  f.room.queue.push(manual);
  await f.channel.close();
  f.room.current = old; // Simulate a persisted mix from an interrupted process.
  f.room.members.clear();
  const restarted = new BenZone(f.rooms, f.youtube, f.media);
  t.after(() => restarted.close());
  assert.equal(f.room.current, null);
  assert.deepEqual(f.room.queue, [manual]);
  assert.equal(f.room.automation.state, 'idle');
  restarted.tick();
  assert.equal(f.discoveries(), 1);
});

test('deleting the room during discovery cancels pending work and does not recreate it', async t => {
  const f = fixture(t);
  const deferred = Promise.withResolvers();
  let signal;
  f.youtube.liveStreams = (_channels, options) => {signal = options.signal; return deferred.promise;};
  const joining = f.join();
  f.rooms.remove(BEN_ZONE_ID, {role: 'admin'});
  assert.equal(signal.aborted, true);
  deferred.resolve(streams);
  await joining;
  assert.equal(f.rooms.rooms.has(BEN_ZONE_ID), false);
  assert.equal(f.media.jobs.size, 0);
});

test('last viewer leaving aborts both provider extractions before an encoder can start', async t => {
  const {instance, connect} = await start(t, {maxTranscoders: 1});
  t.mock.method(instance.youtube, 'liveStreams', async () => streams);
  const signals = [];
  const pending = (_url, {signal}) => new Promise((_resolve, reject) => {
    signals.push(signal);
    signal.addEventListener('abort', () => reject(signal.reason), {once: true});
  });
  t.mock.method(instance.youtube, 'resolveLive', pending);
  t.mock.method(instance.soundcloud, 'resolve', pending);
  const conversion = t.mock.method(instance.media, 'convert', async () => { throw new Error('Unexpected conversion'); });
  const ws = await connect();
  ws.send(JSON.stringify({type: 'join', roomId: BEN_ZONE_ID}));
  await until(() => signals.length === 2);
  ws.terminate();
  await until(() => signals.every(signal => signal.aborted));
  await until(() => instance.media.cleanups.size === 0);
  assert.equal(conversion.mock.callCount(), 0);
  assert.equal(instance.media.jobs.size, 0);
});

test('WebSocket membership activates the channel, blocks manual input, and disconnecting idles it', async t => {
  const {instance, connect, api} = await start(t, {maxTranscoders: 0});
  const discovery = t.mock.method(instance.youtube, 'liveStreams', async () => streams);
  const room = instance.rooms.get(BEN_ZONE_ID);
  assert.equal(discovery.mock.callCount(), 0);
  const ws = await connect();
  ws.send(JSON.stringify({type: 'join', roomId: BEN_ZONE_ID}));
  await until(() => room.current);
  assert.equal(discovery.mock.callCount(), 1);
  assert.equal((await api(`/api/rooms/${BEN_ZONE_ID}/media`, {method: 'POST', body: {url: streams[0].url}})).status, 409);
  assert.equal((await api(`/api/rooms/${BEN_ZONE_ID}/uploads`, {method: 'POST', body: {name: 'a.mp4', size: 4}})).status, 409);
  ws.send(JSON.stringify({type: 'desktop:start', requestId: 'blocked'}));
  await until(() => ws.messages.find(message => message.type === 'desktop:error'));
  const oldId = room.current.id;
  ws.send(JSON.stringify({type: 'control', action: 'skip', revision: room.playback.revision}));
  await until(() => room.current?.id !== oldId);
  ws.terminate();
  await until(() => !room.members.size);
  assert.equal(room.current, null);
  assert.equal(room.automation.state, 'idle');
  assert.equal(instance.media.jobs.size, 0);
});
