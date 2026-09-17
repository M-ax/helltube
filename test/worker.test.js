import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker } from '../worker.js';
import { securityHeaders } from '../shared/deployment.js';

const frontend = 'https://watch.example.test';
const origin = 'https://media.example.test';
const jobId = '12345678-1234-4234-8234-123456789abc';
const segment = `/media/${jobId}/segment-000001.ts`;
const env = { BARE_METAL_ORIGIN: origin, EDGE_PROXY_SECRET: 'test-edge-secret' };

test('proxy replaces caller client identity with the Cloudflare visitor address', async () => {
  for (const path of ['/api/login', segment]) {
    const h = harness();
    await h.request(path, { headers: { 'CF-Connecting-IP': '192.0.2.10', 'X-Helltube-Client-IP': 'forged' } });
    for (const call of h.calls) assert.equal(call.request.headers.get('X-Helltube-Client-IP'), '192.0.2.10');
    assert.ok(h.calls.length > 0);
    const absent = harness();
    await absent.request(path, { headers: { 'X-Helltube-Client-IP': 'forged' } });
    for (const call of absent.calls) assert.equal(call.request.headers.get('X-Helltube-Client-IP'), null);
  }
});

test('deployment heads-up uses the published manifest and runtime secret, rejecting stale builds and direct proxy attempts', async () => {
  const version = { buildId: '11111111-1111-4111-8111-111111111111', commit: 'a'.repeat(40) };
  const h = harness({ assets: { fetch: async request => {
    assert.equal(new URL(request.url).pathname, '/version.json');
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('Cookie'), null);
    return Response.json(version);
  } }, upstream: async request => {
    assert.equal(request.url, `${origin}/api/edge/deployment`);
    assert.equal(request.method, 'POST');
    assert.equal(request.headers.get('X-Helltube-Edge'), env.EDGE_PROXY_SECRET);
    assert.equal(request.headers.get('Cookie'), null);
    assert.equal(request.headers.get('Origin'), null);
    assert.equal(request.redirect, 'manual');
    assert.deepEqual(await request.json(), { commit: version.commit });
    return Response.json({ ok: true });
  } });
  for (const path of ['/api/edge/deployment', '/API/EDGE/DEPLOYMENT/', '/api/edge/%64eployment', '/internal/deployment']) {
    assert.equal((await h.request(path, { method: 'POST' })).status, 404);
  }
  assert.equal((await h.request('/__deployment')).status, 405);
  assert.equal((await h.request('/__deployment?buildId=old', { method: 'POST' })).status, 409);
  assert.equal(h.calls.length, 0);
  const response = await h.request(`/__deployment?buildId=${version.buildId}`, {
    method: 'POST', body: JSON.stringify({ commit: 'b'.repeat(40) }),
  });
  assert.deepEqual(await response.json(), { ok: true, ...version });
  privateResponse(response);
  await h.request(`/__deployment?buildId=${version.buildId}`, { method: 'POST' });
  assert.equal(h.calls.length, 1, 'Successful announcements are deduplicated in each Worker instance.');
});

test('version checks retry a missed notification without blocking assets or leaking failures', async () => {
  let available = false;
  const h = harness({ assets: { fetch: async () => Response.json({ buildId: 'build', commit: 'a'.repeat(40) }) },
    upstream: () => available ? Response.json({ ok: true }) : new Response('offline', { status: 503 }) });
  assert.equal((await h.request('/version.json')).status, 200);
  await h.settle();
  assert.equal(h.calls.length, 1);
  available = true;
  assert.equal((await h.request('/version.json')).status, 200);
  await h.settle();
  assert.equal(h.calls.length, 2);
  await h.request('/version.json');
  await h.settle();
  assert.equal(h.calls.length, 2);
});

test('deployment notification failures are uncached and do not acknowledge delivery', async () => {
  const h = harness({ assets: { fetch: async () => Response.json({ buildId: 'build', commit: 'a'.repeat(40) }) },
    upstream: () => new Response('sensitive failure', { status: 500 }) });
  const response = await h.request('/__deployment?buildId=build', { method: 'POST' });
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('X-Helltube-Error'), 'deployment-notification-failed');
  assert.equal(await response.text(), 'Upstream unavailable.');
  privateResponse(response);
});

