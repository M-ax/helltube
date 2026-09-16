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