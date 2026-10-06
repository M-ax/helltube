import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { httpError } from './config.js';

const sessionId = token => createHash('sha256').update(`helltube-direct-id:${token}`).digest('hex');
const signature = (token, scope) => createHmac('sha256', token).update(`helltube-direct-v1:${scope}`).digest('hex');

export const MEDIA_GRANT_TTL = 10 * 60 * 1000;
export function strifeMediaOrigin(value) {
  if (typeof value !== 'string' || !/^http:\/\/127\.0\.0\.1:[1-9]\d{0,4}$/.test(value)) return null;
  try { return new URL(value).origin === value ? value : null; } catch { return null; }
}
const mediaSignature = (token, scope, payload) =>
  createHmac('sha256', token).update(`helltube-direct-v2:${scope}:${payload}`).digest('hex');

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

  issue(auth, scope, origin = null, expires = Date.now() + MEDIA_GRANT_TTL) {
    const id = sessionId(auth.token);
    this.sessions.set(id, auth.token);
    if (origin) {
      if (!scope.startsWith('media:') || !strifeMediaOrigin(origin)) throw httpError(400, 'Invalid media recipient.');
      const payload = Buffer.from(JSON.stringify({ origin, expires })).toString('base64url');
      return `v2.${id}.${payload}.${mediaSignature(auth.token, scope, payload)}`;
    }
    return `${id}.${signature(auth.token, scope)}`;
  }

  authenticate(grant, scope, origin) {
    if (typeof grant === 'string' && grant.startsWith('v2.')) {
      const match = /^v2\.([a-f0-9]{64})\.([A-Za-z0-9_-]{1,512})\.([a-f0-9]{64})$/.exec(grant);
      if (!match || !scope.startsWith('media:')) throw httpError(401, 'Invalid media grant.');
      const [, id, payload, signed] = match;
      const token = this.sessions.get(id);
      if (!token || !equalSecret(signed, mediaSignature(token, scope, payload))) throw httpError(401, 'Invalid media grant.');
      let policy;
      try { policy = JSON.parse(Buffer.from(payload, 'base64url').toString()); } catch { throw httpError(401, 'Invalid media grant.'); }
      if (!strifeMediaOrigin(policy.origin) || origin !== policy.origin ||
          !Number.isSafeInteger(policy.expires) || policy.expires <= Date.now() ||
          policy.expires > Date.now() + MEDIA_GRANT_TTL) throw httpError(401, 'Expired or invalid media grant. Retry playback.');
      const auth = this.accounts.authenticate(`session=${token}`);
      if (!auth) throw httpError(401, 'Session expired. Please sign in.');
      return auth;
    }
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