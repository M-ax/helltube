import test from 'node:test';
import assert from 'node:assert/strict';
import {api} from '../src/lib/api.js';

test('connection-ticket 401 responses are handled by realtime while other API revocations still dispatch globally', async t => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const target = new EventTarget();
  Object.defineProperty(globalThis, 'window', {configurable: true, value: target});
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, 'window', descriptor);
    else delete globalThis.window;
  });
  let ended = 0;
  target.addEventListener('helltube:session-ended', () => ended++);
  t.mock.method(globalThis, 'fetch', async () => Response.json({error: 'Session expired'}, {status: 401}));
  for (const route of ['/api/login', '/api/me', '/api/realtime-ticket']) {
    await assert.rejects(api(route), error => error.status === 401);
    assert.equal(ended, 0, 'The caller must reject stale session responses before ending a login');
  }
  await assert.rejects(api('/api/rooms'), error => error.status === 401);
  assert.equal(ended, 1);
});
