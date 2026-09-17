import test from 'node:test';
import assert from 'node:assert/strict';
import { deploymentTargets, notifyPublishedWorker } from '../scripts/deploy-worker.mjs';

const version = { commit: 'a'.repeat(40), buildId: '11111111-1111-4111-8111-111111111111' };

test('deployment targets come from structured Wrangler output, including custom domains', () => {
  const output = [{ type: 'wrangler-session' }, { type: 'deploy', targets: ['https://old.example'] },
    { type: 'deploy', targets: ['https://app.example.workers.dev', 'watch.example.com (custom domain)',
      'watch.example.com/*', '*.example.com/*', 'example.com/watch/*'] }].map(value => JSON.stringify(value)).join('\n');
  assert.deepEqual(deploymentTargets(output), ['https://app.example.workers.dev', 'https://watch.example.com']);
  assert.deepEqual(deploymentTargets(output, 'https://override.example'), ['https://override.example']);
  assert.throws(() => deploymentTargets(output, 'https://user:secret@override.example'));
});

test('post-deploy notification retries old builds and outages, without sending local credentials or a caller-selected commit', async () => {
  const responses = [new Response('offline', { status: 502 }), Response.json({ ...version, buildId: 'old', ok: true }),
    Response.json({ ...version, ok: true })];
  let calls = 0;
  let waits = 0;
  await notifyPublishedWorker(['https://watch.example'], version, {
    wait: async () => waits++, fetch: async (url, options) => {
      calls++;
      assert.equal(url.origin, 'https://watch.example');
      assert.equal(url.pathname, '/__deployment');
      assert.equal(url.searchParams.get('buildId'), version.buildId);
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'manual');
      assert.equal(options.headers, undefined);
      assert.equal(options.body, undefined);
      return responses.shift();
    },
  });
  assert.equal(calls, 3);
  assert.equal(waits, 2);
});

test('unacknowledged notifications report that publishing succeeded and never silently pass', async () => {
  await assert.rejects(notifyPublishedWorker([], version), /HELLTUBE_WORKER_ORIGIN/);
  await assert.rejects(notifyPublishedWorker(['https://watch.example'], version, {
    attempts: 1, fetch: async () => { throw new Error('offline'); },
  }), /Worker published, but metal did not acknowledge/);
});