function encrypted(body = 'encrypted segment', init = {}) {
  return new Response(body, { ...init, headers: {
    'Content-Type': 'video/mp2t', 'X-Helltube-Encrypted': 'aes-128', 'Cache-Control': 'no-store', ...init.headers,
  } });
}

function harness({ authorize = () => Response.json({ cacheable: true }), upstream = () => encrypted(), cache, assets } = {}) {
  const calls = [];
  const matches = [];
  const puts = [];
  const entries = new Map();
  const pending = [];
  const worker = createWorker({
    fetch: async (request, options) => {
      calls.push({ request, options });
      return new URL(request.url).pathname.startsWith('/api/edge/media/') ? authorize(request) : upstream(request);
    },
    cache: cache === undefined ? {
      async match(key) {
        matches.push(key);
        return entries.get(key.url)?.clone();
      },
      async put(key, response) {
        puts.push({ key, response: response.clone() });
        const body = await response.arrayBuffer();
        entries.set(key.url, new Response(body, response));
      },
    } : cache,
  });
  return {
    calls, matches, puts, entries,
    request(path = segment, init = {}, settings = {}) {
      return worker.fetch(new Request(`${frontend}${path}`, { ...init, headers: {
        Cookie: 'session=alice', Origin: frontend, 'Sec-Fetch-Site': 'same-origin', ...init.headers,
      } }), { ...env, ASSETS: assets, ...settings }, { waitUntil: promise => pending.push(promise) });
    },
    async settle() { await Promise.all(pending); },
  };
}

function privateResponse(response) {
  assert.match(response.headers.get('Cache-Control'), /no-store/);
  assert.equal(response.headers.get('CDN-Cache-Control'), 'no-store');
  assert.equal(response.headers.get('Cloudflare-CDN-Cache-Control'), 'no-store');
}

function secured(response, bareMetalOrigin = origin) {
  for (const [name, value] of Object.entries(securityHeaders(bareMetalOrigin))) {
    assert.equal(response.headers.get(name), value, name);
  }
}

test('segment cache shares encrypted bytes across identities and query variants, but authorizes every hit', async () => {
  const h = harness();
  for (const [cookie, query] of [['session=alice', '?token=one'], ['session=bob', '?token=two'], ['session=alice', '']]) {
    const response = await h.request(`${segment}${query}`, { headers: { Cookie: cookie, 'X-Helltube-Edge': 'forged' } });
    assert.equal(await response.text(), 'encrypted segment');
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(response.headers.get('Set-Cookie'), null);
    secured(response);
    await h.settle();
  }
  const authorizations = h.calls.filter(call => new URL(call.request.url).pathname.startsWith('/api/edge/media/'));
  assert.equal(authorizations.length, 3);
  assert.deepEqual(authorizations.map(call => call.request.headers.get('Cookie')), ['session=alice', 'session=bob', 'session=alice']);
  for (const { request } of authorizations) {
    assert.equal(request.url, `${origin}/api/edge/media/${jobId}/segment-000001.ts`);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.get('Origin'), frontend);
    assert.equal(request.headers.get('Sec-Fetch-Site'), 'same-origin');
  }
  assert.equal(h.calls.length, 4);
  assert.equal(h.puts.length, 1);
  assert.equal(h.matches.length, 3);
  for (const key of h.matches) {
    assert.equal(key.url, `${frontend}${segment}`);
    assert.equal(key.method, 'GET');
    assert.equal(key.headers.get('Cookie'), null);
  }
  assert.equal(h.puts[0].response.headers.get('Cache-Control'), 'public, max-age=90');
  for (const { request, options } of h.calls) {
    assert.equal(request.headers.get('X-Helltube-Edge'), env.EDGE_PROXY_SECRET);
    assert.equal(request.redirect, 'manual');
    assert.equal(request.cache, 'no-store');
    assert.equal(options.redirect, 'manual');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.cf, undefined, 'The Workers runtime rejects cache overrides combined with no-store.');
  }
});

