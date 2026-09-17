export function deploymentOrigin(value = '') {
  if (value === '') return '';
  if (typeof value !== 'string') throw new Error('BARE_METAL_ORIGIN must be an HTTPS origin.');
  let url;
  try { url = new URL(value); } catch { throw new Error('BARE_METAL_ORIGIN must be an HTTPS origin.'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username || url.password || url.pathname !== '/' || url.search || url.hash || value !== value.trim()) {
    throw new Error('BARE_METAL_ORIGIN must contain only an HTTPS origin (HTTP is allowed on loopback for development).');
  }
  return url.origin;
}

export function securityHeaders(bareMetalOrigin = '') {
  const direct = deploymentOrigin(bareMetalOrigin);
  return {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' https://i.ytimg.com https://static-cdn.jtvnw.net https://vod-secure.twitch.tv data:; media-src 'self' blob:${direct ? ` ${direct}` : ''}; worker-src 'self' blob:; connect-src 'self' ws: wss:${direct ? ` ${direct}` : ''}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
  };
}
