import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { BlockList, isIP } from 'node:net';
import { pipeline } from 'node:stream/promises';
import { httpError } from './config.js';
import { makeItem } from './rooms.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]]) {
  blocked.addSubnet(address, prefix, 'ipv4');
}
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
  blocked.addSubnet(address, prefix, 'ipv6');
}

export function publicAddress(address) {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4')
    : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function remoteURL(value) {
  let url;
  try { url = new URL(value); } catch { throw httpError(400, 'Enter a valid HTTP or HTTPS media URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw httpError(400, 'Hosted media requires an HTTP or HTTPS URL without embedded credentials.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
    (isIP(hostname) && !publicAddress(hostname))) throw httpError(400, 'Hosted media must use a public Internet address.');
  url.hash = '';
  return url;
}

export class RemoteMedia {
  constructor({ lookup: lookupHost = lookup } = {}) { this.lookup = lookupHost; }

  async resolve(value) {
    const url = remoteURL(value);
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    let addresses;
    let timer;
    try {
      addresses = await Promise.race([
        this.lookup(hostname, { all: true, verbatim: true }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('DNS timeout')), 10000); }),
      ]);
    } catch { throw httpError(400, 'Could not resolve the hosted media address.'); }
    finally { clearTimeout(timer); }
    if (!addresses.length || addresses.some(({ address }) => !publicAddress(address))) {
      throw httpError(400, 'Hosted media must use a public Internet address.');
    }
    return { url, addresses };
  }

  async items(value, user, startAt = 0) {
    if (!Number.isSafeInteger(startAt) || startAt < 0) throw httpError(400, 'Enter a valid start time in whole seconds.');
    const { url } = await this.resolve(value);
    let title = url.pathname.split('/').filter(Boolean).at(-1) || 'Hosted media';
    try { title = decodeURIComponent(title); } catch {}
    return [makeItem({ kind: 'http', url: url.href, startAt }, { title: title.slice(0, 200), startAt, addedBy: user.displayName })];
  }

  async open(value, { method = 'GET', range, signal } = {}, redirects = 0) {
    const { url, addresses } = await this.resolve(value);
    signal?.throwIfAborted();
    const response = await new Promise((resolve, reject) => {
      const request = (url.protocol === 'https:' ? https : http).request(url, {
        method, signal, agent: false,
        // Pin the validated addresses for this connection to prevent DNS rebinding.
        lookup: (_host, options, callback) => options.all
          ? callback(null, addresses) : callback(null, addresses[0].address, addresses[0].family),
        headers: { 'Accept-Encoding': 'identity', ...(range ? { Range: range } : {}) },
      }, resolve);
      request.setTimeout(120000, () => request.destroy(new Error('Media request timed out.')));
      request.on('error', () => reject(httpError(502, 'Could not fetch the hosted media file.')));
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
      response.destroy();
      if (redirects >= 5 || !response.headers.location) throw httpError(400, 'Hosted media redirected too many times or without a destination.');
      let next;
      try { next = new URL(response.headers.location, url).href; }
      catch { throw httpError(400, 'Hosted media returned an invalid redirect.'); }
      return this.open(next, { method, range, signal }, redirects + 1);
    }
    if (![200, 206, 416].includes(response.statusCode)) {
      response.destroy();
      throw httpError(502, `The hosted media server returned HTTP ${response.statusCode}. Use a public, directly downloadable file.`);
    }
    return response;
  }

  async serve(req, res, value) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    res.on('close', cancel);
    try {
      const upstream = await this.open(value, { method: req.method, range: req.headers.range, signal: controller.signal });
      res.status(upstream.statusCode);
      for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        if (upstream.headers[header]) res.set(header, upstream.headers[header]);
      }
      await pipeline(upstream, res);
    } finally { res.off('close', cancel); }
  }
}
