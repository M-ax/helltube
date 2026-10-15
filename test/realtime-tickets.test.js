import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {RealtimeTickets, REALTIME_TICKET_TTL} from '../server/realtime-tickets.js';
import {start, until} from './helpers.js';

const frontend = 'https://watch.example.test';
const metal = 'https://metal.example.test';

test('tickets expire, are single-use, bind their origin and login, and retain only a hash', () => {
  let now = 1000;
  let active = true;
  const auth = {token: 'private-session', user: {id: 'viewer'}};
  const accounts = {authenticate: value => active && value === 'session=private-session' ? auth : null};
  const tickets = new RealtimeTickets(accounts, {now: () => now, maxPending: 2, maxPerSession: 2});
  const first = tickets.issue(auth, frontend);
  assert.match(first, /^[a-f0-9]{64}$/);
  assert.equal(tickets.pending.has(first), false);
  assert.equal(tickets.consume(first, 'https://attacker.test'), null);
  assert.equal(tickets.consume(first, frontend), auth);
  assert.equal(tickets.consume(first, frontend), null);
  const expired = tickets.issue(auth, frontend);
  now += REALTIME_TICKET_TTL;
  assert.equal(tickets.consume(expired, frontend), null);
  const revoked = tickets.issue(auth, frontend);
  active = false;
  assert.equal(tickets.consume(revoked, frontend), null);
  assert.equal(tickets.pending.size, 0);
});

test('pending tickets are bounded, pruned on issuance and cleared when sessions are revoked', () => {
  let now = 0;
  let active = true;
  const tickets = new RealtimeTickets({authenticate: () => active}, {now: () => now, maxPending: 3, maxPerSession: 2});
  tickets.issue({token: 'one'}, frontend);
  tickets.issue({token: 'one'}, frontend);
  assert.throws(() => tickets.issue({token: 'one'}, frontend), error => error.status === 429);
  tickets.issue({token: 'two'}, frontend);
  assert.throws(() => tickets.issue({token: 'three'}, frontend), error => error.status === 429);
  now += REALTIME_TICKET_TTL;
  tickets.issue({token: 'one'}, frontend);
  assert.equal(tickets.pending.size, 1);
  active = false;
  tickets.prune();
  assert.equal(tickets.pending.size, 0);
});

async function open(t, url, headers = {}) {
  const socket = new WebSocket(url, {headers});
  socket.messages = [];
  socket.on('message', bytes => socket.messages.push(JSON.parse(bytes)));
  t.after(() => socket.terminate());
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  return socket;
}

async function denied(url, headers = {}) {
  const ws = new WebSocket(url, {headers});
  return new Promise((resolve, reject) => {
    ws.once('open', () => { ws.terminate(); reject(new Error('Unauthorized upgrade succeeded')); });
    ws.once('error', error => { assert.match(error.message, /403/); resolve(); });
  });
}

