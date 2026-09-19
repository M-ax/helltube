import { randomUUID } from 'node:crypto';
import { httpError } from './config.js';
import { makeItem } from './rooms.js';
import { runJSON } from './youtube.js';
import { soundcloudURL } from '../shared/media-source.js';

export class SoundCloud {
  constructor(config) { this.config = config; this.pending = new Set(); }

  async extract(url, playlist = false) {
    if (this.pending.size >= 4) throw httpError(429, 'SoundCloud is busy. Try again shortly.');
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      return await runJSON(this.config.ytdlp, ['--ignore-config', '--no-warnings', '--socket-timeout', '20',
        ...(playlist ? ['--flat-playlist', '--playlist-end', '200'] : ['--no-playlist']),
        '-f', 'bestaudio/best', '--dump-single-json', '--', soundcloudURL(url)], {
        signal: controller.signal, provider: 'SoundCloud',
        failureMessage: 'Could not load this SoundCloud track. Use a public track or playlist and update yt-dlp. Private and subscription-only audio may be unavailable.',
      });
    } catch (error) { throw httpError(502, error.message); }
    finally { this.pending.delete(controller); }
  }

  async items(value, user, startAt = 0) {
    let url;
    try { url = soundcloudURL(value); } catch (error) { throw httpError(400, error.message); }
    if (!Number.isSafeInteger(startAt) || startAt < 0) throw httpError(400, 'Enter a valid start time in whole seconds.');
    const data = await this.extract(url, true);
    const entries = Array.isArray(data.entries) ? data.entries.slice(0, 200) : [data];
    const playlistId = Array.isArray(data.entries) ? randomUUID() : null;
    const items = [];
    for (const entry of entries) {
      if (!entry) continue;
      let track;
      try { track = soundcloudURL(entry.webpage_url || (playlistId ? entry.url : url)); } catch { continue; }
      const duration = Number(entry.duration) > 0 ? Number(entry.duration) : null;
      const start = items.length ? 0 : startAt;
      if (duration && start >= duration) throw httpError(400, 'Start time must be before the end of the track.');
      let thumbnail = null;
      try {
        const image = new URL(entry.thumbnail);
        if (image.protocol === 'https:' && image.hostname.endsWith('.sndcdn.com')) thumbnail = image.href;
      } catch {}
      items.push(makeItem({kind: 'soundcloud', url: track, startAt: start}, {
        title: String(entry.title || 'SoundCloud track').slice(0, 200), duration, thumbnail,
        artist: String(entry.uploader || entry.artist || '').slice(0, 200), audioOnly: true,
        startAt: start, addedBy: user.displayName, playlistId,
        playlistTitle: playlistId ? String(data.title || 'SoundCloud playlist').slice(0, 200) : null,
      }));
    }
    if (!items.length) throw httpError(400, 'No playable SoundCloud tracks were found.');
    return items;
  }

  async resolve(url) {
    const data = await this.extract(url);
    const formats = data.requested_formats || [data];
    const inputs = formats.map(format => {
      const source = new URL(format.url);
      const trustedHost = source.hostname.endsWith('.sndcdn.com') || source.hostname === 'playback.media-streaming.soundcloud.cloud';
      if (source.protocol !== 'https:' || source.username || source.password || source.port || !trustedHost) {
        throw new Error('SoundCloud returned an unsupported media host.');
      }
      return {url: source.href, headers: format.http_headers || data.http_headers || {}};
    });
    return {inputs, duration: Number(data.duration) > 0 ? Number(data.duration) : null};
  }

  close() { for (const controller of this.pending) controller.abort(); }
}
