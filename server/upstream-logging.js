// Raw extractor/FFmpeg stderr can contain cookie jars, signed URLs and proxy
// credentials. Only recognized codes and categories belong in the journal.
export function upstreamFailure(text = '') {
  const status = /(?:HTTP(?:\s+(?:Error|error|status))?|Server returned)\s*:?\s*([45]\d\d)\b/i.exec(text);
  const causes = [
    ['bot-verification', /confirm.*not a bot|bot verification|sign in.*bot/i],
    ['dns-failure', /name resolution|name or service not known|getaddrinfo|could not resolve/i],
    ['connection-refused', /connection refused|ECONNREFUSED/i],
    ['connection-reset', /connection reset|ECONNRESET/i],
    ['timeout', /timed out|timeout|ETIMEDOUT/i],
    ['network-unreachable', /network is unreachable|no route to host|ENETUNREACH/i],
    ['tls-failure', /certificate verify failed|SSL|TLS/i],
    ['unavailable-format', /requested format.*not available|no video formats/i],
    ['invalid-media', /invalid data|partial file|invalid argument|not on whitelist/i],
    ['authentication-required', /sign in|login required|cookies.*(?:expired|invalid)/i],
  ];
  return {
    cause: causes.find(([, pattern]) => pattern.test(text))?.[0] || (status ? 'http-error' : 'unclassified'),
    httpStatus: status ? Number(status[1]) : null,
  };
}

export function logUpstreamFailure(event, text, fields) {
  console.error(JSON.stringify({timestamp: new Date().toISOString(), event, ...fields, ...upstreamFailure(text)}));
}
