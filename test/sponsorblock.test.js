import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SponsorBlock, normalizeSponsors, sponsorPlaylist } from '../server/sponsorblock.js';
import { sponsorPosition } from '../shared/sponsorblock.js';
import { playlistProgress } from '../server/media.js';
import { Rooms, makeItem } from '../server/rooms.js';
import { YouTube } from '../server/youtube.js';
import { targetPosition } from '../src/lib/format.js';

const id = 'jNQXAC9IVRw';
const entry = (start, end, extra = {}) => ({ category: 'sponsor', actionType: 'skip', segment: [start, end], ...extra });

test('SponsorBlock privately looks up the exact video, deduplicates requests and expires its cache', async () => {
  let now = 1000;
  const requests = [];
  const segments = [entry(5, 10)];
  const client = new SponsorBlock({ now: () => now, fetchImpl: async (url, options) => {
    requests.push({ url, options });
    return Response.json([{ videoID: 'abcdefghijk', segments: [entry(0, 99)] }, { videoID: id, segments }]);
  } });
  const values = await Promise.all([client.segments(id), client.segments(id)]);
  assert.deepEqual(values, [segments, segments]);
  assert.equal(requests.length, 1);
  const { url, options } = requests[0];
  assert.equal(url.origin, 'https://sponsor.ajay.app');
  assert.equal(url.pathname, `/api/skipSegments/${createHash('sha256').update(id).digest('hex').slice(0, 4)}`);
  assert.ok(!url.href.includes(id));
  assert.deepEqual(JSON.parse(url.searchParams.get('categories')), ['sponsor']);
  assert.deepEqual(JSON.parse(url.searchParams.get('actionTypes')), ['skip']);
  assert.equal(url.searchParams.get('service'), 'YouTube');
  assert.ok(options.signal instanceof AbortSignal);
  await client.segments(id);
  assert.equal(requests.length, 1);
  now += 3600001;
  await client.segments(id);
  assert.equal(requests.length, 2);
  assert.deepEqual(await client.segments('invalid'), []);
  client.close();
  assert.deepEqual(await client.segments(id), []);
});

test('missing segments, API failures, invalid JSON, timeout and shutdown leave playback usable', async () => {
  for (const fetchImpl of [
    async () => new Response(null, { status: 404 }),
    async () => new Response('busy', { status: 503 }),
    async () => new Response('rate limited', { status: 429 }),
    async () => new Response('invalid JSON'),
    async () => Response.json({ unexpected: true }),
    async () => Response.json([{ videoID: id, segments: {} }]),
    async () => Response.json([{ videoID: 'abcdefghijk', segments: [entry(1, 2)] }]),
    async () => { throw new Error('offline'); },
    (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true })),
  ]) {
    const client = new SponsorBlock({ fetchImpl, timeout: 10 });
    assert.deepEqual(await client.segments(id), []);
    assert.equal(client.pending.size, 0);
    client.close();
  }
  const client = new SponsorBlock({ fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })) });
  const pending = client.segments(id);
  client.close();
  assert.deepEqual(await pending, []);
  assert.equal(client.cache.size, 0);
});

test('failed lookups retry after a short backoff', async () => {
  let now = 0;
  let count = 0;
  const client = new SponsorBlock({ now: () => now, fetchImpl: async () => {
    count++;
    return new Response(null, { status: 500 });
  } });
  await client.segments(id);
  await client.segments(id);
  assert.equal(count, 1);
  now = 60001;
  await client.segments(id);
  assert.equal(count, 2);
  client.close();
});

test('only valid sponsor skips survive normalization; overlap, adjacency and duration are handled', () => {
  assert.deepEqual(normalizeSponsors([
    entry(15, 20), entry(5, 12), entry(10, 15), entry(29, 35), entry(28, 29),
    entry(1, 3, { category: 'intro' }), entry(1, 3, { actionType: 'mute' }),
    entry(1, 3, { videoDuration: 99 }), entry(0, 1, { videoDuration: 30.5 }),
    entry(4, 4), entry(-1, 3), entry(10, 5), entry(30, 40), entry('1', 3), entry(1, Infinity), null,
  ], 30), [[0, 1], [5, 20], [28, 30]]);
  assert.deepEqual(normalizeSponsors(null), []);
});

test('YouTube resolution retrieves SponsorBlock alongside media metadata', async t => {
  const youtube = new YouTube({});
  t.after(() => youtube.close());
  let lookupId;
  t.mock.method(youtube.sponsorBlock, 'segments', async value => { lookupId = value; return [entry(5, 10)]; });
  t.mock.method(youtube, 'extract', async () => ({ url: 'https://test.googlevideo.com/media', duration: 30 }));
  const resolved = await youtube.resolve(`https://youtu.be/${id}`);
  assert.equal(lookupId, id);
  assert.deepEqual(resolved.sponsorSegments, [[5, 10]]);
  assert.equal(resolved.duration, 30);
});