test('warm cache cannot bypass membership revocation or logout', async () => {
  let status = 200;
  const h = harness({ authorize: () => status === 200 ? Response.json({ cacheable: true }) : new Response('private backend detail', { status }) });
  assert.equal(await (await h.request()).text(), 'encrypted segment');
  await h.settle();
  for (status of [403, 401, 404]) {
    const response = await h.request();
    assert.equal(response.status, status);
    assert.doesNotMatch(await response.text(), /encrypted segment|private backend detail/);
    privateResponse(response);
  }
  assert.equal(h.matches.length, 1);
  assert.equal(h.calls.length, 5);
  assert.equal(h.puts.length, 1);
});

test('authorization denies uploads, malformed decisions, redirects, errors and network failures before cache lookup', async t => {
  for (const [name, authorize, status] of [
    ['upload', () => Response.json({ cacheable: false }), 403],
    ['missing decision', () => Response.json({}), 403],
    ['wrong decision type', () => Response.json({ cacheable: 'true' }), 403],
    ['null', () => Response.json(null), 403],
    ['invalid JSON', () => new Response('not JSON'), 502],
    ['empty body', () => new Response(null, { status: 204 }), 502],
    ['origin error', () => new Response('secret error', { status: 500 }), 502],
    ['redirect', () => Response.redirect(`${origin}/direct/keys/private`, 302), 502],
    ['network error', () => { throw new Error('secret network URL'); }, 502],
  ]) {
    await t.test(name, async () => {
      const h = harness({ authorize });
      h.entries.set(`${frontend}${segment}`, encrypted());
      const response = await h.request();
      assert.equal(response.status, status);
      assert.doesNotMatch(await response.text(), /encrypted segment|secret|private/);
      privateResponse(response);
      secured(response);
      assert.equal(h.calls.length, 1);
      assert.equal(h.matches.length, 0);
      assert.equal(h.puts.length, 0);
    });
  }
});

test('range, HEAD and conditional segment requests authorize then bypass even a warm cache', async t => {
  for (const init of [
    { headers: { Range: 'bytes=0-3' } }, { method: 'HEAD' },
    ...['If-Range', 'If-Match', 'If-None-Match', 'If-Modified-Since', 'If-Unmodified-Since'].map(name => ({ headers: { [name]: 'condition' } })),
  ]) {
    await t.test(JSON.stringify(init), async () => {
      const h = harness({ upstream: request => encrypted(request.method === 'HEAD' ? null : 'live', {
        status: request.headers.has('Range') ? 206 : 200,
      }) });
      h.entries.set(`${frontend}${segment}`, encrypted('cached'));
      const response = await h.request(segment, init);
      assert.equal(await response.text(), init.method === 'HEAD' ? '' : 'live');
      privateResponse(response);
      assert.equal(h.calls.length, 2);
      assert.equal(h.calls[0].request.method, 'GET');
      assert.equal(h.calls[0].request.headers.get('Range'), null);
      assert.equal(h.calls[1].request.method, init.method || 'GET');
      for (const [name, value] of Object.entries(init.headers || {})) assert.equal(h.calls[1].request.headers.get(name), value);
      assert.equal(h.matches.length, 0);
      assert.equal(h.puts.length, 0);
    });
  }
});

test('only complete successful encrypted transport streams without cookies may be cached', async t => {
  for (const [name, upstream] of [
    ['missing marker', () => new Response('plain', { headers: { 'Content-Type': 'video/mp2t' } })],
    ['wrong marker', () => encrypted('plain', { headers: { 'X-Helltube-Encrypted': 'none' } })],
    ['wrong type', () => encrypted('html', { headers: { 'Content-Type': 'text/html' } })],
    ['cookie', () => encrypted('private', { headers: { 'Set-Cookie': 'session=renewed; Secure' } })],
    ['partial', () => encrypted('part', { status: 206 })],
    ['content range', () => encrypted('part', { headers: { 'Content-Range': 'bytes 0-3/100' } })],
    ['missing', () => encrypted('missing', { status: 404 })],
    ['error', () => encrypted('error', { status: 500 })],
    ['redirect', () => Response.redirect(`${origin}/direct/keys/private`, 307)],
    ['not modified', () => new Response(null, { status: 304 })],
  ]) {
    await t.test(name, async () => {
      const h = harness({ upstream });
      for (let i = 0; i < 2; i++) {
        const response = await h.request();
        privateResponse(response);
        await response.text();
        await h.settle();
      }
      assert.equal(h.puts.length, 0);
      assert.equal(h.calls.length, 4);
    });
  }
});

