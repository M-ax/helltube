import test from 'node:test';
import assert from 'node:assert/strict';
import { uploadHealth } from '../server/uploads.js';
import { YouTube, youtubeURL } from '../server/youtube.js';
import { playlistProgress } from '../server/media.js';

test('upload pacing fills a healthy buffer before delaying and detects sustained poor throughput', () => {
  const baseline = { size: 100000000, duration: 100, received: 60000000, position: 0,
    transferBytes: 60000000, transferMs: 15000, samples: 5, ready: true, complete: false };
  const full = uploadHealth(baseline);
  assert.equal(full.delayMs, 3000);
  assert.equal(full.slow, false);
  assert.equal(uploadHealth({ ...baseline, received: 10000000 }).delayMs, 0);
  assert.equal(uploadHealth({ ...baseline, ready: false }).delayMs, 0);
  assert.equal(uploadHealth({ ...baseline, received: 2000000, transferBytes: 2000000 }).slow, true);
  assert.equal(uploadHealth({ ...baseline, received: 2000000, transferBytes: 2000000, transferMs: 1000 }).slow, false);
  assert.equal(uploadHealth({ ...baseline, complete: true }).delayMs, 0);
  assert.equal(uploadHealth({ ...baseline, duration: null }).slow, false);
});

test('only valid YouTube identifiers reach the extractor; playlist context is preserved', () => {
  assert.equal(youtubeURL('https://youtu.be/BaW_jenozKc?t=2'), 'https://www.youtube.com/watch?v=BaW_jenozKc');
  assert.equal(youtubeURL('https://www.youtube.com/shorts/BaW_jenozKc'), 'https://www.youtube.com/watch?v=BaW_jenozKc');
  assert.equal(youtubeURL('https://www.youtube.com/watch?v=BaW_jenozKc&list=PL1234567890123'), 'https://www.youtube.com/playlist?list=PL1234567890123');
  for (const input of ['file:///secret', 'http://127.0.0.1', 'https://youtube.com.evil.test/watch?v=BaW_jenozKc',
    'https://evil@youtube.com/watch?v=BaW_jenozKc', 'https://youtube.com/', '--exec bad', 'https://youtu.be/not-an-id']) {
    assert.throws(() => youtubeURL(input));
  }
});

test('partial event playlists report chunk readiness without waiting for end of stream', () => {
  const partial = '#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXTINF:2.000,\nsegment-000000.ts\n#EXTINF:2.000,\nsegment-000001.ts\n';
  assert.deepEqual(playlistProgress(partial, 40), { bufferedUntil: 44, complete: false, segments: 2 });
  assert.equal(playlistProgress(`${partial}#EXT-X-ENDLIST\n`).complete, true);
});

test('YouTube Mix links retain the seed video through metadata extraction and queue creation', async t => {
  const canonical = 'https://www.youtube.com/watch?v=5WzswZXTMZQ&list=RD5WzswZXTMZQ';
  for (const input of [
    canonical + '&start_radio=1&tracking=discard-me',
    'https://youtu.be/5WzswZXTMZQ?list=RD5WzswZXTMZQ',
    'https://music.youtube.com/watch?v=5WzswZXTMZQ&list=RD5WzswZXTMZQ',
  ]) assert.equal(youtubeURL(input), canonical);
  const youtube = new YouTube({});
  t.after(() => youtube.close());
  const extract = t.mock.method(youtube, 'extract', async args => {
    assert.equal(args.at(-1), canonical);
    return {title: 'Mix', entries: [
      {id: '5WzswZXTMZQ', title: 'Selected video', duration: 90},
      {id: 'jNQXAC9IVRw', title: 'Next video', duration: 19},
    ]};
  });
  const items = await youtube.items(canonical + '&start_radio=1&t=10', {displayName: 'Viewer'});
  assert.equal(extract.mock.callCount(), 1);
  assert.deepEqual(items.map(item => item.source.url), [
    'https://www.youtube.com/watch?v=5WzswZXTMZQ', 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  ]);
  assert.deepEqual(items.map(item => item.startAt), [10, 0]);
  assert.ok(items[0].playlistId && items[0].playlistId === items[1].playlistId);
});

test('playlist metadata becomes an ordered removable group and rejects private entries', async t => {
  const youtube = new YouTube({ ytdlp: 'yt-dlp' });
  const extract = t.mock.method(youtube, 'extract', async () => ({ title: 'A playlist', entries: [
    { id: 'jNQXAC9IVRw', title: 'First', duration: 19 },
    { id: 'BaW_jenozKc', title: 'Second', duration: 10 },
    { id: 'abcdefghijk', title: 'Private', availability: 'private' }, null,
  ] }));
  const items = await youtube.items('https://youtube.com/playlist?list=PL1234567890123', { displayName: 'Viewer' });
  assert.deepEqual(items.map(i => i.title), ['First', 'Second']);
  assert.equal(items[0].playlistId, items[1].playlistId);
  assert.ok(items[0].playlistId);
  assert.equal(items[0].playlistTitle, 'A playlist');
  assert.notEqual(items[0].id, items[1].id);
  assert.equal(items[1].addedBy, 'Viewer');
  assert.ok(extract.mock.calls[0].arguments[0].includes('--playlist-end'));
});
