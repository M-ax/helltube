import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { httpError, text } from './config.js';
import { StateStore } from './store.js';

const scrypt = promisify(scryptCallback);
const sessionAge = 7 * 24 * 60 * 60 * 1000;
const defaultPreferences = { volume: 0.8, muted: false };
const passwordHashPattern = /^[a-f0-9]{32}:[a-f0-9]{128}$/i;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validatePreferences(body) {
  if (!isObject(body) || Object.keys(body).some(key => !['volume', 'muted'].includes(key)) ||
    (Object.hasOwn(body, 'volume') && (typeof body.volume !== 'number' || !Number.isFinite(body.volume) ||
      body.volume < 0 || body.volume > 1)) ||
    (Object.hasOwn(body, 'muted') && typeof body.muted !== 'boolean')) {
    throw httpError(400, 'Invalid preferences: volume must be a number from 0 to 1 and muted must be a boolean.');
  }
}

function validateUsers(users) {
  const invalid = () => { throw new Error('Invalid account database; refusing to overwrite it.'); };
  if (!Array.isArray(users) || !users.length) invalid();
  const ids = new Set();
  const usernames = new Set();
  const result = users.map(user => {
    if (!isObject(user) || typeof user.id !== 'string' || !user.id ||
      typeof user.username !== 'string' || !/^[a-zA-Z0-9_-]{3,32}$/.test(user.username) ||
      typeof user.displayName !== 'string' || !user.displayName.trim() || user.displayName.length > 80 ||
      !['admin', 'user'].includes(user.role) || typeof user.passwordHash !== 'string' ||
      !passwordHashPattern.test(user.passwordHash) ||
      (user.defaultPassword !== undefined && typeof user.defaultPassword !== 'boolean') ||
      ids.has(user.id) || usernames.has(user.username.toLowerCase())) invalid();
    if (user.preferences !== undefined) {
      try {
        validatePreferences(user.preferences);
      } catch {
        invalid();
      }
    }
    ids.add(user.id);
    usernames.add(user.username.toLowerCase());
    return { ...user, defaultPassword: user.defaultPassword ?? false,
      preferences: { ...defaultPreferences, ...user.preferences } };
  });
  if (!result.some(user => user.role === 'admin')) invalid();
  return result;
}

