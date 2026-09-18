import test from 'node:test';
import assert from 'node:assert/strict';
import { AccountRequests, publicRequest, requestAge } from '../server/account-requests.js';
import { Accounts, checkPassword } from '../server/auth.js';
import { start, until } from './helpers.js';

const guest = { username: 'newguest', displayName: 'New Guest', password: 'my-guest-password' };
const receipt = result => result.response.headers.get('set-cookie').split(';')[0];
const token = result => receipt(result).split('=')[1];
const options = { maxTranscoders: 0, ffmpeg: 'missing-test-ffmpeg', ytdlp: 'missing-test-ytdlp' };

async function events(t, url, auth, route = '/api/account-requests/current/events') {
  const controller = new AbortController();
  t.after(() => controller.abort());
  const response = await fetch(`${url}${route}`, { headers: { Cookie: auth }, signal: controller.signal });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  assert.equal(response.headers.get('x-accel-buffering'), 'no');
  const messages = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const reading = (async () => {
    let buffer = '';
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary;
      while ((boundary = buffer.indexOf('\n\n')) >= 0) {
        const event = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = event.split('\n').find(line => line.startsWith('data: '));
        if (data) messages.push(JSON.parse(data.slice(6)));
      }
    }
  })().catch(error => { if (!controller.signal.aborted) throw error; });
  return { messages, async close() { controller.abort(); await reading; } };
}