test('HLS gaps suppress only whole ad fragments, preserve AES sequence/timeline and account for source offsets', () => {
  const item = { kind: 'youtube', sponsorSegments: [[11, 16]] };
  const playlist = '#EXTM3U\n#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n' +
    Array.from({ length: 5 }, (_, i) => `#EXTINF:2.000,\nsegment-${String(i).padStart(6, '0')}.ts\n`).join('') + '#EXT-X-ENDLIST\n';
  const result = sponsorPlaylist(playlist, item, 10);
  assert.deepEqual([...result.matchAll(/#EXT-X-GAP\n(segment-\d+\.ts)/g)].map(match => match[1]),
    ['segment-000001.ts', 'segment-000002.ts']);
  assert.deepEqual(playlistProgress(result, 10), playlistProgress(playlist, 10));
  assert.ok(result.includes('#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"'));
  assert.equal(sponsorPlaylist(playlist, item, 0), playlist);
  for (const kind of ['twitch', 'http', 'upload']) assert.equal(sponsorPlaylist(playlist, { ...item, kind }, 10), playlist);
  assert.equal(sponsorPlaylist(playlist, { kind: 'youtube' }), playlist);
  assert.equal((sponsorPlaylist(playlist.replaceAll('\n', '\r\n'), item, 10).match(/#EXT-X-GAP/g) || []).length, 2);
  const boundary = sponsorPlaylist(playlist, { kind: 'youtube', sponsorSegments: [[10.1, 11.9]] }, 10);
  assert.equal(boundary, playlist, 'Partial overlaps must retain non-ad frames.');
});

function roomFixture({ complete = true, bufferedUntil = 60, sponsorSegments = [[5, 20], [22, 23]] } = {}) {
  let now = 100000;
  const rooms = new Rooms({ now: () => now });
  const room = rooms.get('lobby');
  const item = makeItem({ kind: 'youtube', url: `https://youtu.be/${id}` }, { duration: 60, sponsorSegments });
  rooms.add(room, [item]);
  item.status = 'ready';
  item.media = { baseTime: 0, bufferedUntil, complete, url: '/media/test/index.m3u8' };
  return { rooms, room, item, elapse: ms => { now += ms; }, now: () => now };
}

test('the server and viewers skip on the same clock, including multiple windows between ticks', () => {
  const { rooms, room, item, elapse, now } = roomFixture();
  rooms.tick();
  const revision = room.playback.revision;
  elapse(7500);
  assert.equal(rooms.position(room), 23.5);
  assert.equal(targetPosition(rooms.snapshot(room), 0, now()), 23.5);
  let seeks = 0;
  rooms.on('seek', () => seeks++);
  rooms.tick();
  assert.equal(room.playback.position, 23.5);
  assert.equal(room.playback.revision, revision + 1);
  assert.equal(seeks, 0, 'Already prepared post-ad content does not restart FFmpeg.');
  assert.equal(room.playback.paused, false);
  elapse(500);
  assert.equal(rooms.position(room), 24);
  assert.deepEqual(rooms.snapshot(room).current.sponsorSegments, item.sponsorSegments);
  assert.equal(sponsorPosition({ ...item, kind: 'upload' }, 4, 2), 6);
});

test('a post-ad seek beyond generated HLS pauses at the destination and resumes when ready', () => {
  const { rooms, room, item, elapse } = roomFixture({ complete: false, bufferedUntil: 9 });
  rooms.tick();
  const seeks = [];
  rooms.on('seek', (_room, position) => { seeks.push(position); item.media = null; });
  elapse(5250);
  rooms.tick();
  assert.deepEqual(seeks, [20.25]);
  assert.equal(room.playback.position, 20.25);
  assert.equal(room.playback.paused, true);
  assert.equal(room.resumeWhenReady, true);
  item.media = { baseTime: 20.25, bufferedUntil: 28, complete: false };
  rooms.tick();
  assert.equal(room.playback.paused, false);
  assert.equal(room.playback.position, 20.25);
});

test('manual seeks into ads skip precisely, preserve pause, and keep original startAt', () => {
  const { rooms, room, item } = roomFixture();
  room.resumeWhenReady = false;
  rooms.control(room, { action: 'seek', position: 8, revision: room.playback.revision });
  assert.equal(room.playback.position, 20);
  assert.equal(room.playback.paused, true);
  rooms.tick();
  assert.equal(room.playback.paused, true);
  assert.equal(item.startAt, 0);
  assert.equal(sponsorPosition(item, 20), 20, 'The end boundary is not skipped twice.');
});

test('late results, starting inside an ad, and a sponsored ending cannot strand the queue', () => {
  const { rooms, room, item } = roomFixture({ complete: false, sponsorSegments: [] });
  item.sponsorSegments = [[0, 10]];
  rooms.tick();
  assert.equal(room.playback.position, 10);
  assert.equal(room.playback.paused, false);
  item.sponsorSegments = [[10, 60]];
  rooms.tick();
  assert.equal(room.current, null);
  assert.equal(room.history[0].id, item.id);

  const fixture = roomFixture({ complete: false, sponsorSegments: [[5, 60]] });
  fixture.rooms.control(fixture.room, { action: 'seek', position: 10, revision: fixture.room.playback.revision });
  fixture.rooms.tick();
  assert.equal(fixture.room.current, null);
});

test('queue advancement and history replay preserve prepared post-ad starts', () => {
  const { rooms, room } = roomFixture();
  const next = makeItem({ kind: 'youtube', url: `https://youtu.be/${id}`, startAt: 20 }, {
    startAt: 7, duration: 60, sponsorSegments: [[5, 20]], status: 'ready',
    media: { baseTime: 20, bufferedUntil: 60, complete: true },
  });
  rooms.add(room, [next]);
  const sought = [];
  rooms.on('seek', (_room, position) => sought.push(position));
  rooms.advance(room);
  assert.equal(room.playback.position, 20);
  assert.deepEqual(sought, [], 'A queued post-ad job is already positioned correctly.');
  rooms.tick();
  assert.equal(room.playback.paused, false);
  rooms.advance(room);
  rooms.replay(room, next.id);
  assert.equal(room.playback.position, 20);
  assert.deepEqual(sought, [20], 'History seeks directly to the retained post-ad buffer.');
  assert.equal(next.startAt, 7);
});
