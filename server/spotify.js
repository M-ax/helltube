import { httpError } from './config.js';
import { makeItem } from './rooms.js';
import { spotifyLink } from '../shared/media-source.js';

export class Spotify {
  async items(value, user, startAt = 0) {
    let link;
    try { link = spotifyLink(value); } catch (error) { throw httpError(400, error.message); }
    if (startAt !== 0) throw httpError(400, 'Use the Spotify player to choose a start time.');
    let title = `Spotify ${link.type}`;
    try {
      const response = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(link.url)}`, {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (response.ok) {
        const data = await response.json();
        if (typeof data.title === 'string') title = data.title.slice(0, 200);
      }
    } catch { /* The official embed can still play if metadata is unavailable. */ }
    return [makeItem({kind: 'spotify', url: link.url}, {
      title, status: 'ready', audioOnly: true, addedBy: user.displayName,
    })];
  }
}
