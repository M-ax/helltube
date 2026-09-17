import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeMediaSources } from '../server/hosted-page.js';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RemoteMedia, publicAddress, remoteURL } from '../server/remote-media.js';

test('native media scanning ignores decoys in quoted attributes and raw text', () => {
  const html = `İ<div title='<video src="decoy">'></div>
    <!-- <video src="comment"> -->
    <script data-text=">">"<video src='script'>";</scriptx><video src='still-script'></script>
    <style><audio src="style"></style><textarea><video src="textarea"></textarea>
    <source src="outside"><VIDEO data-src="decoy" SRC="real?x=1>0"></VIDEO>
    <audio><source SRC=second></audio>`;
  assert.deepEqual([...nativeMediaSources(html)].filter(Boolean), ['real?x=1>0', 'second']);
  for (const prefix of ['<!--', '<script>', '<style>', '<div title="']) {
    assert.deepEqual([...nativeMediaSources(`${prefix}<video src='hidden'>`)].filter(Boolean), []);
  }
});

test('maximum-size malformed hosted pages cannot monopolize the event loop', async t => {
  for (const token of ['<video ', '<!--', '<script>']) {
    const malformed = token.repeat(Math.floor(256 * 1024 / token.length));
    const { remote, base } = await pageFixture(t, () => malformed);
    const started = performance.now();
    await assert.rejects(remote.open(`${base}/watch`), /no direct video or audio source/);
    assert.ok(performance.now() - started < 1000, `Malformed ${token} markup must finish within one second.`);
  }
});

test('hosted media rejects local, private, reserved, mapped and non-HTTP addresses', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254',
    '100.64.1.1', '198.18.0.1', '224.0.0.1', '255.255.255.255', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1',
    '2001:db8::1', '2002:7f00:1::', '64:ff9b::7f00:1']) assert.equal(publicAddress(address), false, address);
  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(publicAddress(address), true);
  for (const url of ['file:///secret.mp4', 'ftp://example.com/a.mp4', 'http://user:pass@example.com/video',
    'http://localhost/video', 'http://host.local/video', 'http://127.1/video', 'http://2130706433/video',
    'http://0x7f000001/video', 'http://[::ffff:127.0.0.1]/video']) assert.throws(() => remoteURL(url), { status: 400 });
  assert.equal(remoteURL('http://example.com/movie.mp4?token=abc#fragment').href, 'http://example.com/movie.mp4?token=abc');
});

test('every DNS result must be public and metadata preserves signed queries without exposing them in titles', async () => {
  const remote = new RemoteMedia({ lookup: async () => [{ address: '8.8.8.8', family: 4 }] });
  const [item] = await remote.items('https://media.example/Some%20movie.mp4?signature=secret', { displayName: 'Viewer' }, 12);
  assert.equal(item.title, 'Some movie.mp4');
  assert.equal(item.kind, 'http');
  assert.equal(item.startAt, 12);
  assert.equal(item.source.url, 'https://media.example/Some%20movie.mp4?signature=secret');
  for (const startAt of [-1, null, '2', 1.5]) await assert.rejects(remote.items('https://media.example/file', {}, startAt), { status: 400 });
  remote.lookup = async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }];
  await assert.rejects(remote.resolve('https://media.example/video'), /public Internet/);
  remote.lookup = async () => { throw new Error('lookup failed'); };
  await assert.rejects(remote.resolve('https://media.example/video'), /Could not resolve/);
});

test('HTTP fetching pins DNS, preserves ranges, revalidates redirects and limits loops', async t => {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({ path: req.url, headers: req.headers });
    if (req.url === '/redirect') return res.writeHead(302, { Location: '/file?signature=secret' }).end();
    if (req.url === '/private') return res.writeHead(302, { Location: 'http://127.0.0.1/private.mp4' }).end();
    if (req.url === '/loop') return res.writeHead(302, { Location: '/loop' }).end();
    res.writeHead(206, { 'Content-Range': 'bytes 2-5/10', 'Content-Length': 4, 'Accept-Ranges': 'bytes' }).end('2345');
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const remote = new RemoteMedia();
  const resolved = [];
  t.mock.method(remote, 'resolve', async value => {
    const url = remoteURL(value);
    resolved.push(url.href);
    // Only the fixture's named host is mapped to loopback, after URL validation.
    assert.equal(url.hostname, 'media.test');
    return { url, addresses: [{ address: '127.0.0.1', family: 4 }] };
  });
  const base = `http://media.test:${server.address().port}`;
  const response = await remote.open(`${base}/redirect`, { range: 'bytes=2-5' });
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '2345');
  assert.equal(response.headers['content-range'], 'bytes 2-5/10');
  assert.equal(resolved.length, 2);
  assert.ok(requests.every(req => req.headers.range === 'bytes=2-5' && !req.headers.cookie && !req.headers.authorization));
  assert.equal(requests[1].path, '/file?signature=secret');
  await assert.rejects(remote.open(`${base}/private`), /public Internet/);
  await assert.rejects(remote.open(`${base}/loop`), /redirected too many/);
});

