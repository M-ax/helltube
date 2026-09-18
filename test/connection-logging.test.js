import test from 'node:test';
import assert from 'node:assert/strict';
import {WebSocket} from 'ws';
import {get} from 'svelte/store';
import {createRealtime} from '../src/lib/realtime.js';
import {disconnectReport, proxyRequestId} from '../server/connection-logging.js';
import {start, until} from './helpers.js';

function capture(t) {
  const logs = [];
  t.mock.method(console, 'log', line => logs.push(JSON.parse(line)));
  return logs;
}

const report = (overrides = {}) => ({
  id: 'report-1', cause: 'socket-close', at: 1700000000000, connectionId: 'old-connection',
  roomId: 'lobby', connectionAgeMs: 5000, lastResponseAgeMs: 2000, attempt: 0, droppedReports: 0,
  online: true, visibility: 'visible', readyState: 3, code: 1006, reason: '', wasClean: false, error: '',
  ...overrides,
});

test('real client reconnects, reports the previous close, and receives acknowledgement without replaying commands', async t => {
  const logs = capture(t);
  const {url, cookie, instance} = await start(t, {maxTranscoders: 0});
  const sockets = [];
  class BrowserSocket extends WebSocket {
    constructor(address) {
      super(address, {headers: {Cookie: cookie, Origin: url}});
      sockets.push(this);
    }
  }
  const client = createRealtime({
    windowTarget: Object.assign(new EventTarget(), {navigator: {onLine: true}, location: new URL(url),
      localStorage: {getItem: () => 'lobby', setItem() {}}}),
    documentTarget: Object.assign(new EventTarget(), {visibilityState: 'visible'}), WebSocketImpl: BrowserSocket,
    request: async () => ({}), onMessage: message => assert.fail(message), onSessionEnded: () => assert.fail('Session ended'),
  });
  t.after(() => client.disconnect());
  client.connect('viewer');
  await until(() => get(client.state).joined);
  const oldConnection = logs.find(entry => entry.event === 'ws.connected');
  sockets[0].close(1012, 'Service restart');
  const diagnostic = await until(() => logs.find(entry => entry.event === 'ws.client-disconnect'));
  await until(() => get(client.state).joined);
  assert.equal(diagnostic.report.connectionId, oldConnection.connectionId);
  assert.notEqual(diagnostic.connectionId, oldConnection.connectionId);
  assert.equal(diagnostic.report.code, 1012);
  assert.equal(diagnostic.report.reason, 'Service restart');
  assert.equal(diagnostic.report.wasClean, true);
  assert.equal(diagnostic.report.roomId, 'lobby');
  assert.equal(diagnostic.userId, oldConnection.userId);
  assert.equal(instance.rooms.get('lobby').members.size, 1);
  sockets[1].close(1000, 'Second close');
  await until(() => logs.filter(entry => entry.event === 'ws.client-disconnect').length === 2);
  await until(() => get(client.state).joined);
  assert.equal(logs.filter(entry => entry.report?.id === diagnostic.report.id).length, 1);
});

test('diagnostic messages work before joining, sanitize text, deduplicate retries and reject invalid input', async t => {
  const logs = capture(t);
  const {connect, cookie} = await start(t, {maxTranscoders: 0});
  const ws = await connect();
  const value = report({reason: 'failed\nhttps://private.test/?token=secret', error: 'wss://user:secret@host/ws ' + 'x'.repeat(1000),
    userId: 'forged', cookie, arbitrary: {secret: 'do not log'}});
  ws.send(JSON.stringify({type: 'client:disconnect', report: value}));
  await until(() => ws.messages.some(message => message.type === 'client:disconnect:ack'));
  const entry = logs.find(entry => entry.event === 'ws.client-disconnect');
  assert.equal(entry.username, 'admin');
  assert.notEqual(entry.userId, 'forged');
  assert.equal(entry.report.reason, 'failed [url]');
  assert.equal(entry.report.error.length, 256);
  assert.equal(entry.report.error.startsWith('[url] '), true);
  assert.equal(JSON.stringify(logs).includes('secret'), false);
  assert.equal(JSON.stringify(logs).includes(cookie), false);
  ws.close();
  const next = await connect();
  next.send(JSON.stringify({type: 'client:disconnect', report: value}));
  await until(() => next.messages.some(message => message.type === 'client:disconnect:ack'));
  assert.equal(logs.filter(entry => entry.event === 'ws.client-disconnect').length, 1);
  next.send(JSON.stringify({type: 'client:disconnect', report: report({id: 'invalid', cause: 'forged'})}));
  await until(() => next.messages.some(message => message.type === 'client:disconnect:error' && message.message === 'Invalid disconnect report.'));
  assert.equal(logs.filter(entry => entry.event === 'ws.client-disconnect').length, 1);
  for (const patch of [{at: -1}, {id: '\n'}, {readyState: 4}, {code: 42}, {online: 'yes'},
    {connectionAgeMs: Infinity}, {roomId: {}}, {attempt: -1}, {droppedReports: 'many'}]) {
    assert.throws(() => disconnectReport(report(patch)), /Invalid disconnect report/);
  }
  // Duplicate submissions are also bounded, even when they produce no new logs.
  for (let i = 0; i < 65; i++) next.send(JSON.stringify({type: 'client:disconnect', report: value}));
  await until(() => next.messages.some(message => message.type === 'client:disconnect:error' && /Too many/.test(message.message)));
});

