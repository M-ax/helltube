import test from 'node:test';
import assert from 'node:assert/strict';
import {hlsCopyQuality} from '../server/hls-copy.js';
import {YouTube} from '../server/youtube.js';
import {Twitch} from '../server/twitch.js';
import {availableQualities, qualityReady, selectQuality} from '../src/lib/media-quality.js';

const format = {protocol: 'm3u8_native', vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', height: 1080};

test('only known browser-compatible muxed HLS is eligible for stream copy', () => {
  assert.deepEqual(hlsCopyQuality([format]), {label: 'Original (1080p)'});
  assert.ok(hlsCopyQuality([{...format, protocol: 'm3u8', vcodec: 'h264', acodec: 'none'}]));
  for (const change of [{protocol: 'https'}, {vcodec: 'vp9'}, {vcodec: 'avc1.6e001f'},
    {acodec: 'opus'}, {vcodec: null}, {acodec: undefined}, {has_drm: true}, {pix_fmt: 'yuv420p10le'}]) {
    assert.equal(hlsCopyQuality([{...format, ...change}]), null);
  }
  assert.equal(hlsCopyQuality([format, {...format, vcodec: 'none'}]), null);
  assert.equal(hlsCopyQuality([]), null);
});

test('both extractors expose copy suitability after validating the source host', async t => {
  const youtube = new YouTube({});
  const twitch = new Twitch({});
  t.after(() => {youtube.close(); twitch.close();});
  t.mock.method(youtube.sponsorBlock, 'segments', async () => []);
  for (const [provider, url] of [[youtube, 'https://video.googlevideo.com/source.m3u8'], [twitch, 'https://vod.ttvnw.net/source.m3u8']]) {
    const data = {...format, url, duration: 60};
    t.mock.method(provider, 'extract', async () => data);
    assert.deepEqual((await provider.resolve('https://youtube.com/watch?v=jNQXAC9IVRw')).copyQuality, {label: 'Original (1080p)'});
    data.vcodec = 'vp9';
    assert.equal((await provider.resolve('https://youtube.com/watch?v=jNQXAC9IVRw')).copyQuality, null);
  }
});

test('local quality selection respects seek coverage, preparation, removal and older servers', () => {
  const original = {id: 'original', url: '/original', baseTime: 0, bufferedUntil: 20, complete: false};
  const standard = {id: 'standard', url: '/standard', baseTime: 10, bufferedUntil: 30, complete: true};
  const media = {...original, qualities: [original, standard]};
  assert.equal(selectQuality(media, 'original', 12), original);
  assert.equal(selectQuality(media, 'standard', 12), standard);
  assert.equal(selectQuality(media, 'standard', 5), original);
  assert.equal(selectQuality(media, 'original', 25), standard);
  assert.equal(qualityReady(original, 19.8), false);
  assert.equal(selectQuality(undefined, 'original', 0), undefined);
  assert.equal(availableQualities({url: '/legacy', baseTime: 0}).length, 1);
  assert.equal(selectQuality({...standard, qualities: [standard]}, 'original', 12), standard);
});