test('direct sockets authenticate without cookies, restore room access, and respect replay/origin/session checks', async t => {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  const h = await start(t, {bareMetalOrigin: metal, origins: [frontend], edgeProxySecret: 'x'.repeat(32), maxTranscoders: 0});
  const issue = async () => {
    const result = await h.api('/api/realtime-ticket', {method: 'POST', body: {origin: frontend}, headers: {Origin: frontend}});
    assert.equal(result.status, 200);
    assert.equal(result.response.headers.get('cache-control'), 'no-store');
    assert.equal(result.data.realtimeOrigin, metal);
    return result.data.ticket;
  };
  const address = ticket => h.url.replace('http', 'ws') + '/ws?ticket=' + ticket;
  const ticket = await issue();
  assert.equal((await h.api('/api/me?ticket=' + ticket, {auth: ''})).status, 401, 'An upgrade ticket cannot authenticate HTTP');
  await denied(address(ticket), {Origin: 'https://attacker.test'});
  await denied(address(ticket), {Origin: frontend, 'X-Helltube-Edge': 'x'.repeat(32)});
  await denied(address(ticket) + '&ticket=' + ticket, {Origin: frontend});
  const ws = await open(t, address(ticket), {Origin: frontend});
  ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
  await until(() => ws.messages.some(message => message.type === 'state' && message.room.id === 'lobby'));
  await denied(address(ticket), {Origin: frontend, Cookie: h.cookie});
  const racing = await issue();
  const simultaneous = await Promise.allSettled([open(t, address(racing), {Origin: frontend}), open(t, address(racing), {Origin: frontend})]);
  assert.equal(simultaneous.filter(result => result.status === 'fulfilled').length, 1, 'Only one simultaneous upgrade consumes a ticket');
  const revoked = await issue();
  await h.api('/api/logout', {method: 'POST'});
  await until(() => ws.messages.some(message => message.type === 'session-ended'));
  await denied(address(revoked), {Origin: frontend});
  assert.ok(logs.some(event => event.event === 'ws.connected' && event.route === 'direct'));
  assert.ok(logs.some(event => event.event === 'ws.disconnected' && event.cause === 'session-expired'));
  for (const value of [ticket, revoked, h.cookie]) assert.equal(JSON.stringify(logs).includes(value), false);
});

test('an administrator password reset revokes pending tickets and established direct sockets', async t => {
  const h = await start(t, {bareMetalOrigin: metal, origins: [frontend], maxTranscoders: 0});
  const created = await h.api('/api/users', {method: 'POST', body: {username: 'viewer', displayName: 'Viewer',
    password: 'viewer-password', role: 'user'}});
  assert.equal(created.status, 201);
  const login = await h.api('/api/login', {method: 'POST', body: {username: 'viewer', password: 'viewer-password'}});
  const auth = login.response.headers.get('set-cookie').split(';')[0];
  const issue = async () => (await h.api('/api/realtime-ticket', {method: 'POST', auth,
    body: {origin: frontend}, headers: {Origin: frontend}})).data.ticket;
  const address = ticket => h.url.replace('http', 'ws') + '/ws?ticket=' + ticket;
  const ws = await open(t, address(await issue()), {Origin: frontend});
  const pending = await issue();
  const changed = await h.api('/api/users/' + created.data.user.id, {method: 'PATCH', body: {password: 'replacement-password'}});
  assert.equal(changed.status, 200);
  await until(() => ws.messages.some(message => message.type === 'session-ended'));
  await denied(address(pending), {Origin: frontend});
});

test('issuance requires an authenticated allowed origin and negotiates rollback and Strife recipients', async t => {
  const h = await start(t, {bareMetalOrigin: metal, origins: [frontend], maxTranscoders: 0});
  const issue = (origin, extra = {}, auth = h.cookie) => h.api('/api/realtime-ticket', {
    method: 'POST', auth, body: {origin}, headers: {Origin: frontend, ...extra},
  });
  assert.equal((await issue(frontend, {}, '')).status, 401);
  assert.equal((await issue(frontend, {Origin: 'https://attacker.test'})).status, 403);
  assert.equal((await issue(frontend, {Origin: ''})).status, 403);
  assert.equal((await issue('https://attacker.test')).status, 403);
  const loopback = 'http://127.0.0.1:58111';
  assert.deepEqual((await issue(loopback)).data, {mode: 'same-origin'}, 'Older Strife retains its proxy route');
  const direct = await issue(loopback, {'X-Strife-Media-Origin': loopback});
  assert.equal(direct.data.recipientOrigin, loopback);
  const socket = await open(t, h.url.replace('http', 'ws') + '/ws?ticket=' + direct.data.ticket, {Origin: loopback});
  await until(() => socket.messages.some(message => message.type === 'rooms'));
  h.instance.media.config.directWebSocket = false;
  assert.deepEqual((await issue(frontend)).data, {mode: 'same-origin'});
  const legacy = await h.connect();
  assert.equal(legacy.readyState, WebSocket.OPEN);
});
