import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {hlsCopyQuality} from '../server/hls-copy.js';

export async function create4kFixture(t, {instance, dir, url}, {codec = 'vp9', duration = 6, size = '3840x2160'} = {}) {
  const exec = promisify(execFile);
  const video = path.join(dir, `${codec}.webm`);
  const audio = path.join(dir, `${codec}-audio.webm`);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', `color=c=blue:s=${size}:r=2`, '-t', String(duration),
    '-c:v', codec === 'vp9' ? 'libvpx-vp9' : 'libaom-av1', '-cpu-used', '8', '-row-mt', '1',
    '-threads', '2', '-b:v', '0', '-crf', '45', '-g', '4', '-pix_fmt', 'yuv420p', video]);
  await exec(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', String(duration), '-c:a', 'libopus', audio]);
  instance.app.get(`/fixture-${codec}/:file`, (req, res) => res.sendFile(req.params.file, {root: dir, dotfiles: 'allow'}));
  const formats = [
    {protocol: 'https', vcodec: codec, acodec: 'none', height: Number(size.split('x')[1])},
    {protocol: 'https', vcodec: 'none', acodec: 'opus'},
  ];
  const resolved = {duration, copyQuality: hlsCopyQuality(formats, {allowFiles: true}), inputs: [
    {url: `${url}/fixture-${codec}/${codec}.webm`, headers: {}},
    {url: `${url}/fixture-${codec}/${codec}-audio.webm`, headers: {}},
  ]};
  t.mock.method(instance.youtube, 'resolve', async () => resolved);
  return {video, audio, resolved};
}
