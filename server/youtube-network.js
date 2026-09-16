export function youtubeNetwork(config) {
  if (!config.youtubeProxy) return { proxy: '', env: undefined };
  let url;
  try { url = new URL(config.youtubeProxy); } catch {}
  if (!url || url.protocol !== 'http:' || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash) {
    throw new Error('YOUTUBE_PROXY must be an HTTP proxy origin without credentials, a path, query, or fragment.');
  }
  // Both urllib and FFmpeg can honor no_proxy even with an explicit proxy option.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key)));
  return { proxy: url.origin, env };
}