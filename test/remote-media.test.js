import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RemoteMedia, publicAddress, remoteURL } from '../server/remote-media.js';

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
