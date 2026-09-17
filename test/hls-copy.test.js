import test from 'node:test';
import assert from 'node:assert/strict';
import {hlsCopyQuality} from '../server/hls-copy.js';
import {YouTube} from '../server/youtube.js';
import {Twitch} from '../server/twitch.js';
import {availableQualities, qualityReady, selectQuality} from '../src/lib/media-quality.js';

const format = {protocol: 'm3u8_native', vcodec: 'avc1.64002a', acodec: 'mp4a.40.2', height: 1080};

test('known H.264, VP9 and AV1 media can be copied with muxed or separate audio', () => {
  assert.deepEqual(hlsCopyQuality([format]), {label: 'Original (1080p)'});
  assert.ok(hlsCopyQuality([{...format, protocol: 'm3u8', vcodec: 'h264', acodec: 'none'}]));
  for (const change of [{protocol: 'https'}, {vcodec: 'vp8'}, {vcodec: 'avc1.6e001f'},
    {acodec: 'vorbis'}, {vcodec: null}, {acodec: undefined}, {has_drm: true}, {pix_fmt: 'yuv420p10le'}]) {
    assert.equal(hlsCopyQuality([{...format, ...change}]), null);
  }
  assert.ok(hlsCopyQuality([format, {...format, vcodec: 'none'}]));
  for (const vcodec of ['vp9', 'vp09.00.50.08', 'av01.0.13M.08']) {
    const video = {...format, protocol: 'https', height: 2160, vcodec, acodec: 'none'};
    const audio = {protocol: 'https', vcodec: 'none', acodec: 'opus'};
    assert.deepEqual(hlsCopyQuality([video, audio], {allowFiles: true}), {label: 'Original (2160p)', container: 'fmp4'});
    assert.equal(hlsCopyQuality([video, {...audio, has_drm: true}], {allowFiles: true}), null);
  }
  assert.equal(hlsCopyQuality([format, format]), null);
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
    data.vcodec = 'vp8';
    assert.equal((await provider.resolve('https://youtube.com/watch?v=jNQXAC9IVRw')).copyQuality, null);
  }
});

test('YouTube selects uncapped resolution and resolves split 4K sources for encrypted copying', async t => {
  const youtube = new YouTube({});
  t.after(() => youtube.close());
  t.mock.method(youtube.sponsorBlock, 'segments', async () => []);
  t.mock.method(youtube, 'extract', async args => {
    assert.equal(args[args.indexOf('-f') + 1], 'bv*+ba/b');
    assert.equal(args[args.indexOf('-S') + 1], 'res,fps');
    return {duration: 120, requested_formats: [
      {url: 'https://v.googlevideo.com/video', protocol: 'https', vcodec: 'vp9', acodec: 'none', height: 2160},
      {url: 'https://v.googlevideo.com/audio', protocol: 'https', vcodec: 'none', acodec: 'opus'},
    ]};
  });
  const result = await youtube.resolve('https://youtube.com/watch?v=jNQXAC9IVRw');
  assert.equal(result.inputs.length, 2);
  assert.deepEqual(result.copyQuality, {label: 'Original (2160p)', container: 'fmp4'});
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
  assert.equal(selectQuality(media, 'original', 12, {standardOnly: true}), standard);
  assert.equal(selectQuality({...original, qualities: [original]}, 'original', 12, {standardOnly: true}), undefined,
    'A fallback stays on Standard even while a new seek job prepares it.');
});