test('admin approval pushes to the requester and creates a one-use, cookie-authenticated session', async t => {
  const { api, url, cookie, instance } = await start(t, options);
  const queue = await events(t, url, cookie, '/api/account-requests/events');
  const submitted = await api('/api/account-requests', { method: 'POST', auth: '', body: { ...guest, role: 'admin' } });
  assert.equal(submitted.status, 201);
  assert.equal(submitted.data.request.status, 'pending');
  const { id } = submitted.data.request;
  const auth = receipt(submitted);
  assert.match(submitted.response.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/api\/account-requests/);
  assert.equal((await api('/api/me', { auth })).status, 401);
  assert.equal((await api('/api/account-requests/claim', { method: 'POST', auth })).status, 409);
  assert.equal((await api('/api/login', { method: 'POST', auth: '', body: guest })).status, 401);
  const stored = instance.store.load('account-requests')[0];
  assert.equal(await checkPassword(guest.password, stored.passwordHash), true);
  assert.ok(!JSON.stringify(stored).includes(guest.password));
  assert.ok(!JSON.stringify(stored).includes(token(submitted)));
  const queued = (await api('/api/account-requests')).data.requests;
  assert.deepEqual(queued, [submitted.data.request]);
  assert.deepEqual(Object.keys(queued[0]).sort(), ['createdAt', 'displayName', 'expiresAt', 'id', 'status', 'username']);
  await until(() => queue.messages.some(value => value?.requests.some(request => request.id === id)));
  const waiting = await events(t, url, auth);
  await until(() => waiting.messages.some(value => value?.request.status === 'pending'));
  assert.equal((await api(`/api/account-requests/${id}/approve`, { method: 'POST' })).status, 200);
  await until(() => waiting.messages.some(value => value?.request.status === 'approved'));
  assert.equal((await api(`/api/account-requests/${id}/deny`, { method: 'POST' })).status, 409);
  assert.deepEqual((await api('/api/account-requests')).data.requests, []);
  const claimed = await api('/api/account-requests/claim', { method: 'POST', auth });
  assert.equal(claimed.status, 200);
  assert.equal(claimed.data.user.role, 'user');
  assert.equal(claimed.data.user.displayName, guest.displayName);
  const cookies = claimed.response.headers.getSetCookie();
  assert.match(cookies[0], /^session=.*HttpOnly; SameSite=Strict; Path=\//);
  assert.match(cookies[1], /account_request=;.*Max-Age=0/);
  assert.equal((await api('/api/me', { auth: cookies[0].split(';')[0] })).data.user.username, guest.username);
  assert.equal((await api('/api/account-requests/claim', { method: 'POST', auth })).status, 404);
  assert.equal(instance.store.load('account-requests').length, 0);
  await waiting.close();
  await queue.close();
});

test('denial is pushed, removes the password hash, and permits a new request', async t => {
  const { api, url, instance } = await start(t, options);
  const submitted = await api('/api/account-requests', { method: 'POST', auth: '', body: guest });
  const auth = receipt(submitted);
  const waiting = await events(t, url, auth);
  assert.equal((await api(`/api/account-requests/${submitted.data.request.id}/deny`, { method: 'POST' })).status, 200);
  await until(() => waiting.messages.some(value => value?.request.status === 'denied'));
  assert.equal(instance.store.load('account-requests')[0].passwordHash, undefined);
  assert.equal((await api('/api/account-requests/claim', { method: 'POST', auth })).status, 409);
  assert.equal((await api('/api/login', { method: 'POST', auth: '', body: guest })).status, 401);
  assert.equal((await api('/api/account-requests', { method: 'POST', auth, body: guest })).status, 201);
  await waiting.close();
});

test('queue and decisions require an admin, and public status cannot be obtained with a request id', async t => {
  const { api, instance } = await start(t, options);
  const submitted = await api('/api/account-requests', { method: 'POST', auth: '', body: guest });
  const { id } = submitted.data.request;
  await instance.accounts.create({ username: 'viewer', password: 'viewer-password' });
  const viewer = receipt(await api('/api/login', { method: 'POST', body: { username: 'viewer', password: 'viewer-password' } }));
  for (const [auth, status] of [['', 401], [viewer, 403]]) {
    assert.equal((await api('/api/account-requests', { auth })).status, status);
    assert.equal((await api('/api/account-requests/events', { auth })).status, status);
    for (const action of ['approve', 'deny']) {
      assert.equal((await api(`/api/account-requests/${id}/${action}`, { method: 'POST', auth })).status, status);
    }
  }
  for (const auth of ['', `account_request=${id}`, `account_request=${'a'.repeat(64)}`]) {
    assert.equal((await api('/api/account-requests/current', { auth })).data.request, null);
    assert.equal((await api('/api/account-requests/current/events', { auth })).status, 404);
    assert.equal((await api('/api/account-requests/claim', { method: 'POST', auth })).status, 404);
  }
  for (const route of ['/api/account-requests', `/api/account-requests/${id}/approve`, '/api/account-requests/claim']) {
    assert.equal((await api(route, { method: 'POST', body: guest, headers: { Origin: 'https://evil.test' } })).status, 403);
  }
});

test('requests validate credentials and reject racing duplicates and occupied usernames', async t => {
  const { instance } = await start(t, options);
  const requests = instance.accountRequests;
  for (const body of [null, [], { ...guest, username: 'bad name' }, { ...guest, username: 'xy' },
    { ...guest, displayName: ' ' }, { ...guest, displayName: 'x'.repeat(81) },
    { ...guest, password: 'short' }, { ...guest, password: 'x'.repeat(129) }]) {
    await assert.rejects(requests.submit(body), { status: 400 });
  }
  await assert.rejects(requests.submit({ ...guest, username: 'ADMIN' }), { status: 409 });
  const results = await Promise.allSettled([requests.submit(guest), requests.submit({ ...guest, username: 'NEWGUEST' })]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.status, 409);
  const accepted = results.find(result => result.status === 'fulfilled').value;
  await assert.rejects(requests.submit({ ...guest, username: 'another' }, accepted.token), { status: 409 });
  await instance.accounts.create(guest);
  assert.throws(() => requests.decide(accepted.request.id, 'approved', instance.accounts.users[0]), { status: 409 });
  assert.equal(requests.list().length, 1);
});

test('requests, decisions and claims survive database reloads, including expiry and invalidation', async t => {
  const { instance, dir } = await start(t, options);
  const submitted = await instance.accountRequests.submit(guest);
  const accounts = await new Accounts(dir, instance.store).init();
  const requests = new AccountRequests(accounts).init();
  assert.deepEqual(publicRequest(requests.current(submitted.token)), submitted.request);
  requests.decide(submitted.request.id, 'approved', accounts.users[0]);
  const reopenedAccounts = await new Accounts(dir, instance.store).init();
  const admin = reopenedAccounts.users.find(user => user.role === 'admin');
  const reopened = new AccountRequests(reopenedAccounts).init();
  assert.equal(reopened.current(submitted.token).status, 'approved');
  const claimed = reopened.claim(submitted.token);
  assert.equal(claimed.user.displayName, guest.displayName);
  assert.equal(new AccountRequests(reopenedAccounts).init().current(submitted.token), null);
  const next = await reopened.submit({ ...guest, username: 'changed' });
  reopened.decide(next.request.id, 'approved', admin);
  const userId = reopened.current(next.token).userId;
  await reopenedAccounts.update(userId, { password: 'newer-password' });
  assert.throws(() => reopened.claim(next.token), { status: 409 });
  await reopenedAccounts.remove(userId, admin.id);
  assert.throws(() => reopened.claim(next.token), { status: 409 });
  const expired = await reopened.submit({ ...guest, username: 'expired' });
  const record = reopened.requests.get(expired.request.id);
  record.createdAt = Date.now() - requestAge - 1000;
  record.expiresAt = Date.now() - 1000;
  reopened.store.save('account-requests', record.id, record);
  assert.equal(reopened.current(expired.token), null);
  assert.throws(() => reopened.decide(record.id, 'approved', admin), { status: 404 });
  assert.equal(new AccountRequests(reopenedAccounts).init().requests.has(record.id), false);
});

test('normal login consumes approval receipts so logout cannot automatically sign the guest back in', async t => {
  const { api } = await start(t, options);
  const submitted = await api('/api/account-requests', { method: 'POST', auth: '', body: guest });
  await api(`/api/account-requests/${submitted.data.request.id}/approve`, { method: 'POST' });
  assert.equal((await api('/api/login', { method: 'POST', auth: '', body: guest })).status, 200);
  assert.equal((await api('/api/account-requests/claim', { method: 'POST', auth: receipt(submitted) })).status, 404);
});

test('submission rate limits cannot be bypassed with caller-controlled forwarding headers', async t => {
  const { api } = await start(t, options);
  for (let i = 0; i < 5; i++) {
    assert.equal((await api('/api/account-requests', { method: 'POST', auth: '', body: {},
      headers: { 'X-Forwarded-For': `192.0.2.${i}`, 'X-Helltube-Client-IP': `192.0.2.${i}` } })).status, 400);
  }
  assert.equal((await api('/api/account-requests', { method: 'POST', auth: '', body: guest })).status, 429);
});

test('approval and sign-in roll back fully if persistence fails', async t => {
  const { instance } = await start(t, options);
  const { accountRequests: requests, accounts, store } = instance;
  const submitted = await requests.submit(guest);
  const admin = accounts.users.find(user => user.role === 'admin');
  const save = store.save.bind(store);
  const failReview = t.mock.method(store, 'save', (collection, ...args) => {
    if (collection === 'account-requests') throw new Error('simulated disk failure');
    return save(collection, ...args);
  });
  assert.throws(() => requests.decide(submitted.request.id, 'approved', admin), /simulated disk failure/);
  assert.equal(accounts.users.length, 1);
  assert.equal(store.load('users').length, 1);
  assert.equal(requests.current(submitted.token).status, 'pending');
  failReview.mock.restore();
  requests.decide(submitted.request.id, 'approved', admin);
  const sessionsBefore = accounts.sessions.size;
  const remove = store.delete.bind(store);
  const failClaim = t.mock.method(store, 'delete', (collection, ...args) => {
    if (collection === 'account-requests') throw new Error('simulated disk failure');
    return remove(collection, ...args);
  });
  assert.throws(() => requests.claim(submitted.token), /simulated disk failure/);
  assert.equal(accounts.sessions.size, sessionsBefore);
  assert.equal(store.load('sessions').length, sessionsBefore);
  assert.equal(requests.current(submitted.token).status, 'approved');
  failClaim.mock.restore();
  assert.equal(requests.claim(submitted.token).user.username, guest.username);
});

test('expired receipts and revoked admin subscriptions end cleanly before further broadcasts', async t => {
  const { api, url, cookie, instance } = await start(t, options);
  const queue = await events(t, url, cookie, '/api/account-requests/events');
  const submitted = await api('/api/account-requests', { method: 'POST', auth: '', body: guest });
  const waiting = await events(t, url, receipt(submitted));
  const request = instance.accountRequests.requests.get(submitted.data.request.id);
  request.expiresAt = Date.now() - 1;
  instance.accounts.logout(cookie.split('=')[1]);
  instance.accountRequests.prune();
  instance.accountRequests.emit('change');
  await until(() => waiting.messages.includes(null) && queue.messages.includes(null));
  await waiting.close();
  await queue.close();
});
