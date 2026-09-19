import test from 'node:test';
import assert from 'node:assert/strict';
import childProcess, { spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import http from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { YouTube } from '../server/youtube.js';
import { Media } from '../server/media.js';

const proxy = 'http://169.254.77.2:8888';
const extractor = `
  const args = process.argv.slice(1);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => /^(https?|all|no)_proxy$/i.test(key)));
  console.log(JSON.stringify({ args, env, id: 'jNQXAC9IVRw', title: 'VPN video', duration: 19,
    url: 'https://video.googlevideo.com/source' }));
`;

test('YOUTUBE_PROXY is opt-in through the backend environment', () => {
  for (const value of ['', proxy]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e',
      'import { config } from "./server/config.js"; console.log(JSON.stringify(config.youtubeProxy));'], {
      encoding: 'utf8', env: { ...process.env, YOUTUBE_PROXY: value }, timeout: 10000,
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout), value);
  }
});

test('every extraction uses the explicit proxy and removes inherited proxy bypasses', async t => {
  const youtube = new YouTube({ ytdlp: process.execPath, youtubeProxy: proxy });
  youtube.baseArgs = ['--input-type=module', '-e', extractor, '--', ...youtube.baseArgs];
  const previous = process.env.no_proxy;
  process.env.no_proxy = '*';
  t.after(() => { if (previous === undefined) delete process.env.no_proxy; else process.env.no_proxy = previous; });
  const data = await youtube.extract([]);
  assert.equal(data.args[data.args.indexOf('--proxy') + 1], proxy);
  assert.ok(data.args.includes('--ignore-config'));
  assert.deepEqual(data.env, {});
  const recorded = [];
  const extract = youtube.extract.bind(youtube);
  t.mock.method(youtube, 'extract', async args => {
    const result = await extract(args);
    recorded.push(result.args);
    return result;
  });
  await youtube.items('https://youtu.be/jNQXAC9IVRw', { displayName: 'Viewer' });
  await youtube.items('https://youtube.com/playlist?list=PL1234567890123', { displayName: 'Viewer' });
  t.mock.method(youtube.sponsorBlock, 'segments', async () => []);
  await youtube.resolve('https://youtu.be/jNQXAC9IVRw');
  assert.equal(recorded.length, 3);
  for (const args of recorded) assert.equal(args[args.indexOf('--proxy') + 1], proxy);
});

test('invalid proxy settings fail closed without echoing credentials', async () => {
  for (const value of ['socks5://127.0.0.1:8888', 'http://user:secret-marker@localhost:8888',
    'http://localhost/path', 'http://localhost/?x=1', 'http://localhost/#x', 'not-a-url', ' ']) {
    const youtube = new YouTube({ ytdlp: process.execPath, youtubeProxy: value });
    youtube.baseArgs = ['--input-type=module', '-e', extractor, '--'];
    await assert.rejects(youtube.extract([]), error => {
      assert.match(error.message, /YOUTUBE_PROXY/);
      assert.ok(!error.message.includes('secret-marker'));
      return true;
    });
    assert.equal(youtube.pending.size, 0);
  }
});

async function mediaFixture(t, kind, youtubeProxy = proxy) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'youtube-vpn-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'upload.mp4');
  await writeFile(file, Buffer.alloc(512));
  const media = new Media({ dataDir: dir, port: 3000, youtubeProxy, ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg' },
    {}, { secret: 'test', get: () => ({ id: 'upload', file, complete: true }) }, {
      resolve: async () => ({ inputs: [
        { url: 'https://video.invalid/video', headers: {} },
        { url: 'https://audio.invalid/audio', headers: {} },
      ] }),
    });
  const job = { id: 'test', item: { kind, source: { url: 'https://youtu.be/jNQXAC9IVRw', uploadId: 'upload' } },
    dir: path.join(dir, 'media'), keyDir: path.join(dir, 'keys'), key: Buffer.alloc(16), baseTime: 0, errors: '' };
  return { media, job };
}

