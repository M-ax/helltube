import test from 'node:test';
import assert from 'node:assert/strict';
import { Rooms, makeItem } from '../server/rooms.js';

function fixture() {
  let now = 100000;
  const rooms = new Rooms({ now: () => now });
  const room = rooms.get('lobby');
  const items = Array.from({ length: 10 }, (_, i) => makeItem({ kind: 'youtube', url: `video-${i}` }, { title: `Video ${i}`, duration: 60 }));
  return { rooms, room, items, elapse: ms => { now += ms; } };
}
const command = (rooms, room, action, extra) => rooms.control(room, { action, revision: room.playback.revision, ...extra });
function ready(item, bufferedUntil = 60, complete = true) {
  item.status = 'ready';
  item.media = { url: '/media/test/index.m3u8', baseTime: 0, bufferedUntil, complete };
}

test('server timeline starts only with buffer, is clock anchored, and rejects stale commands', () => {
  const { rooms, room, items, elapse } = fixture();
  rooms.add(room, [items[0]]);
  assert.equal(room.playback.paused, true);
  ready(items[0]);
  rooms.tick();
  assert.equal(room.playback.paused, false);
  elapse(2500);
  assert.equal(rooms.position(room), 2.5);
  const oldRevision = room.playback.revision;
  command(rooms, room, 'pause');
  elapse(1000);
  assert.equal(rooms.position(room), 2.5);
  assert.throws(() => rooms.control(room, { action: 'play', revision: oldRevision }), /changed/);
});

test('queue insertion, reorder and whole-playlist removal preserve current video', () => {
  const { rooms, room, items } = fixture();
  items[0].playlistId = items[1].playlistId = items[2].playlistId = 'group';
  rooms.add(room, items.slice(0, 3));
  rooms.add(room, [items[3]], 1);
  assert.deepEqual(room.queue.map(i => i.id), [items[1].id, items[3].id, items[2].id]);
  rooms.mutateQueue(room, { type: 'queue:move', itemId: items[2].id, toIndex: 0 });
  assert.equal(room.queue[0].id, items[2].id);
  rooms.mutateQueue(room, { type: 'queue:remove-playlist', playlistId: 'group' });
  assert.deepEqual(room.queue, [items[3]]);
  assert.equal(room.current.id, items[0].id);
  rooms.mutateQueue(room, { type: 'queue:remove', itemId: items[3].id });
  assert.equal(room.queue.length, 0);
  assert.throws(() => rooms.add(room, [items[4]], -1), /position/);
});

test('skip history is capped at five and previous does not lose the interrupted item', () => {
  const { rooms, room, items } = fixture();
  rooms.add(room, items);
  for (let i = 0; i < 7; i++) command(rooms, room, 'skip');
  assert.deepEqual(room.history.map(i => i.id), items.slice(2, 7).reverse().map(i => i.id));
  command(rooms, room, 'previous');
  assert.equal(room.current.id, items[6].id);
  assert.equal(room.queue[0].id, items[7].id);
  rooms.replay(room, items[3].id);
  assert.equal(room.current.id, items[3].id);
  assert.equal(room.queue[0].id, items[6].id);
});

test('buffer underrun freezes the shared clock and refilling resumes everyone', () => {
  const { rooms, room, items, elapse } = fixture();
  rooms.add(room, items.slice(0, 2));
  ready(items[0], 8, false);
  rooms.tick();
  elapse(7600);
  rooms.tick();
  assert.equal(room.playback.paused, true);
  assert.equal(rooms.position(room), 7.25);
  ready(items[0], 16, false);
  rooms.tick();
  assert.equal(room.playback.paused, false);
  ready(items[0]);
  elapse(60000);
  rooms.tick();
  assert.equal(room.current.id, items[1].id);
});

test('seeks use absolute time, prepare out-of-buffer YouTube seeks and guard incomplete uploads', () => {
  const { rooms, room, items } = fixture();
  rooms.add(room, [items[0]]);
  ready(items[0], 10, false);
  rooms.tick();
  let sought;
  rooms.on('seek', (_room, position) => { sought = position; });
  command(rooms, room, 'seek', { position: 40 });
  assert.equal(sought, 40);
  assert.equal(room.playback.paused, true);
  assert.equal(rooms.position(room), 40);
  items[0].kind = 'upload';
  assert.throws(() => command(rooms, room, 'seek', { position: 50 }), /not arrived/);
  for (const position of [-1, NaN, Infinity, 61]) assert.throws(() => command(rooms, room, 'seek', { position }), /Invalid/);
});

test('rooms are isolated and snapshots never expose private source URLs', () => {
  const { rooms, room, items } = fixture();
  const other = rooms.create('Another room');
  rooms.add(room, [items[0]]);
  assert.equal(other.current, null);
  assert.equal(rooms.snapshot(room).current.source, undefined);
  assert.throws(() => rooms.get('missing'), /not found/);
});

test('chosen starts anchor immediate, queued and replayed playback without changing on shared seeks', () => {
  const { rooms, room, items, elapse } = fixture();
  items[0].startAt = items[0].source.startAt = 20;
  items[1].startAt = items[1].source.startAt = 30;
  const seeks = [];
  rooms.on('seek', (_room, position) => seeks.push(position));
  rooms.add(room, items.slice(0, 3));
  assert.equal(room.playback.position, 20);
  assert.equal(room.playback.paused, true);
  ready(items[0], 23, false);
  items[0].media.baseTime = 20;
  rooms.tick();
  assert.equal(room.playback.paused, true, 'The buffer threshold is relative to the chosen start.');
  ready(items[0], 26, false);
  items[0].media.baseTime = 20;
  rooms.tick();
  assert.equal(room.playback.paused, false);
  elapse(1500);
  assert.equal(rooms.position(room), 21.5);
  command(rooms, room, 'seek', { position: 45 });
  assert.equal(items[0].startAt, 20);
  ready(items[1]);
  items[1].media.baseTime = 30;
  command(rooms, room, 'skip');
  assert.equal(room.playback.position, 30);
  rooms.tick();
  assert.equal(room.playback.paused, false);
  command(rooms, room, 'previous');
  assert.equal(room.playback.position, 20);
  assert.equal(seeks.at(-1), 20);
  assert.equal(rooms.snapshot(room).current.startAt, 20);
  command(rooms, room, 'skip');
  assert.equal(room.playback.position, 30);
  command(rooms, room, 'skip');
  assert.equal(room.playback.position, 0);
});