function validateSessions(sessions) {
  const tokens = new Set();
  for (const session of sessions) {
    if (!isObject(session) || typeof session.token !== 'string' || !/^[a-f0-9]{64}$/.test(session.token) ||
      typeof session.userId !== 'string' || !session.userId || typeof session.expires !== 'number' ||
      !Number.isFinite(session.expires) || session.expires < 0 || tokens.has(session.token)) {
      throw new Error('Invalid session database; refusing to overwrite it.');
    }
    tokens.add(session.token);
  }
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 10 || password.length > 128) {
    throw httpError(400, 'Passwords must have 10–128 characters.');
  }
  const salt = randomBytes(16).toString('hex');
  const hash = await scrypt(password, salt, 64);
  return `${salt}:${hash.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 128 ||
    typeof stored !== 'string' || !passwordHashPattern.test(stored)) return false;
  const [salt, hash] = stored.split(':');
  const actual = await scrypt(password, salt, 64);
  return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
}

export function publicUser(user) {
  const { id, username, displayName, role, defaultPassword } = user;
  return { id, username, displayName, role, defaultPassword: !!defaultPassword,
    preferences: { ...defaultPreferences, ...user.preferences } };
}

export class Accounts {
  constructor(dataDir, store) {
    this.store = store || new StateStore(dataDir);
    this.ownsStore = !store;
    this.file = this.store.file;
    this.legacyFile = path.join(dataDir, 'users.json');
    this.users = [];
    this.sessions = new Map();
    this.writes = Promise.resolve();
    this.initialized = false;
  }

  async init() {
    if (this.initialized) return this;
    try {
      if (this.ownsStore) await this.store.init();
      let users = this.store.load('users');
      const sessions = this.store.load('sessions');
      const state = this.store.load('account-state');
      validateSessions(sessions);
      if (state.length > 1 || (state.length && (!isObject(state[0]) || state[0].version !== 1)) ||
        (!users.length && (state.length || sessions.length))) {
        throw new Error('Invalid account database; refusing to overwrite it.');
      }
      if (!users.length) {
        try {
          users = JSON.parse(await readFile(this.legacyFile, 'utf8'));
        } catch (error) {
          if (error.code !== 'ENOENT') throw error;
          try {
            users = JSON.parse(await readFile(`${this.legacyFile}.tmp`, 'utf8'));
          } catch (temporaryError) {
            if (temporaryError.code !== 'ENOENT') throw temporaryError;
            users = [{ id: randomUUID(), username: 'admin', displayName: 'admin', role: 'admin',
              passwordHash: await hashPassword('garbageTime_'), defaultPassword: true }];
          }
        }
      }
      users = validateUsers(users);
      const dummyHash = await hashPassword(randomBytes(32).toString('hex'));
      const ids = new Set(users.map(user => user.id));
      const active = new Map();
      const expired = [];
      const now = Date.now();
      for (const session of sessions) {
        if (session.expires <= now || !ids.has(session.userId)) expired.push(session.token);
        else active.set(session.token, { userId: session.userId, expires: session.expires });
      }
      this.store.transaction(() => {
        for (const user of users) this.store.save('users', user.id, user);
        for (const token of expired) this.store.delete('sessions', token);
        this.store.save('account-state', 'schema', { version: 1 });
      });
      this.users = users;
      this.sessions = active;
      this.dummyHash = dummyHash;
      await rm(this.legacyFile, { force: true });
      await rm(`${this.legacyFile}.tmp`, { force: true });
      this.initialized = true;
      return this;
    } catch (error) {
      if (this.ownsStore) this.store.close();
      throw error;
    }
  }

  save() {
    const users = validateUsers(this.users);
    const ids = new Set(users.map(user => user.id));
    this.store.transaction(() => {
      for (const user of this.store.load('users')) {
        if (!ids.has(user.id)) this.store.delete('users', user.id);
      }
      for (const user of users) this.store.save('users', user.id, user);
    });
    for (let index = 0; index < users.length; index++) Object.assign(this.users[index], users[index]);
    return this.writes;
  }

  async login(username, password) {
    const user = this.users.find(u => u.username.toLowerCase() === String(username).toLowerCase());
    const passwordHash = user?.passwordHash || this.dummyHash;
    const valid = await checkPassword(password, passwordHash);
    if (!user || !valid || !this.users.includes(user) || user.passwordHash !== passwordHash) {
      throw httpError(401, 'Invalid username or password.');
    }
    return this.createSession(user);
  }

  // persist can consume a one-time sign-in grant in the same transaction.
  createSession(user, persist = () => {}) {
    if (!this.users.includes(user)) throw httpError(401, 'Account no longer exists.');
    const now = Date.now();
    const expired = [...this.sessions].filter(([, session]) => session.expires <= now).map(([token]) => token);
    if (this.sessions.size - expired.length >= 10000) throw httpError(503, 'Too many active sessions.');
    const token = randomBytes(32).toString('hex');
    const session = { userId: user.id, expires: now + sessionAge };
    this.store.transaction(() => {
      for (const expiredToken of expired) this.store.delete('sessions', expiredToken);
      this.store.save('sessions', token, { token, ...session });
      persist();
    });
    for (const expiredToken of expired) this.sessions.delete(expiredToken);
    this.sessions.set(token, session);
    return { user, token };
  }

  authenticate(cookie = '') {
    const token = cookie.split(';').map(s => s.trim()).find(s => s.startsWith('session='))?.slice(8);
    const session = this.sessions.get(token);
    if (!session) return null;
    const user = this.users.find(u => u.id === session.userId);
    if (session.expires <= Date.now() || !user) {
      this.logout(token);
      return null;
    }
    return { user, token };
  }

  logout(token) {
    if (typeof token !== 'string') return false;
    this.store.delete('sessions', token);
    return this.sessions.delete(token);
  }

  revoke(userId, except) {
    const revoked = [...this.sessions]
      .filter(([token, session]) => session.userId === userId && token !== except).map(([token]) => token);
    this.store.transaction(() => {
      for (const token of revoked) this.store.delete('sessions', token);
    });
    for (const token of revoked) this.sessions.delete(token);
  }

  async create(body) {
    if (!isObject(body)) throw httpError(400, 'Invalid account.');
    const username = text(body.username, 'Username', 32);
    if (!/^[a-zA-Z0-9_-]{3,32}$/.test(username)) throw httpError(400, 'Invalid username.');
    const displayName = text(body.displayName || username, 'Display name');
    const role = body.role || 'user';
    if (!['admin', 'user'].includes(role)) throw httpError(400, 'Invalid role.');
    const passwordHash = await hashPassword(body.password);
    if (this.users.some(u => u.username.toLowerCase() === username.toLowerCase())) {
      throw httpError(409, 'That username is already taken.');
    }
    const user = { id: randomUUID(), username, displayName, role, passwordHash, defaultPassword: false,
      preferences: { ...defaultPreferences } };
    this.store.save('users', user.id, user);
    this.users.push(user);
    return user;
  }

  async update(id, body, { self = false, token } = {}) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw httpError(404, 'User not found.');
    if (!isObject(body)) throw httpError(400, 'Invalid account update.');
    const originalPasswordHash = user.passwordHash;
    const changes = {};
    if (body.displayName !== undefined) changes.displayName = text(body.displayName, 'Display name');
    if (body.password !== undefined) {
      if (self && !await checkPassword(body.currentPassword, user.passwordHash)) {
        throw httpError(403, 'Your current password is incorrect.');
      }
      changes.passwordHash = await hashPassword(body.password);
      changes.defaultPassword = false;
    }
    if (!this.users.includes(user)) throw httpError(404, 'User not found.');
    if (changes.passwordHash && user.passwordHash !== originalPasswordHash) {
      throw httpError(409, 'The password changed while processing your request. Please try again.');
    }
    if (!self && body.role !== undefined) {
      if (!['admin', 'user'].includes(body.role)) throw httpError(400, 'Invalid role.');
      if (body.role !== 'admin' && user.role === 'admin' && this.users.filter(u => u.role === 'admin').length === 1) {
        throw httpError(409, 'The last administrator cannot be demoted.');
      }
      changes.role = body.role;
    }
    const revoked = changes.passwordHash || changes.role ? [...this.sessions]
      .filter(([sessionToken, session]) => session.userId === id && (!self || sessionToken !== token))
      .map(([sessionToken]) => sessionToken) : [];
    this.store.transaction(() => {
      this.store.save('users', id, { ...user, ...changes });
      for (const sessionToken of revoked) this.store.delete('sessions', sessionToken);
    });
    Object.assign(user, changes);
    for (const sessionToken of revoked) this.sessions.delete(sessionToken);
    return user;
  }

  async updatePreferences(id, body) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw httpError(404, 'User not found.');
    validatePreferences(body);
    const preferences = { ...defaultPreferences, ...user.preferences, ...body };
    this.store.save('users', id, { ...user, preferences });
    user.preferences = preferences;
    return user;
  }

  async remove(id, actorId) {
    const user = this.users.find(u => u.id === id);
    if (!user) throw httpError(404, 'User not found.');
    if (id === actorId) throw httpError(409, 'You cannot delete your own account.');
    if (user.role === 'admin' && this.users.filter(u => u.role === 'admin').length === 1) {
      throw httpError(409, 'The last administrator cannot be deleted.');
    }
    const revoked = [...this.sessions].filter(([, session]) => session.userId === id).map(([token]) => token);
    this.store.transaction(() => {
      this.store.delete('users', id);
      for (const token of revoked) this.store.delete('sessions', token);
    });
    this.users = this.users.filter(u => u.id !== id);
    for (const token of revoked) this.sessions.delete(token);
  }

  async close() {
    await this.writes;
    if (this.ownsStore) this.store.close();
    this.initialized = false;
  }
}