test('FFmpeg proxies each YouTube input, allows CONNECT, and leaves uploads/direct mode unchanged', async t => {
  for (const [kind, value] of [['youtube', proxy], ['upload', proxy], ['youtube', '']]) {
    const { media, job } = await mediaFixture(t, kind, value);
    let launch;
    const mock = t.mock.method(childProcess, 'spawn', (command, args, options) => {
      launch = { command, args, options };
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      process.nextTick(() => { job.cancelled = true; child.emit('close', 0); });
      return child;
    });
    syncBuiltinESMExports();
    try { await media.run(job); }
    finally { mock.mock.restore(); syncBuiltinESMExports(); }
    const { args, options } = launch;
    const positions = args.flatMap((value, index) => value === '-i' ? [index] : []);
    assert.equal(positions.length, kind === 'youtube' ? 2 : 1);
    if (kind === 'youtube' && value) {
      let start = 0;
      for (const index of positions) {
        const inputArgs = args.slice(start, index);
        assert.equal(inputArgs[inputArgs.indexOf('-http_proxy') + 1], proxy);
        assert.ok(inputArgs[inputArgs.indexOf('-protocol_whitelist') + 1].split(',').includes('httpproxy'));
        start = index + 2;
      }
      assert.deepEqual(Object.keys(options.env).filter(key => /^(https?|all|no)_proxy$/i.test(key)), []);
    } else {
      assert.ok(!args.includes('-http_proxy'));
      assert.equal(options.env, undefined);
      if (kind === 'upload') assert.ok(args.includes('http://127.0.0.1:3000/internal/uploads/upload?key=test'));
    }
  }
});

test('real FFmpeg HTTPS requests reach the proxy despite no_proxy; refusal fails the job', { timeout: 15000 }, async t => {
  const targets = [];
  const server = http.createServer();
  server.on('connect', (request, socket) => {
    targets.push(request.url);
    socket.end('HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const previous = process.env.no_proxy;
  process.env.no_proxy = '*';
  t.after(() => { if (previous === undefined) delete process.env.no_proxy; else process.env.no_proxy = previous; });
  const { media, job } = await mediaFixture(t, 'youtube', `http://127.0.0.1:${server.address().port}`);
  t.mock.method(console, 'error', () => {});
  await assert.rejects(media.run(job), /Video conversion failed/);
  assert.deepEqual(targets, ['video.invalid:443']);
});

test('automatic cartoon mixes proxy only YouTube and require the separate SoundCloud audio track', async t => {
  const {media, job} = await mediaFixture(t, 'youtube');
  job.item.source = {...job.item.source, benZone: true, soundtrackUrl: 'https://soundcloud.com/test/song', maxDuration: 360};
  job.resolveController = new AbortController();
  media.youtube.resolveLive = async () => ({inputs: [{url: 'https://video.googlevideo.com/live', headers: {}}]});
  media.soundcloud = {resolve: async () => ({inputs: [{url: 'https://media.sndcdn.com/song.mp3', headers: {}}], duration: 180})};
  let args;
  t.mock.method(media, 'convert', async (_job, commandArgs) => {args = commandArgs; job.cancelled = true;});
  await media.run(job);
  const inputs = args.flatMap((value, index) => value === '-i' ? [index] : []);
  assert.equal(inputs.length, 2);
  const videoInput = args.slice(0, inputs[0]);
  const audioInput = args.slice(inputs[0] + 2, inputs[1]);
  assert.equal(videoInput[videoInput.indexOf('-http_proxy') + 1], proxy);
  assert.equal(audioInput.includes('-http_proxy'), false);
  assert.ok(audioInput[audioInput.indexOf('-format_whitelist') + 1].split(',').includes('mp3'));
  const mappings = args.flatMap((value, index) => value === '-map' ? [args[index + 1]] : []);
  assert.deepEqual(mappings, ['0:v:0', '1:a:0']);
  assert.equal(args[args.indexOf('-t') + 1], '180');
  assert.ok(args.includes('-shortest'));
  assert.equal(job.original, undefined);
});

test('real FFmpeg HLS segment requests inherit the input proxy', { timeout: 15000 }, async t => {
  const targets = [];
  const server = http.createServer((request, response) => {
    const url = new URL(request.url).href;
    targets.push(url);
    if (url === 'http://playlist.invalid/index.m3u8') {
      response.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      response.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nhttp://segment.invalid/part.ts\n#EXT-X-ENDLIST\n');
    } else {
      response.writeHead(502);
      response.end();
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const { media, job } = await mediaFixture(t, 'youtube', `http://127.0.0.1:${server.address().port}`);
  media.youtube.resolve = async () => ({ inputs: [{ url: 'http://playlist.invalid/index.m3u8', headers: {} }] });
  t.mock.method(console, 'error', () => {});
  await assert.rejects(media.run(job), /Video conversion failed/);
  assert.equal(targets[0], 'http://playlist.invalid/index.m3u8');
  assert.ok(targets.includes('http://segment.invalid/part.ts'), 'Nested segments must also use the proxy');
});
