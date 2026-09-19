const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
const twitchHosts = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv', 'player.twitch.tv'];

export function sourceKind(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (youtubeHosts.includes(url.hostname)) return 'youtube';
    if (twitchHosts.includes(url.hostname)) return 'twitch';
    if (['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com', 'on.soundcloud.com', 'soundcloud.app.goo.gl'].includes(url.hostname)) return 'soundcloud';
    if (url.hostname === 'open.spotify.com') return 'spotify';
    return 'http';
  } catch { return null; }
}

export function youtubeMixVideoURL(value) {
  if (sourceKind(value) !== 'youtube') return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.port) return null;
  const video = url.hostname === 'youtu.be' ? url.pathname.slice(1)
    : /^\/(?:shorts|live)\//.test(url.pathname) ? url.pathname.split('/')[2] : url.searchParams.get('v');
  if (!/^[a-zA-Z0-9_-]{11}$/.test(video || '') ||
    !/^RD[a-zA-Z0-9_-]{8,98}$/.test(url.searchParams.get('list') || '')) return null;
  return `https://www.youtube.com/watch?v=${video}`;
}

export function twitchURL(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('Enter a valid Twitch VOD URL.'); }
  const id = url.hostname === 'player.twitch.tv'
    ? url.searchParams.get('video')?.replace(/^v/, '')
    : /^\/(?:videos|[^/]+\/v(?:ideo)?)\/(\d+)\/?$/.exec(url.pathname)?.[1];
  if (sourceKind(value) !== 'twitch' || url.port || !/^\d+$/.test(id || '')) {
    throw new Error('Paste a Twitch VOD link such as https://www.twitch.tv/videos/123456789. Live channels and clips are not supported.');
  }
  return `https://www.twitch.tv/videos/${id}`;
}

export function soundcloudURL(value) {
  const url = new URL(value);
  const short = ['on.soundcloud.com', 'soundcloud.app.goo.gl'].includes(url.hostname);
  if (sourceKind(value) !== 'soundcloud' || url.port || !(short
    ? /^\/[\w-]+\/?$/.test(url.pathname)
    : /^\/[\w-]+\/(?!sets\/?$)[\w-]+(?:\/[\w-]+)?\/?$/.test(url.pathname))) {
    throw new Error('Paste a SoundCloud track or playlist link.');
  }
  url.protocol = 'https:';
  if (!short) url.hostname = 'soundcloud.com';
  url.search = '';
  url.hash = '';
  return url.href;
}

export function spotifyLink(value) {
  const url = new URL(value);
  const match = /^\/(?:intl-[a-z]{2}\/)?(?:embed\/)?(track|album|playlist|episode|show|artist)\/([a-zA-Z0-9]{22})\/?$/.exec(url.pathname);
  if (sourceKind(value) !== 'spotify' || url.port || !match) throw new Error('Paste a Spotify track, album, playlist, artist, episode, or show link from open.spotify.com.');
  const [, type, id] = match;
  return { type, id, url: `https://open.spotify.com/${type}/${id}`, embed: `https://open.spotify.com/embed/${type}/${id}?theme=0` };
}

export const sourceLabels = { youtube: 'YouTube', twitch: 'Twitch VOD', soundcloud: 'SoundCloud', spotify: 'Spotify', http: 'Hosted media', upload: 'Local video', desktop: 'Live desktop' };
export const sourceIcons = { youtube: 'youtube', twitch: 'twitch', soundcloud: 'music', spotify: 'music', http: 'link', upload: 'file', desktop: 'desktop' };
