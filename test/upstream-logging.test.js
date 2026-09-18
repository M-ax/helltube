import test from 'node:test';
import assert from 'node:assert/strict';
import {runJSON} from '../server/youtube.js';
import {Media} from '../server/media.js';
import {upstreamFailure} from '../server/upstream-logging.js';

test('upstream classifications retain status and cause without diagnostic secrets', () => {
  for (const [text, cause, httpStatus] of [
    ['HTTP Error 403: Forbidden https://user:secret@host/?token=secret', 'http-error', 403],
    ['HTTP error 429 Too Many Requests', 'http-error', 429],
    ['YouTube said: This playlist type is unviewable.', 'unviewable-playlist', null],
    ['Server returned 503 Service Unavailable', 'http-error', 503],
    ['Sign in to confirm you are not a bot. Cookie: SID=secret', 'bot-verification', null],
    ['getaddrinfo: Temporary failure in name resolution', 'dns-failure', null],
    ['Connection refused', 'connection-refused', null],
    ['Connection reset by peer', 'connection-reset', null],
    ['Connection timed out', 'timeout', null],
    ['Invalid data found when processing input', 'invalid-media', null],
    ['.youtube.com\tTRUE\t/\tTRUE\t123\tSID\tsecret', 'unclassified', null],
  ]) assert.deepEqual(upstreamFailure(text), {cause, httpStatus});
});

test('real extractor failures log status, stage and exit code without stderr or output', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
  const diagnostics = {provider: 'youtube', stage: 'metadata', cookiesConfigured: true, proxyConfigured: true};
  await assert.rejects(runJSON(process.execPath, ['-e',
    'console.error("HTTP Error 403: Forbidden https://user:secret@host/?token=secret\\n.youtube.com\\tTRUE\\t/\\tTRUE\\t123\\tSID\\tsecret");process.exit(7)'],
  {redactErrors: true, diagnostics}), /configured cookies/);
  assert.equal(logs[0].httpStatus, 403);
  assert.equal(logs[0].exitCode, 7);
  assert.equal(logs[0].stage, 'metadata');
  assert.equal(logs[0].event, 'extractor.failed');
  assert.ok(logs[0].durationMs >= 0);
  await assert.rejects(runJSON(process.execPath, ['-e', 'console.log("secret")'], {diagnostics}), /invalid metadata/);
  assert.equal(logs[1].invalidResponse, true);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
  await runJSON(process.execPath, ['-e', 'console.log("{}")'], {diagnostics});
  assert.equal(logs.length, 2);
});

test('real conversion failure identifies the media job and upstream status without raw stderr', async t => {
  const logs = [];
  t.mock.method(console, 'error', line => logs.push(JSON.parse(line)));
  const job = {id: 'job-1', item: {id: 'item-1', kind: 'youtube'}, errors: ''};
  await assert.rejects(Media.prototype.convert.call({config: {ffmpeg: process.execPath}}, job,
    ['-e', 'console.error("HTTP error 403 Forbidden https://host/media?token=secret");process.exit(1)'],
    {proxy: 'http://user:secret@proxy', env: process.env}), /conversion failed/);
  assert.equal(logs[0].event, 'media.conversion-failed');
  assert.equal(logs[0].jobId, 'job-1');
  assert.equal(logs[0].httpStatus, 403);
  assert.equal(logs[0].proxyConfigured, true);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
});