test('playlists and upload metadata proxy without shared caching, retaining direct key URLs', async () => {
  const playlist = `#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="${origin}/direct/keys/${jobId}"\nsegment-000001.ts\n`;
  const h = harness({ upstream: request => new Response(new URL(request.url).pathname.endsWith('.m3u8') ? playlist : '{"ok":true}', {
    headers: { 'Cache-Control': 'public, max-age=3600', 'CDN-Cache-Control': 'public', 'Cloudflare-CDN-Cache-Control': 'public' },
  }) });
  for (const path of [`/media/${jobId}/index.m3u8`, '/api/uploads/id', '/api']) {
    const response = await h.request(path);
    privateResponse(response);
    secured(response);
    const body = await response.text();
    if (path.endsWith('.m3u8')) assert.equal(body, playlist);
  }
  assert.equal(h.matches.length, 0);
  assert.equal(h.puts.length, 0);
  assert.equal(h.calls.length, 3);
});

test('private namespaces, malformed media and upload PUTs never reach origin or static fallback', async () => {
  let assetCalls = 0;
  const h = harness({ assets: { fetch() { assetCalls++; return new Response('app'); } } });
  for (const path of [
    '/direct', '/direct/', '/direct/keys/id', '/direct/uploads/id', '/direct/media/id/segment-000001.ts',
    '/internal', '/internal/uploads/id?key=secret', '/internal-anything', '/media', '/media/',
    `/media/${jobId}/key`, `/media/${jobId}/segment-00001.ts`, `/media/${jobId}/segment-000001.ts/extra`,
    '/media/not-a-uuid/segment-000001.ts', `/media/${jobId}/SEGMENT-000001.ts`, '/ws/extra',
    '/%64irect/keys/id', '/DIRECT/keys/id', '/%69nternal/uploads/id', '/MEDIA/private',
    '/api/%2e%2e%2fdirect/keys/id', '/api//uploads/id', '/%61pi/uploads/id', '//direct/keys/id',
  ]) {
    const response = await h.request(path);
    assert.equal(response.status, 404, path);
    privateResponse(response);
  }
  for (const path of ['/api/uploads/id', '/api/uploads/id/', '/api/Uploads/id', '/api/uploads/%69d']) {
    const response = await h.request(path, { method: 'PUT', body: 'file bytes' });
    assert.ok([404, 405].includes(response.status), path);
    privateResponse(response);
  }
  assert.equal((await h.request(segment, { method: 'POST', body: 'bytes' })).status, 405);
  assert.equal(assetCalls, 0);
  assert.equal(h.calls.length, 0);
  assert.equal(h.matches.length, 0);
  assert.equal(h.puts.length, 0);
});

test('API request and response bodies stream without buffering and preserve origin, cookies, path and query', async () => {
  let upload;
  let download;
  let forwarded;
  const uploadStream = new ReadableStream({ start(controller) { upload = controller; } });
  const downloadStream = new ReadableStream({ start(controller) { download = controller; } });
  const h = harness({ upstream: request => {
    forwarded = request;
    return new Response(downloadStream, { status: 201, headers: { 'Set-Cookie': 'session=new; Secure; HttpOnly' } });
  } });
  const response = await h.request('/api/rooms/lobby/youtube?value=%2Fdirect%2Fkey', {
    method: 'POST', body: uploadStream, duplex: 'half', headers: { 'Content-Type': 'application/json', 'X-Helltube-Edge': 'forged' },
  });
  assert.equal(forwarded.url, `${origin}/api/rooms/lobby/youtube?value=%2Fdirect%2Fkey`);
  assert.equal(forwarded.headers.get('Origin'), frontend);
  assert.equal(forwarded.headers.get('Cookie'), 'session=alice');
  assert.equal(forwarded.headers.get('X-Helltube-Edge'), env.EDGE_PROXY_SECRET);
  assert.equal(forwarded.headers.get('Content-Type'), 'application/json');
  const requestReader = forwarded.body.getReader();
  upload.enqueue(new TextEncoder().encode('{"part":'));
  assert.equal(new TextDecoder().decode((await requestReader.read()).value), '{"part":');
  upload.enqueue(new TextEncoder().encode('true}'));
  upload.close();
  assert.equal(new TextDecoder().decode((await requestReader.read()).value), 'true}');
  assert.equal((await requestReader.read()).done, true);
  const responseReader = response.body.getReader();
  download.enqueue(new TextEncoder().encode('first'));
  assert.equal(new TextDecoder().decode((await responseReader.read()).value), 'first');
  download.close();
  assert.equal((await responseReader.read()).done, true);
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Set-Cookie'), 'session=new; Secure; HttpOnly');
  privateResponse(response);
  assert.equal(h.puts.length, 0);
});

