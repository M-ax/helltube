import { deploymentOrigin, securityHeaders, normalizeCommit } from './shared/deployment.js';
import { publicMediaFile } from './shared/media-files.js';

const mediaPath = /^\/media\/([\da-fA-F]{8}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{4}-[\da-fA-F]{12})\/([^/]+)$/;
const conditionalHeaders = ['Range', 'If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'];

function route(pathname, method) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch { return { status: 404 }; }
  if (/[\\\0]/.test(decoded) || /\/{2}|%(?:2f|5c|25|00)/i.test(pathname)) return { status: 404 };
  if (/^\/direct(?:\/|$)|^\/internal/i.test(decoded)) return { status: 404 };
  if (/^\/api\/edge\/deployment\/?$/i.test(decoded)) return { status: 404 };
  if (pathname === '/__deployment') return method === 'POST' ? { proxy: true, notify: true } : { status: 405 };
  if (/^\/(api|media|ws)(?:\/|$)/i.test(decoded) && decoded !== pathname) return { status: 404 };
  if (/^\/api(?:\/|$)/i.test(pathname)) {
    if (!/^\/api(?:\/|$)/.test(pathname)) return { status: 404 };
    if (method === 'PUT' && /^\/api\/uploads\/[^/]+\/?$/i.test(pathname)) return { status: 405 };
    return { proxy: true };
  }
  if (/^\/ws(?:\/|$)/i.test(pathname)) return pathname === '/ws' ? { proxy: true } : { status: 404 };
  if (/^\/media(?:\/|$)/i.test(pathname)) {
    const match = mediaPath.exec(pathname);
    if (!match || !publicMediaFile.test(match[2])) return { status: 404 };
    if (method !== 'GET' && method !== 'HEAD') return { status: 405 };
    return { proxy: true, segment: match[2] !== 'index.m3u8', jobId: match[1], file: match[2] };
  }
  return { proxy: false };
}

