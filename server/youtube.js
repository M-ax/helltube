import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { httpError } from './config.js';
import { makeItem } from './rooms.js';
import { parseStartTime, youtubeTimeArgument } from '../shared/youtube-time.js';

function videoId(url) {
  return url.hostname === 'youtu.be' ? url.pathname.slice(1)
    : /^\/(?:shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : url.searchParams.get('v');
}

export function youtubeURL(value) {
  let url;
  try { url = new URL(value); } catch { throw httpError(400, 'Enter a valid YouTube URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port ||
    !['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'].includes(url.hostname)) {
    throw httpError(400, 'Only HTTPS YouTube video and playlist URLs are accepted.');
  }
  const video = videoId(url);
  const playlist = url.searchParams.get('list');
  if (playlist && /^[a-zA-Z0-9_-]{10,100}$/.test(playlist)) {
    return `https://www.youtube.com/playlist?list=${playlist}`;
  }
  if (video && /^[a-zA-Z0-9_-]{11}$/.test(video)) return `https://www.youtube.com/watch?v=${video}`;
  throw httpError(400, 'The URL must identify a YouTube video or playlist.');
}

export function runJSON(command, args, { signal, timeout = 90000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, signal, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let failure;
    const timer = setTimeout(() => { failure = new Error('YouTube extraction timed out.'); child.kill(); }, timeout);
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 16 * 1024 * 1024) { failure = new Error('YouTube response was too large.'); child.kill(); }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-3000); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(errors.trim() || `yt-dlp exited with code ${code}.`));
      try { resolve(JSON.parse(output)); } catch { reject(new Error('yt-dlp returned invalid metadata.')); }
    });
  });
}

export class YouTube {
  constructor(config) {
    this.config = config;
    this.pending = new Set();
    this.baseArgs = ['--ignore-config', '--no-warnings', '--socket-timeout', '20', '--js-runtimes', 'node'];
  }

  async extract(args) {
    if (this.pending.size >= 4) throw httpError(429, 'YouTube is busy. Try again shortly.');
    const controller = new AbortController();
    this.pending.add(controller);
    try { return await runJSON(this.config.ytdlp, [...this.baseArgs, ...args], { signal: controller.signal }); }
    finally { this.pending.delete(controller); }
  }

  async items(value, user, startAt) {
    const url = youtubeURL(value);
    if (startAt === undefined) startAt = parseStartTime(youtubeTimeArgument(value) ?? '0');
    if (!Number.isSafeInteger(startAt) || startAt < 0) {
      throw httpError(400, 'Enter a valid start time in whole seconds, M:SS, or H:MM:SS.');
    }
    const data = await this.extract(['--flat-playlist', '--playlist-end', '200', '--dump-single-json', '--', url]);
    const playlistId = data.entries ? randomUUID() : null;
    const entries = data.entries || [data];
    const selectedVideo = videoId(new URL(value));
    return entries.filter(e => e && /^[\w-]{11}$/.test(e.id) && e.availability !== 'private' && e.availability !== 'premium_only')
      .map((e, index) => {
        const offset = (!playlistId || (selectedVideo ? e.id === selectedVideo : index === 0)) ? startAt : 0;
        const duration = Number(e.duration) || null;
        if (offset > 0 && duration > 0 && offset >= duration) {
          throw httpError(400, `Start time must be before the end of the video (${duration} seconds).`);
        }
        return makeItem({ kind: 'youtube', url: `https://www.youtube.com/watch?v=${e.id}`, startAt: offset }, {
          title: String(e.title || 'YouTube video').slice(0, 200), duration, startAt: offset,
          thumbnail: `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`, addedBy: user.displayName,
          playlistId, playlistTitle: playlistId ? String(data.title || 'YouTube playlist').slice(0, 200) : null,
        });
      });
  }

  async resolve(url) {
    const data = await this.extract(['--no-playlist', '-f', 'bv*[height<=1080]+ba/b[height<=1080]/best', '--dump-single-json', '--', url]);
    if (data.is_live) throw new Error('Live broadcasts are not supported; use a video or completed livestream.');
    const formats = data.requested_formats || [data];
    const inputs = formats.map(format => {
      const source = new URL(format.url);
      if (source.protocol !== 'https:' || !['googlevideo.com', 'youtube.com'].some(h => source.hostname === h || source.hostname.endsWith(`.${h}`))) {
        throw new Error('yt-dlp returned an unsupported media host.');
      }
      return { url: source.href, headers: format.http_headers || data.http_headers || {} };
    });
    return { inputs, duration: Number(data.duration) || null };
  }

  close() {
    for (const controller of this.pending) controller.abort();
  }
}