test('cache population does not buffer the segment before returning its streaming response', async () => {
  let download;
  const stream = new ReadableStream({ start(controller) { download = controller; } });
  const h = harness({ upstream: () => encrypted(stream) });
  const response = await h.request();
  const reader = response.body.getReader();
  download.enqueue(new TextEncoder().encode('first bytes'));
  assert.equal(new TextDecoder().decode((await reader.read()).value), 'first bytes');
  assert.equal(h.entries.size, 0);
  download.enqueue(new TextEncoder().encode(' last bytes'));
  download.close();
  assert.equal(new TextDecoder().decode((await reader.read()).value), ' last bytes');
  assert.equal((await reader.read()).done, true);
  await h.settle();
  assert.equal(await (await h.request()).text(), 'first bytes last bytes');
  assert.equal(h.calls.length, 3);
  assert.equal(h.puts.length, 1);
});

test('denied HEAD, ranges and cross-site warm requests never receive cache or origin bytes', async () => {
  const h = harness({ authorize: request => request.headers.get('Cookie') === 'session=alice' &&
    request.headers.get('Origin') === frontend && request.headers.get('Sec-Fetch-Site') === 'same-origin' ?
    Response.json({ cacheable: true }) : new Response(null, { status: 403 }) });
  await (await h.request()).text();
  await h.settle();
  for (const init of [
    { method: 'HEAD', headers: { Cookie: '' } },
    { headers: { Range: 'bytes=0-3', Cookie: 'session=expired' } },
    { headers: { Origin: 'https://evil.example.test', 'Sec-Fetch-Site': 'cross-site' } },
  ]) {
    const response = await h.request(segment, init);
    assert.equal(response.status, 403);
    privateResponse(response);
    assert.doesNotMatch(await response.text(), /encrypted segment/);
  }
  assert.equal(h.calls.length, 5);
  assert.equal(h.matches.length, 1);
  assert.equal(h.puts.length, 1);
});

test('origin redirects remain manual and uncached rather than fetching direct keys', async () => {
  const location = `${origin}/direct/keys/private`;
  const h = harness({ upstream: () => Response.redirect(location, 302) });
  const response = await h.request('/api/redirect');
  assert.equal(response.status, 302);
  assert.equal(response.headers.get('Location'), location);
  privateResponse(response);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.redirect, 'manual');
  assert.equal(h.calls[0].options.redirect, 'manual');
  assert.equal(h.puts.length, 0);
});

test('WebSocket upgrades return the exact 101 object untouched', async () => {
  const upgrade = { status: 101, get headers() { throw new Error('Do not clone a WebSocket response.'); } };
  const h = harness({ upstream: () => upgrade });
  const response = await h.request('/ws', { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'X-Helltube-Edge': 'forged' } });
  assert.equal(response, upgrade);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].request.url, `${origin}/ws`);
  assert.equal(h.calls[0].request.headers.get('Upgrade'), 'websocket');
  assert.equal(h.calls[0].request.headers.get('Origin'), frontend);
  assert.equal(h.calls[0].request.headers.get('Cookie'), 'session=alice');
  assert.equal(h.calls[0].request.headers.get('X-Helltube-Edge'), env.EDGE_PROXY_SECRET);
  assert.equal(h.matches.length, 0);
});

test('static assets receive shared security headers, while asset failures are secure', async () => {
  let received;
  const h = harness({ assets: { async fetch(request) {
    received = request;
    return new Response('<html lang="en">app</html>', { headers: { 'Content-Type': 'text/html', 'Cache-Control': 'public, max-age=60' } });
  } } });
  const response = await h.request('/room/lobby?invite=one');
  assert.equal(received.url, `${frontend}/room/lobby?invite=one`);
  assert.equal(await response.text(), '<html lang="en">app</html>');
  privateResponse(response);
  secured(response);
  assert.equal(h.calls.length, 0);
  const failed = await harness({ assets: { fetch() { throw new Error('private asset failure'); } } }).request('/');
  assert.equal(failed.status, 502);
  privateResponse(failed);
  secured(failed);
});

