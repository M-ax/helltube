import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { httpError } from './config.js';
import { makeItem } from './rooms.js';
import { parseStartTime, youtubeTimeArgument } from '../shared/youtube-time.js';
import { youtubeNetwork } from './youtube-network.js';
import { SponsorBlock, normalizeSponsors } from './sponsorblock.js';
import { hlsCopyQuality } from './hls-copy.js';
import { logUpstreamFailure } from './upstream-logging.js';
import { cookieUserAgent } from '../shared/youtube-cookie-metadata.js';

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
    // YouTube Mix/radio playlists need their seed video. Converting these to
    // /playlist?list=RD... makes YouTube reject an otherwise playable link.
    if (playlist.startsWith('RD') && video && /^[a-zA-Z0-9_-]{11}$/.test(video)) {
      return `https://www.youtube.com/watch?v=${video}&list=${playlist}`;
    }
    return `https://www.youtube.com/playlist?list=${playlist}`;
  }
  if (video && /^[a-zA-Z0-9_-]{11}$/.test(video)) return `https://www.youtube.com/watch?v=${video}`;
  throw httpError(400, 'The URL must identify a YouTube video or playlist.');
}

export function runJSON(command, args, { signal, timeout = 90000, redactErrors = false, env, provider = 'YouTube', failureMessage, diagnostics } = {}) {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(command, args, { windowsHide: true, signal, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let errors = '';
    let failure;
    const timer = setTimeout(() => { failure = new Error(`${provider} extraction timed out.`); child.kill(); }, timeout);
    child.stdout.on('data', data => {
      output += data;
      if (output.length > 16 * 1024 * 1024) { failure = new Error(`${provider} response was too large.`); child.kill(); }
    });
    child.stderr.on('data', data => { errors = (errors + data).slice(-3000); });
    child.on('error', error => { failure ||= error; });
    child.on('close', code => {
      clearTimeout(timer);
      const logFailure = (details, extra = {}) => {
        if (diagnostics) logUpstreamFailure('extractor.failed', details, {
          ...diagnostics, exitCode: code, durationMs: Math.round(performance.now() - started), ...extra,
        });
      };
      if (failure?.name !== 'AbortError' && (failure || code !== 0)) {
        logFailure(failure ? `${failure.code || ''} ${failure.message}` : errors);
      }
      if (failure) return reject(failure);
      if (code !== 0) return reject(new Error(failureMessage || (redactErrors
        ? 'YouTube extraction failed with configured cookies. Refresh the cookies and update yt-dlp; YouTube may still require bot verification. Raw diagnostics are hidden to protect credentials.'
        : errors.trim() || `yt-dlp exited with code ${code}.`)));
      try { resolve(JSON.parse(output)); } catch {
        logFailure('', {invalidResponse: true});
        reject(new Error('yt-dlp returned invalid metadata.'));
      }
    });
  });
}

export class YouTube {
  constructor(config) {
    this.config = config;
    this.pending = new Set();
    this.sponsorBlock = new SponsorBlock();
    this.baseArgs = ['--ignore-config', '--no-warnings', '--socket-timeout', '20', '--js-runtimes', 'node'];
  }

