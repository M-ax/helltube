import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createApp } from '../server/app.js';

export async function start(t, options = {}) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'server-'));
  const instance = await createApp({ dataDir: dir, port: 0, ...options });
  const url = await instance.listen(0);
  t.after(async () => { await instance.close(); await rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }); });
  const login = await fetch(`${url}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'garbageTime_' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const api = async (route, { method = 'GET', body, auth = cookie, headers = {} } = {}) => {
    const response = await fetch(`${url}${route}`, { method, headers: { Cookie: auth, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : Buffer.isBuffer(body) ? body : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), response };
  };
  const connect = async (auth = cookie) => {
    const ws = new WebSocket(url.replace('http', 'ws') + '/ws', { headers: { Cookie: auth, Origin: url } });
    ws.messages = [];
    ws.on('message', bytes => ws.messages.push(JSON.parse(bytes)));
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
    t.after(() => ws.terminate());
    return ws;
  };
  return { instance, url, cookie, api, connect, dir };
}

export async function until(predicate, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await predicate();
    if (value) return value;
    await sleep(50);
  }
  throw new Error(`Condition not met within ${timeout}ms`);
}