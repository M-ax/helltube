import { createHash } from 'node:crypto';
import { sponsorContains } from '../shared/sponsorblock.js';

export function normalizeSponsors(entries, duration) {
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  const ranges = (Array.isArray(entries) ? entries : []).filter(entry =>
    entry?.category === 'sponsor' && entry.actionType === 'skip' &&
    Array.isArray(entry.segment) && entry.segment.length === 2 && entry.segment.every(Number.isFinite) &&
    entry.segment[0] >= 0 && entry.segment[1] > entry.segment[0] &&
    // Edited/replaced videos can have outdated submissions. The API allows a 1s duration difference.
    !(entry.videoDuration > 0 && limit !== Infinity && Math.abs(entry.videoDuration - limit) > 1)
  ).map(entry => [entry.segment[0], Math.min(entry.segment[1], limit)])
    .filter(([start, end]) => end > start).sort((a, b) => a[0] - b[0]);
  const merged = [];
  for (const [start, end] of ranges) {
    const previous = merged.at(-1);
    if (previous && start <= previous[1]) previous[1] = Math.max(previous[1], end);
    else merged.push([start, end]);
  }
  return merged;
}

export class SponsorBlock {
  constructor({ fetchImpl = globalThis.fetch, now = Date.now, timeout = 3000 } = {}) {
    this.fetch = fetchImpl;
    this.now = now;
    this.timeout = timeout;
    this.cache = new Map();
    this.pending = new Map();
    this.closed = false;
  }

  async segments(videoId) {
    if (this.closed || !/^[\w-]{11}$/.test(videoId || '')) return [];
    const cached = this.cache.get(videoId);
    if (cached?.expires > this.now()) return cached.segments;
    if (this.pending.has(videoId)) return this.pending.get(videoId).promise;
    const controller = new AbortController();
    const promise = this.load(videoId, controller).finally(() => this.pending.delete(videoId));
    this.pending.set(videoId, { controller, promise });
    return promise;
  }

  async load(videoId, controller) {
    const timer = setTimeout(() => controller.abort(), this.timeout);
    let segments = [];
    let ttl = 60 * 1000;
    try {
      // Only disclose a hash prefix; look up the exact video in the returned bucket locally.
      const prefix = createHash('sha256').update(videoId).digest('hex').slice(0, 4);
      const url = new URL(`https://sponsor.ajay.app/api/skipSegments/${prefix}`);
      url.searchParams.set('categories', JSON.stringify(['sponsor']));
      url.searchParams.set('actionTypes', JSON.stringify(['skip']));
      url.searchParams.set('service', 'YouTube');
      const response = await this.fetch(url, { signal: controller.signal });
      if (response.status === 404) {
        ttl = 10 * 60 * 1000;
        await response.body?.cancel();
      } else if (response.ok) {
        const data = await response.json();
        if (!Array.isArray(data)) throw new Error('Invalid SponsorBlock response');
        const match = data.find(entry => entry?.videoID === videoId);
        if (match && !Array.isArray(match.segments)) throw new Error('Invalid SponsorBlock segments');
        segments = match?.segments || [];
        ttl = segments.length ? 60 * 60 * 1000 : 10 * 60 * 1000;
      } else await response.body?.cancel();
    } catch { /* SponsorBlock outages must never prevent video playback. */ }
    finally { clearTimeout(timer); }
    if (!this.closed) {
      this.cache.delete(videoId);
      this.cache.set(videoId, { segments, expires: this.now() + ttl });
      while (this.cache.size > 500) this.cache.delete(this.cache.keys().next().value);
    }
    return segments;
  }

  close() {
    this.closed = true;
    for (const { controller } of this.pending.values()) controller.abort();
    this.cache.clear();
  }
}

export function sponsorPlaylist(contents, item, baseTime = 0) {
  if (item.kind !== 'youtube' || !item.sponsorSegments?.length) return contents;
  let position = baseTime;
  // GAP preserves durations, sequence numbers and AES IVs while letting HLS load
  // post-ad content immediately instead of spending bandwidth on skipped fragments.
  return contents.replace(/(^#EXTINF:([\d.]+),[^\r\n]*\r?\n)(segment-\d{6,}\.ts)(?=\r?$)/gm,
    (_match, info, duration, uri) => {
      const end = position + Number(duration);
      const blocked = sponsorContains(item.sponsorSegments, position, end);
      position = end;
      return `${info}${blocked ? '#EXT-X-GAP\n' : ''}${uri}`;
    });
}
