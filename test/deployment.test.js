import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { backendCommit } from '../server/deployment.js';
import { createApp } from '../server/app.js';
import { start } from './helpers.js';

const current = 'a'.repeat(40);
const newer = 'b'.repeat(40);
const secret = 'edge-secret-'.repeat(4);

test('archive deployments read their saved commit and explicit source revisions take precedence', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'helltube-version-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'dist'));
  const manifest = path.join(root, 'dist/version.json');
  assert.equal(await backendCommit(root, ''), null);
  await writeFile(manifest, JSON.stringify({ commit: current }));
  assert.equal(await backendCommit(root, ''), current);
  assert.equal(await backendCommit(root, newer.toUpperCase()), newer);
  assert.equal(await backendCommit(root, 'invalid'), null);
  await writeFile(manifest, '{malformed');
  assert.equal(await backendCommit(root, ''), null);
});

test('backend version is public, uncached, persisted and tied to the running process', async t => {
  const { api, instance } = await start(t, { backendCommit: current });
  const version = await api('/api/version', { auth: '' });
  assert.equal(version.status, 200);
  assert.equal(version.data.commit, current);
  assert.match(version.response.headers.get('cache-control'), /no-store/);
  assert.deepEqual(instance.store.load('deployment'), [{ id: 'backend', commit: current }]);
  instance.store.save('deployment', 'backend', { id: 'backend', commit: newer });
  assert.equal((await api('/api/version')).data.commit, current);
});

test('only authenticated edge announcements persist and wake the updater, once per changed commit', async t => {
  const { api, instance, dir } = await start(t, { backendCommit: current, edgeProxySecret: secret });
  const notify = (commit, headers = {}) => api('/api/edge/deployment', { method: 'POST', auth: '', body: { commit }, headers });
  const headers = { 'X-Helltube-Edge': secret };
  const file = path.join(dir, 'worker-deployment.json');
  assert.equal((await notify(newer)).status, 403);
  assert.equal((await notify(newer, { 'X-Helltube-Edge': 'forged' })).status, 403);
  for (const commit of [null, 'main', 'bad', 'a'.repeat(41), `${newer}\n`, { commit: newer }]) {
    assert.equal((await notify(commit, headers)).status, 400);
  }
  assert.equal((await notify(current, headers)).status, 200);
  await assert.rejects(stat(file), { code: 'ENOENT' });
  assert.equal((await notify(newer.toUpperCase(), headers)).status, 200);
  const record = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(record.commit, newer);
  assert.deepEqual(instance.store.load('deployment').find(record => record.id === 'worker'), record);
  assert.equal((await api('/api/version')).data.commit, current, 'An announcement must not pretend the running backend changed.');
  const before = await stat(file);
  await Promise.all([notify(newer, headers), notify(newer, headers)]);
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs, 'Duplicate announcements do not retrigger updates.');
  await instance.close();
  const restarted = await createApp({ dataDir: dir, port: 0, backendCommit: newer });
  t.after(() => restarted.close());
  assert.deepEqual(restarted.store.load('deployment').find(value => value.id === 'worker'), record);
  const url = await restarted.listen();
  assert.equal((await (await fetch(`${url}/api/version`)).json()).commit, newer);
  await restarted.close();
});
