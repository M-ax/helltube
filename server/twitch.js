import { httpError } from './config.js';
import { makeItem } from './rooms.js';
import { runJSON } from './youtube.js';
import { twitchURL } from '../shared/media-source.js';
import { parseStartTime, youtubeTimeArgument } from '../shared/youtube-time.js';
import { hlsCopyQuality } from './hls-copy.js';

export class Twitch {
  constructor(config) {
    this.config = config;
    this.pending = new Set();
  }

  async extract(url) {
    if (this.pending.size >= 4) throw httpError(429, 'Twitch is busy. Try again shortly.');
    const controller = new AbortController();
    this.pending.add(controller);
    try {
      // YouTube's cookies and VPN settings must never be used for another provider.
      return await runJSON(this.config.ytdlp, ['--ignore-config', '--no-warnings', '--socket-timeout', '20',
        '--no-playlist', '-f', 'b[height<=1080]/best', '--dump-single-json', '--', twitchURL(url)], {
        signal: controller.signal, provider: 'Twitch',
        failureMessage: 'Could not load this Twitch VOD. Check that it is public and still available, and update yt-dlp.',
      });
    } catch (error) { throw httpError(502, error.message); }
    finally { this.pending.delete(controller); }
  }

  async items(value, user, startAt) {
    let url;
    try { url = twitchURL(value); } catch (error) { throw httpError(400, error.message); }
    if (startAt === undefined) startAt = parseStartTime(youtubeTimeArgument(value) ?? '0');
    if (!Number.isSafeInteger(startAt) || startAt < 0) throw httpError(400, 'Enter a valid start time in whole seconds.');
    const data = await this.extract(url);
    this.checkVod(data);
    const duration = Number(data.duration) > 0 ? Number(data.duration) : null;
    if (startAt > 0 && duration && startAt >= duration) throw httpError(400, 'Start time must be before the end of the VOD.');
    let thumbnail = null;
    try {
      const image = new URL(data.thumbnail);
      if (image.protocol === 'https:' && (image.hostname === 'static-cdn.jtvnw.net' || image.hostname === 'vod-secure.twitch.tv')) thumbnail = image.href;
    } catch {}
    return [makeItem({ kind: 'twitch', url, startAt }, {
      title: String(data.title || 'Twitch VOD').slice(0, 200), duration, startAt, thumbnail, addedBy: user.displayName,
    })];
  }

  checkVod(data) {
    if (data.is_live || data.live_status === 'is_live' || data.live_status === 'is_upcoming') {
      throw httpError(400, 'Live broadcasts are not supported; use a completed Twitch VOD.');
    }
  }

  async resolve(url) {
    const data = await this.extract(url);
    this.checkVod(data);
    const formats = data.requested_formats || [data];
    const inputs = formats.map(format => {
      const source = new URL(format.url);
      if (source.protocol !== 'https:' || source.username || source.password || source.port ||
        !['ttvnw.net', 'twitch.tv', 'twitchcdn.net', 'cloudfront.net'].some(host => source.hostname === host || source.hostname.endsWith(`.${host}`))) {
        throw new Error('Twitch returned an unsupported media host.');
      }
      return { url: source.href, headers: format.http_headers || data.http_headers || {} };
    });
    return { inputs, duration: Number(data.duration) > 0 ? Number(data.duration) : null,
      copyQuality: hlsCopyQuality(formats) };
  }

  close() { for (const controller of this.pending) controller.abort(); }
}