  async extract(args, { signal, timeout } = {}) {
    if (this.pending.size >= 4) throw httpError(429, 'YouTube is busy. Try again shortly.');
    const controller = new AbortController();
    this.pending.add(controller);
    let cookieDir;
    try {
      const network = youtubeNetwork(this.config);
      const proxyArgs = network.proxy ? ['--proxy', network.proxy] : [];
      const cookieArgs = [];
      if (this.config.ytdlpCookiesFile) {
        try {
          cookieDir = await mkdtemp(path.join(os.tmpdir(), 'helltube-youtube-'));
          await chmod(cookieDir, 0o700);
          const cookieFile = path.join(cookieDir, 'cookies.txt');
          // Read the live file for every extraction, then keep that snapshot:
          // atomic refreshes cannot mix cookies and identity or alter an active job.
          const contents = await readFile(this.config.ytdlpCookiesFile);
          const userAgent = cookieUserAgent(contents.toString('utf8'));
          // yt-dlp rewrites its cookie jar; never share it between concurrent extractions.
          await writeFile(cookieFile, contents, { mode: 0o600, flag: 'wx' });
          cookieArgs.push('--cookies', cookieFile);
          if (userAgent) cookieArgs.push('--add-headers', `User-Agent:${userAgent}`);
        } catch {
          throw new Error('Cannot prepare YouTube cookies. Check YTDLP_COOKIES_FILE is readable, any browser user agent is valid, and the temporary directory is writable.');
        }
      }
      return await runJSON(this.config.ytdlp, [...this.baseArgs, ...proxyArgs, ...cookieArgs, ...args], {
        signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal, timeout,
        redactErrors: !!this.config.ytdlpCookiesFile, env: network.env,
        diagnostics: {provider: 'youtube', stage: args.includes('--flat-playlist') ? 'metadata' : 'playback',
          cookiesConfigured: !!this.config.ytdlpCookiesFile, proxyConfigured: !!network.proxy},
      });
    } finally {
      this.pending.delete(controller);
      if (cookieDir) await rm(cookieDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 25 });
    }
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
    const [data, segments] = await Promise.all([
      // Probe the selected streams before handing their URLs to FFmpeg.
      this.extract(['--no-playlist', '--check-formats', '-f', 'bv*+ba/b', '-S', 'res,fps', '--dump-single-json', '--', url]),
      this.sponsorBlock.segments(videoId(new URL(url))),
    ]);
    if (data.is_live) throw new Error('Live broadcasts are not supported; use a video or completed livestream.');
    const formats = data.requested_formats || [data];
    const inputs = formats.map(format => {
      const source = new URL(format.url);
      if (source.protocol !== 'https:' || !['googlevideo.com', 'youtube.com'].some(h => source.hostname === h || source.hostname.endsWith(`.${h}`))) {
        throw new Error('yt-dlp returned an unsupported media host.');
      }
      return { url: source.href, headers: format.http_headers || data.http_headers || {} };
    });
    const duration = Number(data.duration) || null;
    return { inputs, duration, copyQuality: hlsCopyQuality(formats, {allowFiles: true}), sponsorSegments: normalizeSponsors(segments, duration) };
  }

  async liveStreams(channels, { signal } = {}) {
    const results = await Promise.allSettled(channels.map(async channel => {
      const data = await this.extract(['--flat-playlist', '--playlist-end', '12', '--ignore-errors',
        '--dump-single-json', '--', channel.url], { signal, timeout: 30000 });
      return (data.entries || []).filter(entry => entry &&
        (entry.live_status === 'is_live' || entry.is_live === true) && /^[\w-]{11}$/.test(entry.id))
        .map(entry => ({ id: entry.id, channel: channel.name, title: String(entry.title || channel.name).slice(0, 200),
          url: `https://www.youtube.com/watch?v=${entry.id}`, thumbnail: `https://i.ytimg.com/vi/${entry.id}/mqdefault.jpg` }));
    }));
    signal?.throwIfAborted();
    return [...new Map(results.flatMap(result => result.status === 'fulfilled' ? result.value : [])
      .map(stream => [stream.id, stream])).values()];
  }

  async resolveLive(url, { signal } = {}) {
    const data = await this.extract(['--no-playlist', '--no-live-from-start', '-f', 'bv[height<=720]/b[height<=720]/b',
      '--dump-single-json', '--', youtubeURL(url)], { signal, timeout: 30000 });
    if (data.live_status !== 'is_live' && data.is_live !== true) throw new Error('This cartoon is no longer live.');
    const format = data.requested_formats?.[0] || data;
    const source = new URL(format.url);
    if (source.protocol !== 'https:' || source.username || source.password || source.port ||
      !['googlevideo.com', 'youtube.com'].some(host => source.hostname === host || source.hostname.endsWith(`.${host}`))) {
      throw new Error('YouTube returned an unsupported live media host.');
    }
    return { inputs: [{ url: source.href, headers: format.http_headers || data.http_headers || {} }] };
  }

  close() {
    for (const controller of this.pending) controller.abort();
    this.sponsorBlock.close();
  }
}