function responseHeaders(response, security, noStore = true) {
  const headers = new Headers(response.headers);
  for (const [name, value] of Object.entries(security)) headers.set(name, value);
  if (noStore) {
    headers.set('Cache-Control', 'private, no-store');
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function failure(status, security, code) {
  const message = status === 502 ? 'Upstream unavailable.' : 'Request denied.';
  const headers = { 'Content-Type': 'text/plain; charset=utf-8' };
  if (status === 502 && code) headers['X-Helltube-Error'] = code;
  return responseHeaders(new Response(message, { status, headers }), security);
}

function cacheable(response) {
  return response?.status === 200 && !response.headers.has('Set-Cookie') && !response.headers.has('Content-Range') &&
    response.headers.get('X-Helltube-Encrypted') === 'aes-128' &&
    ['video/mp2t', 'video/mp4'].includes(response.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase());
}

function segmentTTL(value) {
  const ttl = value === undefined || String(value).trim() === '' ? 90 : Number(value);
  return Number.isFinite(ttl) ? Math.max(1, Math.min(120, Math.floor(ttl))) : 90;
}

export function createWorker({ fetch: fetchOrigin = (request, options) => globalThis.fetch(request, options), cache } = {}) {
  let announced;
  let announcement;
  async function notifyMetal(version, origin, secret) {
    const commit = normalizeCommit(version?.commit);
    if (!commit || !origin || typeof secret !== 'string' || !secret.trim() || secret !== secret.trim() || /[\r\n]/.test(secret)) {
      throw new Error('Deployment notification is not configured.');
    }
    const key = `${origin}/${commit}`;
    if (announced === key) return;
    if (announcement) {
      await announcement;
      if (announced === key) return;
    }
    announcement = (async () => {
      const response = await fetchOrigin(new Request(`${origin}/api/edge/deployment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Helltube-Edge': secret },
        body: JSON.stringify({ commit }), redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(10000),
      }), { redirect: 'manual', cache: 'no-store' });
      if (!response.ok || (await response.json())?.ok !== true) throw new Error('Deployment notification failed.');
      announced = key;
    })();
    try { await announcement; } finally { announcement = null; }
  }

  async function proxy(request, origin, secret, authorizationPath) {
    const source = new URL(request.url);
    const target = new URL(origin);
    target.pathname = authorizationPath || source.pathname;
    target.search = authorizationPath ? '' : source.search;
    const headers = authorizationPath ? new Headers() : new Headers(request.headers);
    if (authorizationPath) {
      for (const name of ['Cookie', 'Origin', 'Sec-Fetch-Site']) {
        if (request.headers.has(name)) headers.set(name, request.headers.get(name));
      }
    }
    headers.delete('Host');
    headers.set('X-Helltube-Edge', secret);
    // Cloudflare supplies this address; discard any caller-supplied private header.
    headers.delete('X-Helltube-Client-IP');
    const clientIP = request.headers.get('CF-Connecting-IP');
    if (clientIP) headers.set('X-Helltube-Client-IP', clientIP);
    headers.set('Cache-Control', 'no-store');
    const method = authorizationPath ? 'GET' : request.method;
    const upstream = new Request(target, {
      method, headers, body: method === 'GET' || method === 'HEAD' ? undefined : request.body,
      duplex: 'half', signal: request.signal, redirect: 'manual', cache: 'no-store',
    });
    return fetchOrigin(upstream, {
      redirect: 'manual', cache: 'no-store',
    });
  }

  return {
    async fetch(request, env = {}, context) {
      let security = securityHeaders('');
      let failureCode = 'worker-error';
      try {
        const url = new URL(request.url);
        const destination = route(url.pathname, request.method);
        if (destination.status) return failure(destination.status, security);
        failureCode = 'origin-invalid';
        const origin = deploymentOrigin(env.BARE_METAL_ORIGIN);
        security = securityHeaders(origin);
        if (!destination.proxy) {
          failureCode = 'assets-fetch-failed';
          const response = await env.ASSETS.fetch(request);
          const fresh = url.pathname === '/version.json' || response.headers.get('Content-Type')?.includes('text/html');
          if (url.pathname === '/version.json' && request.method === 'GET' && response.ok &&
              response.headers.get('Content-Type')?.includes('application/json') && context?.waitUntil) {
            // Browser version checks also retry a heads-up missed during an outage.
            context.waitUntil(response.clone().json().then(version => notifyMetal(version, origin, env.EDGE_PROXY_SECRET)).catch(() => {}));
          }
          return responseHeaders(response, security, fresh);
        }
        if (!origin) return failure(502, security, 'origin-missing');
        const secret = env.EDGE_PROXY_SECRET;
        if (secret === undefined || secret === '') return failure(502, security, 'edge-secret-missing');
        if (typeof secret !== 'string' || !secret.trim() || secret !== secret.trim() || /[\r\n]/.test(secret)) {
          return failure(502, security, 'edge-secret-invalid');
        }

        if (destination.notify) {
          failureCode = 'deployment-notification-failed';
          const manifest = await env.ASSETS.fetch(new Request(new URL('/version.json', url), { cache: 'no-store' }));
          if (!manifest.ok) return failure(502, security, failureCode);
          const version = await manifest.json();
          if (url.searchParams.get('buildId') !== version.buildId) return failure(409, security);
          await notifyMetal(version, origin, secret);
          return responseHeaders(Response.json({ ok: true, buildId: version.buildId, commit: version.commit }), security);
        }

        let segmentCache;
        let key;
        if (destination.segment) {
          failureCode = 'upstream-request-failed';
          const authorization = await proxy(request, origin, secret, `/api/edge/media/${destination.jobId}/${destination.file}`);
          failureCode = 'media-authorization-failed';
          if (!authorization.ok) return failure([401, 403, 404].includes(authorization.status) ? authorization.status : 502, security, failureCode);
          if ((await authorization.json())?.cacheable !== true) return failure(403, security);
          failureCode = 'worker-error';
          if (request.method === 'GET' && !conditionalHeaders.some(name => request.headers.has(name))) {
            segmentCache = cache === undefined ? globalThis.caches?.default : cache;
            key = new Request(`${url.origin}${url.pathname}`);
            if (segmentCache) {
              let hit;
              try { hit = await segmentCache.match(key); } catch { /* Cache availability must not gate authorized streaming. */ }
              if (cacheable(hit)) return responseHeaders(hit, security);
            }
          }
        }

        failureCode = 'upstream-request-failed';
        const response = await proxy(request, origin, secret);
        failureCode = 'upstream-response-failed';
        if (response.status === 101) return response;
        if (segmentCache && cacheable(response)) {
          const headers = new Headers(response.headers);
          headers.set('Cache-Control', `public, max-age=${segmentTTL(env.SEGMENT_CACHE_TTL)}`);
          for (const name of ['CDN-Cache-Control', 'Cloudflare-CDN-Cache-Control', 'Pragma', 'Expires', 'Vary']) headers.delete(name);
          const cached = new Response(response.clone().body, { status: 200, headers });
          const saving = Promise.resolve().then(() => segmentCache.put(key, cached)).catch(() => {});
          context?.waitUntil(saving);
        }
        return responseHeaders(response, security);
      } catch {
        return failure(502, security, failureCode);
      }
    },
  };
}

export default createWorker();
