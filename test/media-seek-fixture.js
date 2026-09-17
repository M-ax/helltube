import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {hlsCopyQuality} from '../server/hls-copy.js';

export async function createSeekFixture(t, {instance, dir, url}, codec = 'vp9', {hls = false} = {}) {
  const exec = promisify(execFile);
  const h264 = codec === 'h264';
  const video = path.join(dir, `seek-${codec}.${h264 ? 'mp4' : 'webm'}`);
  const audio = path.join(dir, `seek-audio-${codec}.${h264 ? 'm4a' : 'webm'}`);
  const source = "color=c=blue:s=1440x810:r=10,drawbox=color=red:t=fill:enable='gte(t,62)'," +
    "drawbox=color=lime:t=fill:enable='gte(t,64)',drawbox=color=yellow:t=fill:enable='gte(t,66)'";
  await exec(instance.media.config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', source,
    '-t', '80', '-c:v', h264 ? 'libx264' : codec === 'vp9' ? 'libvpx-vp9' : 'libaom-av1',
    ...(h264 ? ['-preset', 'veryfast', '-bf', '3'] : ['-cpu-used', '8', '-row-mt', '1', '-b:v', '0']),
    '-threads', '2', '-crf', '35', '-g', '20', '-pix_fmt', 'yuv420p', video]);
  await exec(instance.media.config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
    'sine=frequency=440:sample_rate=48000', '-t', '80', '-c:a', h264 ? 'aac' : 'libopus', audio]);
  instance.app.get(`/seek-${codec}/:file`, (req, res) => res.sendFile(req.params.file, {root: dir, dotfiles: 'allow'}));
  const resolved = {duration: 80, inputs: [video, audio].map(file => ({url: `${url}/seek-${codec}/${path.basename(file)}`, headers: {}})),
    copyQuality: hlsCopyQuality([
      {protocol: 'https', vcodec: codec, acodec: 'none', height: 810},
      {protocol: 'https', vcodec: 'none', acodec: h264 ? 'aac' : 'opus'},
    ], {allowFiles: true})};
  if (hls) {
    await exec(instance.media.config.ffmpeg, ['-v', 'error', '-i', video, '-i', audio, '-map', '0:v', '-map', '1:a',
      '-c', 'copy', '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'vod', path.join(dir, 'upstream.m3u8')]);
    resolved.inputs = [{url: `${url}/seek-${codec}/upstream.m3u8`, headers: {}}];
    resolved.copyQuality = hlsCopyQuality([{protocol: 'm3u8', vcodec: codec, acodec: 'aac', height: 810}]);
  }
  t.mock.method(instance.youtube, 'resolve', async () => resolved);
  return {video, audio, resolved};
}