async function pageFixture(t, page) {
  const requests = [];
  const server = createServer((req, res) => {
    requests.push({path: req.url, method: req.method, range: req.headers.range});
    if (req.url.startsWith('/file')) {
      res.writeHead(206, {'Content-Type': 'video/mp4', 'Content-Range': 'bytes 2-5/10',
        'Content-Length': 4, 'Accept-Ranges': 'bytes'}).end('2345');
    } else if (req.url === '/redirect') {
      res.writeHead(302, {Location: '/pages/watch.mp4'}).end();
    } else {
      const html = page(req);
      res.writeHead(req.url.includes('partial') && req.headers.range ? 206 : 200,
        {'Content-Type': 'text/html; charset=utf-8'}).end(html);
    }
  }).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const remote = new RemoteMedia();
  t.mock.method(remote, 'resolve', async value => {
    const url = remoteURL(value);
    assert.equal(url.hostname, 'media.test');
    return {url, addresses: [{address: '127.0.0.1', family: 4}]};
  });
  return {remote, requests, base: `http://media.test:${server.address().port}`};
}

test('HTML watch pages resolve signed native video sources and preserve the original range', async t => {
  const {remote, requests, base} = await pageFixture(t, () => `<!doctype html>
    <!-- <video src="http://127.0.0.1/secret"> -->
    <script>const decoy = '<video src="http://127.0.0.1/private">';</script>
    <video data-src="wrong" src="../file.mp4?signature=keep%2Bthis&amp;expires=tomorrow&#38;part=1&#x26;ok=yes"></video>`);
  const response = await remote.open(`${base}/redirect`, {range: 'bytes=2-5'});
  const chunks = [];
  for await (const chunk of response) chunks.push(chunk);
  assert.equal(Buffer.concat(chunks).toString(), '2345');
  assert.equal(response.headers['content-type'], 'video/mp4');
  assert.equal(response.headers['content-range'], 'bytes 2-5/10');
  assert.equal(requests.at(-1).path, '/file.mp4?signature=keep%2Bthis&expires=tomorrow&part=1&ok=yes');
  assert.equal(requests.at(-1).range, 'bytes=2-5');
});

test('nested sources, HEAD and partial HTML retain the final media request semantics', async t => {
  const {remote, requests, base} = await pageFixture(t, () => `<source src="/ignore.mp4">
    <audio controls><source TYPE='audio/mpeg' SRC='/file.mp3?x=1&amp;y=2'></audio>`);
  for (const method of ['HEAD', 'GET']) {
    const response = await remote.open(`${base}/partial`, {method, range: 'bytes=2-5'});
    const chunks = [];
    for await (const chunk of response) chunks.push(chunk);
    assert.equal(response.statusCode, 206);
    assert.equal(Buffer.concat(chunks).toString(), method === 'HEAD' ? '' : '2345');
    assert.deepEqual(requests.at(-1), {path: '/file.mp3?x=1&y=2', method, range: 'bytes=2-5'});
  }
  assert.ok(requests.some(req => req.path === '/partial' && req.method === 'GET' && !req.range));
});

test('embedded sources cannot reach private addresses, credentials or non-HTTP protocols', async t => {
  let source;
  const {remote, requests, base} = await pageFixture(t, () => `<video src="${source}"></video>`);
  for (source of ['http://127.0.0.1/secret', 'http://169.254.169.254/latest', 'file:///etc/passwd',
    'http://user:password@media.test/file.mp4', 'http&#58;//127.0.0.1/secret', '//localhost/secret']) {
    await assert.rejects(remote.open(`${base}/watch`), /public HTTP or HTTPS/);
  }
  assert.equal(requests.length, 6, 'Only the submitted public page was fetched.');
});

test('non-media pages, oversized HTML and page loops fail with bounded, actionable errors', async t => {
  let html = '<html><a href="/file.mp4">download</a></html>';
  const {remote, requests, base} = await pageFixture(t, () => html);
  await assert.rejects(remote.open(`${base}/watch`), /no direct video or audio source/);
  html = ' '.repeat(256 * 1024) + '<video src="/file.mp4">';
  await assert.rejects(remote.open(`${base}/watch`), /page is too large/);
  html = '<video src="/watch">';
  const before = requests.length;
  await assert.rejects(remote.open(`${base}/watch`), /too many pages/);
  assert.equal(requests.length - before, 6);
});

test('each range resolves the page again so expiring media URLs are not saved as the source', async t => {
  let token = 0;
  const {remote, requests, base} = await pageFixture(t, () => `<video src=/file.mp4?token=${++token}></video>`);
  for (let i = 0; i < 2; i++) {
    const response = await remote.open(`${base}/watch`, {range: 'bytes=2-5'});
    for await (const _chunk of response) { /* Consume the tiny fixture. */ }
  }
  assert.deepEqual(requests.filter(req => req.path.startsWith('/file')).map(req => req.path), ['/file.mp4?token=1', '/file.mp4?token=2']);
});
