// Netscape parsers ignore comments, keeping helper exports usable as ordinary cookie files.
export const COOKIE_USER_AGENT_MARKER = '# Helltube-User-Agent:';

export function validateCookieUserAgent(value) {
  if (typeof value !== 'string' || !/^[\x20-\x7e]{1,1024}$/.test(value) || value !== value.trim()) {
    throw new Error('Invalid browser user agent in YouTube cookie export.');
  }
  return value;
}

export function cookieUserAgent(contents) {
  let userAgent = null;
  for (const line of contents.split(/\r?\n/)) {
    if (!line.startsWith(COOKIE_USER_AGENT_MARKER)) continue;
    if (userAgent !== null || !line.startsWith(COOKIE_USER_AGENT_MARKER + ' ')) {
      throw new Error('Invalid browser user agent in YouTube cookie export.');
    }
    userAgent = validateCookieUserAgent(line.slice(COOKIE_USER_AGENT_MARKER.length + 1));
  }
  return userAgent;
}
