import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {FetchLoader} from 'hls.js';
import Hls from 'hls.js';
import {DirectAccess} from '../server/direct-access.js';
import {createDeliveryClient, directMediaRequest, uploadTransferUrl, sharedFileUrl} from '../src/lib/delivery.js';

const recipient = 'http://127.0.0.1:54321';
const metal = 'https://metal.example';
const id = '13bbba2f-6c67-42c7-abca-3bdf28241cc5';
const path = `/media/${id}/index.m3u8`;
const manager = new DirectAccess({sessions: new Map()});
const grant = () => manager.issue({token: 'test-secret'}, `media:${id}`, recipient);

test('negotiated media uses the preserved metal origin without changing uploads or shared files', async () => {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 600000;
  let url = `${metal}/direct${path}?grant=${manager.issue({token: 'test-secret'}, `media:${id}`, recipient, expiresAt)}`;
  const client = createDeliveryClient({origin: () => recipient, request: async route => route === '/api/config'
    ? {bareMetalOrigin: recipient, strifeDirectMedia: 1, strifeDirectMediaOrigin: metal} : {url, issuedAt, expiresAt}});
  const config = await client.getConfig();
  const access = await client.resolveMediaAccess(path);
  assert.equal(access.url, url);
  assert.equal(access.secureDirect, true);
  assert.ok(access.renewDeadline > performance.now());
  assert.equal(access.route, 'metal');
  const upload = `${recipient}/direct/uploads/${id}?grant=existing`;
  assert.equal(uploadTransferUrl(id, upload, config), upload);
  const file = `${recipient}/direct/files/${id}?grant=existing`;
  assert.equal(sharedFileUrl(id, file, config), file);
  for (const invalid of [path, url.replace(metal, 'https://foreign.example'),
    url.replace(/grant=.*/, 'grant=legacy'), url.replace(id, '047d987c-5112-45fd-a1a5-1933fdb1d342')]) {
    url = invalid;
    await assert.rejects(client.resolveMediaAccess(path));
  }
});

test('grant deadlines ignore client clock skew and jumps, subtracting response latency', async t => {
  const issuedAt = Date.now();
  const expiresAt = issuedAt + 600000;
  const url = `${metal}/direct${path}?grant=${manager.issue({token: 'test-secret'}, `media:${id}`, recipient, expiresAt)}`;
  let wall = issuedAt;
  t.mock.method(Date, 'now', () => wall);
  for (const skew of [-120000, 120000, 585000, 600000, 601000]) {
    for (const jump of [-3600000, 0, 3600000]) {
      wall = issuedAt + skew;
      let monotonic = 1000;
      const client = createDeliveryClient({origin: () => recipient, now: () => monotonic, request: async route => {
        if (route === '/api/config') return {bareMetalOrigin: recipient, strifeDirectMedia: 1, strifeDirectMediaOrigin: metal};
        monotonic += 750;
        wall += jump;
        return {url, issuedAt, expiresAt};
      }});
      const access = await client.resolveMediaAccess(path);
      assert.equal(access.renewDeadline - monotonic, 599250);
    }
  }
  for (const metadata of [{}, {issuedAt, expiresAt: expiresAt + 1}, {issuedAt: expiresAt, expiresAt},
    {issuedAt: issuedAt - 1, expiresAt}]) {
    const client = createDeliveryClient({origin: () => recipient, request: async route => route === '/api/config'
      ? {bareMetalOrigin: recipient, strifeDirectMedia: 1, strifeDirectMediaOrigin: metal} : {url, ...metadata}});
    await assert.rejects(client.resolveMediaAccess(path), /Invalid or expired/);
  }
  let monotonic = 0;
  const delayed = createDeliveryClient({origin: () => recipient, now: () => monotonic, request: async route => {
    if (route === '/api/config') return {bareMetalOrigin: recipient, strifeDirectMedia: 1, strifeDirectMediaOrigin: metal};
    monotonic += 570001;
    return {url, issuedAt, expiresAt};
  }});
  await assert.rejects(delayed.resolveMediaAccess(path), /Invalid or expired/);
});

test('direct request policy applies to every child and refuses foreign origins, jobs, grants and redirects', () => {
  const source = `${metal}/direct${path}?grant=${grant()}`;
  for (const file of ['index.m3u8', 'key.bin', 'init.mp4', 'segment-000000.ts', 'segment-000001.m4s']) {
    const url = source.replace('index.m3u8', file);
    const request = directMediaRequest(source, {url}, {credentials: 'include', redirect: 'follow'});
    assert.equal(request.credentials, 'omit');
    assert.equal(request.redirect, 'error');
    assert.equal(request.mode, 'cors');
  }
  for (const url of [source.replace(metal, 'https://foreign.example'), source.replace(id, 'other'),
    source + '&extra=1', source.replace('index.m3u8', 'private.mp4'), source + '#fragment']) {
    assert.throws(() => directMediaRequest(source, {url}, {}));
  }
});

test('HLS FetchLoader rejects HTTP redirects before a foreign endpoint receives the grant', async t => {
  globalThis.self = globalThis;
  let loader;
  t.after(() => { loader?.destroy(); delete globalThis.self; });
  let leaked = 0;
  const foreign = createServer((_req, res) => { leaked++; res.end('leaked'); });
  const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  await listen(foreign);
  t.after(() => new Promise(resolve => foreign.close(resolve)));
  const server = createServer((req, res) => {
    res.writeHead(302, {Location: `http://127.0.0.1:${foreign.address().port}${req.url}`});
    res.end();
  });
  await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const source = `http://127.0.0.1:${server.address().port}/direct${path}?grant=${grant()}`;
  loader = new FetchLoader({...Hls.DefaultConfig,
    fetchSetup: (context, init) => directMediaRequest(source, context, init)});
  await new Promise((resolve, reject) => loader.load({url: source, responseType: 'text'},
    {loadPolicy: Hls.DefaultConfig.manifestLoadPolicy.default, timeout: 2000, maxRetry: 0, retryDelay: 0, maxRetryDelay: 0},
    {onSuccess: () => reject(new Error('Redirect unexpectedly followed')), onError: resolve,
      onTimeout: () => reject(new Error('Loader timed out'))}));
  assert.equal(leaked, 0);
});
