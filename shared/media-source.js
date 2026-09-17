const youtubeHosts = ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
const twitchHosts = ['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'go.twitch.tv', 'player.twitch.tv'];

export function sourceKind(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
    if (youtubeHosts.includes(url.hostname)) return 'youtube';
    if (twitchHosts.includes(url.hostname)) return 'twitch';
    return 'http';
  } catch { return null; }
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

export const sourceLabels = { youtube: 'YouTube', twitch: 'Twitch VOD', http: 'Hosted media', upload: 'Local video' };
export const sourceIcons = { youtube: 'youtube', twitch: 'twitch', http: 'link', upload: 'file' };
