import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './config.js';

const sessionId = token => createHash('sha256').update(`helltube-direct-id:${token}`).digest('hex');
const signature = (token, scope) => createHmac('sha256', token).update(`helltube-direct-v1:${scope}`).digest('hex');

export function equalSecret(actual, expected) {
  if (typeof actual !== 'string' || typeof expected !== 'string' || !expected) return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export class DirectAccess {
  constructor(accounts) {
    this.accounts = accounts;
    this.sessions = new Map([...accounts.sessions.keys()].map(token => [sessionId(token), token]));
  }

  issue(auth, scope) {
    const id = sessionId(auth.token);
    this.sessions.set(id, auth.token);
    return `${id}.${signature(auth.token, scope)}`;
  }

  authenticate(grant, scope) {
    if (typeof grant !== 'string' || !/^[a-f0-9]{64}\.[a-f0-9]{64}$/.test(grant)) {
      throw httpError(401, 'Invalid direct access grant. Reload to reconnect.');
    }
    const [id, signed] = grant.split('.');
    const token = this.sessions.get(id);
    if (!token || !equalSecret(signed, signature(token, scope))) throw httpError(401, 'Invalid direct access grant.');
    const auth = this.accounts.authenticate(`session=${token}`);
    if (!auth) {
      this.sessions.delete(id);
      throw httpError(401, 'Session expired. Please sign in.');
    }
    return auth;
  }

  prune() {
    for (const [id, token] of this.sessions) {
      if (!this.accounts.sessions.has(token)) this.sessions.delete(id);
    }
  }
}