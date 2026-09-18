import test from 'node:test';
import assert from 'node:assert/strict';
import { start, until } from './helpers.js';

test('public YouTube video resolves through yt-dlp and becomes playable server HLS', { timeout: 150000 }, async t => {
  const { instance, api, connect, url, cookie } = await start(t, {maxTranscoders: 1});
  assert.equal(instance.capabilities.youtube, true, 'Install yt-dlp before this opt-in network test.');
  const ws = await connect();
  ws.send(JSON.stringify({ type: 'join', roomId: 'lobby' }));
  const room = instance.rooms.get('lobby');
  await until(() => room.members.size);
  const result = await api('/api/rooms/lobby/youtube', { method: 'POST', body: {
    url: process.env.YOUTUBE_TEST_URL || 'https://www.youtube.com/watch?v=jNQXAC9IVRw',
  } });
  assert.equal(result.status, 201, JSON.stringify(result.data));
  assert.ok(result.data.added >= 1);
  await until(() => {
    assert.notEqual(room.current?.status, 'error', room.current?.error);
    return room.current?.media?.bufferedUntil >= 2;
  }, 100000);
  const response = await fetch(url + room.current.media.url, { headers: { Cookie: cookie } });
  assert.equal(response.status, 200);
  const playlist = await response.text();
  assert.ok(playlist.includes('#EXTINF:'));
  const segment = playlist.split(/\r?\n/).find(line => /^segment-\d+\.(?:ts|m4s)(?:\?.*)?$/.test(line));
  assert.ok(segment, 'The media playlist contains a playable TS or fMP4 segment.');
  const video = await fetch(new URL(segment, new URL(room.current.media.url, url)), { headers: { Cookie: cookie } });
  assert.equal(video.status, 200);
  assert.ok((await video.arrayBuffer()).byteLength > 1000);
  t.diagnostic(`YouTube → yt-dlp → FFmpeg → authenticated HLS succeeded: ${room.current.title}.`);
});
