import test from 'node:test';
import assert from 'node:assert/strict';
import { Twitch } from '../server/twitch.js';
import { sourceKind, twitchURL } from '../shared/media-source.js';

test('Twitch VOD URLs normalize and reject channels, clips and forged hosts', () => {
  for (const value of ['https://www.twitch.tv/videos/123456?t=1h2m3s', 'http://m.twitch.tv/videos/123456/',
    'https://player.twitch.tv/?video=v123456', 'https://www.twitch.tv/channel/video/123456']) {
    assert.equal(sourceKind(value), 'twitch');
    assert.equal(twitchURL(value), 'https://www.twitch.tv/videos/123456');
  }
  for (const value of ['https://twitch.tv/channel', 'https://clips.twitch.tv/Clip', 'https://twitch.tv/videos/nope',
    'https://twitch.tv.evil.test/videos/123', 'file:///videos/123', 'https://user:pass@twitch.tv/videos/123',
    'https://twitch.tv:444/videos/123']) assert.throws(() => twitchURL(value));
  assert.equal(sourceKind('http://media.example/movie.mp4'), 'http');
  assert.equal(sourceKind('https://youtu.be/BaW_jenozKc'), 'youtube');
  assert.equal(sourceKind('file:///movie.mp4'), null);
});

test('Twitch metadata honors timestamps, rejects invalid starts and resolves fresh CDN inputs', async t => {
  const twitch = new Twitch({ ytdlp: 'yt-dlp' });
  const data = { title: 'A VOD', duration: 3600, url: 'https://vod.ttvnw.net/video/index.m3u8?token=secret',
    thumbnail: 'https://static-cdn.jtvnw.net/thumb.jpg', http_headers: { Referer: 'https://www.twitch.tv/' } };
  t.mock.method(twitch, 'extract', async () => data);
  const [item] = await twitch.items('https://twitch.tv/videos/123456?t=1m30s', { displayName: 'Viewer' });
  assert.equal(item.startAt, 90);
  assert.equal(item.kind, 'twitch');
  assert.equal(item.title, 'A VOD');
  assert.equal(item.duration, 3600);
  assert.equal(item.source.url, 'https://www.twitch.tv/videos/123456');
  assert.equal((await twitch.items(item.source.url + '?t=30s', {}, 0))[0].startAt, 0);
  for (const startAt of [-1, 1.5, null, '2', 3600, 4000]) await assert.rejects(twitch.items(item.source.url, {}, startAt), { status: 400 });
  await assert.rejects(twitch.items(item.source.url + '?t=invalid', {}), { status: 400 });
  assert.deepEqual((await twitch.resolve(item.source.url)).inputs, [{ url: data.url, headers: data.http_headers }]);
  for (const url of ['http://vod.ttvnw.net/a.m3u8', 'https://ttvnw.net.evil.test/a', 'https://127.0.0.1/a', 'file:///secret']) {
    data.url = url;
    await assert.rejects(twitch.resolve(item.source.url), /unsupported media host/);
  }
  data.is_live = true;
  await assert.rejects(twitch.items(item.source.url, {}), /completed Twitch VOD/);
});