test('deployment manifest is uncached while fingerprinted frontend assets retain caching', async () => {
  const h = harness({ assets: { async fetch(request) {
    const manifest = new URL(request.url).pathname === '/version.json';
    return new Response(manifest ? '{"buildId":"release"}' : 'app()', { headers: {
      'Content-Type': manifest ? 'application/json' : 'application/javascript',
      'Cache-Control': 'public, max-age=31536000, immutable',
    } });
  } } });
  privateResponse(await h.request('/version.json?check=123'));
  assert.equal((await h.request('/assets/app-hash.js')).headers.get('Cache-Control'), 'public, max-age=31536000, immutable');
  assert.equal(h.calls.length, 0, 'Frontend versions must not be proxied to the backend.');
});

test('invalid origin or missing secret fails closed with generic secure no-store errors', async () => {
  const h = harness();
  for (const BARE_METAL_ORIGIN of ['', undefined, 'not a URL', 'http://media.example.test', 'https://user:pass@media.example.test',
    `${origin}/path`, `${origin}?secret=value`, `${origin}#private`, '//media.example.test']) {
    const response = await h.request('/api/me', {}, { BARE_METAL_ORIGIN });
    assert.equal(response.status, 502, String(BARE_METAL_ORIGIN));
    privateResponse(response);
    assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff');
    assert.doesNotMatch(await response.text(), /pass|secret|media\.example/);
  }
  for (const EDGE_PROXY_SECRET of ['', undefined, '   ', 'bad\r\nvalue']) {
    const response = await h.request(segment, {}, { EDGE_PROXY_SECRET });
    assert.equal(response.status, 502);
    privateResponse(response);
  }
  assert.equal(h.calls.length, 0);
  assert.equal(h.matches.length, 0);
  const failed = await harness({ upstream() { throw new Error('https://secret:password@example.test/?key=private'); } }).request('/api/me');
  assert.equal(failed.status, 502);
  privateResponse(failed);
  assert.doesNotMatch(await failed.text(), /secret|password|private|example/);
});

test('loopback origin supports local verification without changing the forwarded browser Origin', async () => {
  const h = harness();
  await h.request('/api/me', {}, { BARE_METAL_ORIGIN: 'http://127.0.0.1:3000' });
  assert.equal(h.calls[0].request.url, 'http://127.0.0.1:3000/api/me');
  assert.equal(h.calls[0].request.headers.get('Origin'), frontend);
});

test('502 diagnostics distinguish missing and invalid bindings without exposing their values', async t => {
  for (const [binding, values, code] of [
    ['BARE_METAL_ORIGIN', [undefined, ''], 'origin-missing'],
    ['BARE_METAL_ORIGIN', [null, {}, 'not a URL', 'media.example.test', `"${origin}"`, `${origin}\n`,
      `${origin}/sensitive-diagnostic-value`, 'https://sensitive-diagnostic-value:password@media.example.test'], 'origin-invalid'],
    ['EDGE_PROXY_SECRET', [undefined, ''], 'edge-secret-missing'],
    ['EDGE_PROXY_SECRET', [null, {}, '   ', ' sensitive-diagnostic-value', 'sensitive-diagnostic-value\r\n'], 'edge-secret-invalid'],
  ]) {
    await t.test(code, async () => {
      const h = harness();
      for (const value of values) {
        const response = await h.request('/api/me?grant=sensitive-diagnostic-value', {}, { [binding]: value });
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('X-Helltube-Error'), code);
        assert.equal(await response.text(), 'Upstream unavailable.');
        assert.doesNotMatch(JSON.stringify([...response.headers]), /sensitive-diagnostic-value|password/);
        privateResponse(response);
        secured(response, binding === 'BARE_METAL_ORIGIN' ? '' : origin);
      }
      assert.equal(h.calls.length, 0);
      assert.equal(h.matches.length, 0);
    });
  }
});