test('server logs peer closes, heartbeat timeouts, transport errors, backpressure, session expiry and shutdown', async t => {
  const logs = capture(t);
  const intervals = [];
  const setInterval = globalThis.setInterval;
  t.mock.method(globalThis, 'setInterval', (callback, ms, ...args) => {
    intervals.push({callback, ms});
    return setInterval(callback, ms, ...args);
  });
  const serverSockets = [];
  const send = WebSocket.prototype.send;
  t.mock.method(WebSocket.prototype, 'send', function (...args) {
    if (this._isServer && !serverSockets.includes(this)) serverSockets.push(this);
    return send.apply(this, args);
  });
  const {connect, instance, api} = await start(t, {maxTranscoders: 0});
  const first = await connect();
  first.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
  await until(() => instance.rooms.get('lobby').members.size === 1);
  first.close(1000, 'Leaving');
  const closed = await until(() => logs.find(entry => entry.event === 'ws.disconnected'));
  assert.equal(closed.roomId, 'lobby');
  assert.equal(closed.code, 1000);
  assert.equal(closed.reason, 'Leaving');
  assert.equal(closed.cause, 'peer-close');

  await connect();
  serverSockets.at(-1).alive = false;
  // Account-request SSE and WebSockets both have 15-second heartbeats. Advance
  // all matching timers, as the clock would, rather than relying on their order.
  for (const interval of intervals.filter(interval => interval.ms === 15000)) interval.callback();
  await until(() => logs.some(entry => entry.event === 'ws.disconnected' && entry.cause === 'heartbeat-timeout'));

  await connect();
  serverSockets.at(-1).emit('error', Object.assign(new Error('broken\ntransport'), {code: 'ECONNRESET'}));
  await until(() => logs.some(entry => entry.event === 'ws.disconnected' && entry.cause === 'socket-error'));
  assert.equal(logs.find(entry => entry.event === 'ws.error').errorCode, 'ECONNRESET');
  assert.equal(logs.find(entry => entry.event === 'ws.error').error, 'broken transport');

  const slow = await connect();
  Object.defineProperty(serverSockets.at(-1), 'bufferedAmount', {get: () => 2 * 1024 * 1024});
  slow.send(JSON.stringify({type: 'ping', sentAt: 1}));
  await until(() => logs.some(entry => entry.event === 'ws.disconnected' && entry.cause === 'slow-client' && entry.code === 1013));

  await connect();
  await api('/api/logout', {method: 'POST'});
  await until(() => logs.some(entry => entry.event === 'ws.disconnected' && entry.cause === 'session-expired' && entry.code === 1008));
  const login = await api('/api/login', {method: 'POST', body: {username: 'admin', password: 'garbageTime_'}});
  await connect(login.response.headers.get('set-cookie').split(';')[0]);
  await instance.close();
  await until(() => logs.some(entry => entry.event === 'ws.disconnected' && entry.cause === 'server-shutdown'));
  for (const entry of logs) {
    assert.ok(Number.isFinite(Date.parse(entry.timestamp)));
    assert.ok(entry.connectionAgeMs >= 0);
  }
});

test('rejected unauthenticated handshakes log a cause without headers or request URLs', async t => {
  const logs = capture(t);
  const {url} = await start(t, {maxTranscoders: 0});
  const requestId = '1234567890abcdef1234567890abcdef';
  const ws = new WebSocket(url.replace('http', 'ws') + '/ws', {headers: {
    Origin: url, Cookie: 'private-cookie', 'X-Helltube-Request-Id': requestId,
  }});
  await new Promise(resolve => ws.once('error', resolve));
  const entry = logs.find(entry => entry.event === 'ws.upgrade-rejected');
  assert.equal(entry.cause, 'unauthenticated');
  assert.equal(entry.userId, null);
  assert.equal(entry.proxyRequestId, requestId);
  for (const value of ['secret-cookie', 'https://host/?token=secret', [requestId], requestId + '\n']) {
    assert.equal(proxyRequestId({headers: {'x-helltube-request-id': value}}), null);
  }
  assert.equal(JSON.stringify(logs).includes('private-cookie'), false);
});
