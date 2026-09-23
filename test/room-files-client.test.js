import test from 'node:test';
import assert from 'node:assert/strict';
import {transferRoomFile} from '../src/lib/room-files.js';
import {sharedFileUrl, DeliveryError} from '../src/lib/delivery.js';

test('file transfers recover the server offset after an unacknowledged chunk', async () => {
  const file = new File(['hello'], 'notes.txt', {lastModified: 123});
  const saved = {id: 'file-id', name: file.name, size: file.size, lastModified: 123};
  let received = 0;
  let lost = false;
  const chunks = [];
  const statuses = [];
  await transferRoomFile(file, saved, {signal: new AbortController().signal, getConfig: async () => ({bareMetalOrigin: ''}),
    retryWait: async () => {}, onProgress: value => statuses.push(value),
    request: async (url, options = {}) => {
      if (options.method === 'PUT') {
        const offset = Number(new URL(url, 'http://localhost').searchParams.get('offset'));
        assert.equal(offset, received);
        const data = await options.body.text();
        chunks.push(data);
        received += data.length;
        if (!lost) { lost = true; throw new TypeError('Connection lost after write'); }
      }
      return {received, complete: received === file.size, chunkSize: 2};
    }});
  assert.deepEqual(chunks, ['he', 'll', 'o']);
  assert.ok(statuses.some(value => value.retrying));
  assert.equal(statuses.at(-1).complete, true);
});

test('resume rejects different files, invalid offsets, and permanent access errors', async () => {
  const file = new File(['hello'], 'notes.txt', {lastModified: 123});
  const saved = {id: 'id', name: file.name, size: file.size, lastModified: 123};
  const options = {signal: new AbortController().signal};
  await assert.rejects(transferRoomFile(file, {...saved, lastModified: 1}, options), /original file/);
  await assert.rejects(transferRoomFile(file, saved, {...options, request: async () => ({received: 6})}), DeliveryError);
  await assert.rejects(transferRoomFile(file, saved, {...options, request: async () => { throw Object.assign(new Error('Forbidden'), {status: 403}); }}), {status: 403});
  const controller = new AbortController();
  await assert.rejects(transferRoomFile(file, saved, {...options, signal: controller.signal,
    request: async () => { throw new TypeError('Offline'); },
    retryWait: async () => controller.abort()}), {name: 'AbortError'});
});

test('shared file destinations must match the configured origin, exact resource and grant', () => {
  const config = {bareMetalOrigin: 'https://files.example.test'};
  const valid = 'https://files.example.test/direct/files/abc?grant=token';
  assert.equal(sharedFileUrl('abc', valid, config), valid);
  assert.equal(sharedFileUrl('abc', undefined, {bareMetalOrigin: ''}), '/api/files/abc');
  assert.equal(sharedFileUrl('abc', '/api/files/abc/download', {bareMetalOrigin: ''}, true), '/api/files/abc/download');
  for (const value of ['https://evil.test/direct/files/abc?grant=token', valid + '&offset=1',
    valid.replace('/abc?', '/other?'), valid + '#fragment', '/api/files/abc']) {
    assert.throws(() => sharedFileUrl('abc', value, config), DeliveryError);
  }
});
