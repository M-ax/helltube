import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { hashPassword } from './auth.js';
import { httpError, text } from './config.js';

export const requestAge = 7 * 24 * 60 * 60 * 1000;
const tokenHash = token => createHash('sha256').update(token).digest('hex');
const passwordHashPattern = /^[a-f0-9]{32}:[a-f0-9]{128}$/i;

export function publicRequest(request) {
  const { id, username, displayName, status, createdAt, expiresAt } = request;
  return { id, username, displayName, status, createdAt, expiresAt };
}

export class AccountRequests extends EventEmitter {
  constructor(accounts) {
    super();
    this.accounts = accounts;
    this.store = accounts.store;
    this.requests = new Map();
  }

  init() {
    const ids = new Set();
    const tokens = new Set();
    const pendingNames = new Set();
    const requests = this.store.load('account-requests');
    for (const request of requests) {
      if (!request || typeof request.id !== 'string' || !request.id || ids.has(request.id) ||
        typeof request.tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(request.tokenHash) || tokens.has(request.tokenHash) ||
        typeof request.username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(request.username) ||
        typeof request.displayName !== 'string' || !request.displayName.trim() || request.displayName.length > 80 ||
        !['pending', 'approved', 'denied'].includes(request.status) ||
        !Number.isSafeInteger(request.createdAt) || request.createdAt < 0 ||
        !Number.isSafeInteger(request.expiresAt) || request.expiresAt <= request.createdAt ||
        (request.status !== 'denied' && (typeof request.passwordHash !== 'string' || !passwordHashPattern.test(request.passwordHash))) ||
        (request.status === 'approved' && (typeof request.userId !== 'string' || !request.userId)) ||
        (request.status === 'pending' && pendingNames.has(request.username.toLowerCase()))) {
        throw new Error('Invalid account request database; refusing to overwrite it.');
      }
      ids.add(request.id);
      tokens.add(request.tokenHash);
      if (request.status === 'pending') pendingNames.add(request.username.toLowerCase());
    }
    this.requests = new Map(requests.map(request => [request.id, request]));
    this.prune();
    return this;
  }

  prune() {
    const expired = [...this.requests.values()].filter(request => request.expiresAt <= Date.now());
    if (!expired.length) return;
    this.store.transaction(() => {
      for (const request of expired) this.store.delete('account-requests', request.id);
    });
    for (const request of expired) this.requests.delete(request.id);
    this.emit('change');
  }

  current(token) {
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
    const hash = tokenHash(token);
    return [...this.requests.values()].find(request => request.tokenHash === hash && request.expiresAt > Date.now()) || null;
  }

  list() {
    return [...this.requests.values()].filter(request => request.status === 'pending' && request.expiresAt > Date.now())
      .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)).map(publicRequest);
  }

  async submit(body, currentToken) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw httpError(400, 'Invalid account request.');
    const username = text(body.username, 'Username', 32);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw httpError(400, 'Invalid username.');
    const displayName = text(body.displayName, 'Display name');
    const check = () => {
      this.prune();
      if (['pending', 'approved'].includes(this.current(currentToken)?.status)) {
        throw httpError(409, 'You already have an account request. Check its status before submitting another.');
      }
      if (this.accounts.users.some(user => user.username.toLowerCase() === username.toLowerCase()) ||
        this.list().some(request => request.username.toLowerCase() === username.toLowerCase())) {
        throw httpError(409, 'That username is already taken or awaiting approval.');
      }
      if (this.requests.size >= 1000) throw httpError(503, 'The account request queue is full. Please try again later.');
    };
    check();
    const passwordHash = await hashPassword(body.password);
    // Hashing yields; check reservations again before committing.
    check();
    const token = randomBytes(32).toString('hex');
    const createdAt = Date.now();
    const request = { id: randomUUID(), username, displayName, passwordHash, tokenHash: tokenHash(token),
      status: 'pending', createdAt, expiresAt: createdAt + requestAge };
    this.store.save('account-requests', request.id, request);
    this.requests.set(request.id, request);
    this.emit('change');
    return { request: publicRequest(request), token };
  }

  decide(id, decision, actor) {
    if (actor?.role !== 'admin') throw httpError(403, 'Administrator access required.');
    if (!['approved', 'denied'].includes(decision)) throw httpError(400, 'Invalid account request decision.');
    const request = this.requests.get(id);
    if (!request || request.expiresAt <= Date.now()) throw httpError(404, 'Account request not found or expired.');
    if (request.status !== 'pending') throw httpError(409, 'This request has already been reviewed.');
    let user;
    const reviewed = { ...request, status: decision };
    if (decision === 'approved') {
      if (this.accounts.users.some(user => user.username.toLowerCase() === request.username.toLowerCase())) {
        throw httpError(409, 'That username is already taken. Deny this request and ask the guest to choose another.');
      }
      user = { id: randomUUID(), username: request.username, displayName: request.displayName,
        passwordHash: request.passwordHash, role: 'user', defaultPassword: false, preferences: { volume: 0.8, muted: false } };
      reviewed.userId = user.id;
    } else {
      delete reviewed.passwordHash;
    }
    this.store.transaction(() => {
      if (user) this.store.save('users', user.id, user);
      this.store.save('account-requests', id, reviewed);
    });
    if (user) this.accounts.users.push(user);
    this.requests.set(id, reviewed);
    this.emit('change');
    return publicRequest(reviewed);
  }

  claim(token) {
    const request = this.current(token);
    if (!request) throw httpError(404, 'Account request not found or expired.');
    if (request.status !== 'approved') throw httpError(409, 'This account request has not been approved.');
    const user = this.accounts.users.find(user => user.id === request.userId);
    if (!user || user.passwordHash !== request.passwordHash || user.role !== 'user') {
      throw httpError(409, 'This account has changed. Please sign in with your current credentials.');
    }
    const result = this.accounts.createSession(user, () => this.store.delete('account-requests', request.id));
    this.requests.delete(request.id);
    this.emit('change');
    return result;
  }

  completeForUser(userId) {
    const completed = [...this.requests.values()].filter(request => request.userId === userId);
    if (!completed.length) return;
    this.store.transaction(() => {
      for (const request of completed) this.store.delete('account-requests', request.id);
    });
    for (const request of completed) this.requests.delete(request.id);
    this.emit('change');
  }
}