test('502 diagnostics identify failed operations without leaking requests or exceptions', async t => {
  const fail = () => { throw new Error('https://sensitive-diagnostic-value:password@example.test/?grant=sensitive-diagnostic-value'); };
  for (const [path, options, code] of [
    ['/api/me', { upstream: fail }, 'upstream-request-failed'],
    ['/', { assets: { fetch: fail } }, 'assets-fetch-failed'],
    [segment, { authorize: fail }, 'upstream-request-failed'],
    [segment, { authorize: () => new Response('sensitive-diagnostic-value', { status: 503 }) }, 'media-authorization-failed'],
    [segment, { authorize: () => new Response('sensitive-diagnostic-value') }, 'media-authorization-failed'],
    ['/api/me', { upstream: () => ({ get status() { return fail(); } }) }, 'upstream-response-failed'],
  ]) {
    await t.test(`${path} ${code}`, async () => {
      const h = harness(options);
      const response = await h.request(`${path}?grant=sensitive-diagnostic-value`, {
        headers: { Cookie: 'session=sensitive-diagnostic-value' },
      }, { EDGE_PROXY_SECRET: 'sensitive-diagnostic-value' });
      assert.equal(response.status, 502);
      assert.equal(response.headers.get('X-Helltube-Error'), code);
      assert.equal(await response.text(), 'Upstream unavailable.');
      assert.doesNotMatch(JSON.stringify([...response.headers]), /sensitive-diagnostic-value|password/);
      privateResponse(response);
      secured(response);
      assert.equal(h.matches.length, 0);
      assert.equal(h.puts.length, 0);
    });
  }
});

test('backend responses and ordinary denials are not mislabeled as Worker failures', async () => {
  for (const status of [200, 401, 403, 502]) {
    const response = await harness({ upstream: () => new Response('backend response', { status }) }).request('/api/me');
    assert.equal(response.status, status);
    assert.equal(await response.text(), 'backend response');
    assert.equal(response.headers.get('X-Helltube-Error'), null);
    privateResponse(response);
  }
  for (const status of [401, 403, 404]) {
    const response = await harness({ authorize: () => new Response(null, { status }) }).request();
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Helltube-Error'), null);
  }
  const response = await harness().request('/direct/keys/private');
  assert.equal(response.status, 404);
  assert.equal(response.headers.get('X-Helltube-Error'), null);
});

test('segment TTL defaults safely and is bounded from one to 120 seconds', async () => {
  for (const [SEGMENT_CACHE_TTL, ttl] of [[undefined, 90], ['', 90], ['invalid', 90], ['Infinity', 90], ['30', 30], ['2.8', 2], ['0', 1], ['-5', 1], ['9000', 120]]) {
    const h = harness();
    const response = await h.request(segment, {}, { SEGMENT_CACHE_TTL });
    await response.text();
    await h.settle();
    assert.equal(h.puts[0].response.headers.get('Cache-Control'), `public, max-age=${ttl}`);
    assert.equal(response.headers.get('Cache-Control'), 'private, no-store');
    assert.equal(h.puts[0].response.headers.get('Set-Cookie'), null);
  }
});

test('missing or failing cache stays optional and cannot skip authorization', async () => {
  for (const cache of [null, { async match() { throw new Error('cache unavailable'); }, async put() { throw new Error('cache unavailable'); } }]) {
    const h = harness({ cache });
    const response = await h.request();
    assert.equal(await response.text(), 'encrypted segment');
    await h.settle();
    assert.equal(h.calls.length, 2);
    privateResponse(response);
  }
  let calls = 0;
  const worker = createWorker({ fetch: async request => {
    calls++;
    return new URL(request.url).pathname.startsWith('/api/edge/media/') ? Response.json({ cacheable: true }) : encrypted();
  } });
  assert.equal(await (await worker.fetch(new Request(`${frontend}${segment}`), env)).text(), 'encrypted segment');
  assert.equal(calls, 2);
});

test('unmarked or cookie-bearing existing cache entries never become shared responses', async () => {
  for (const entry of [new Response('old static content'), encrypted('private cached bytes', { headers: { 'Set-Cookie': 'session=other' } })]) {
    const h = harness();
    h.entries.set(`${frontend}${segment}`, entry);
    const response = await h.request();
    assert.equal(await response.text(), 'encrypted segment');
    assert.equal(response.headers.get('Set-Cookie'), null);
    await h.settle();
    assert.equal(h.calls.length, 2);
  }
});
