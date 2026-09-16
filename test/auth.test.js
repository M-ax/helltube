import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Accounts, checkPassword, hashPassword, publicUser } from '../server/auth.js';
import { StateStore } from '../server/store.js';

async function fixture(t) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'accounts-'));
  const accounts = [];
  const stores = [];
  t.after(async () => {
    for (const account of accounts) await account.close();
    for (const store of stores) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    async open(store) {
      const account = new Accounts(dir, store);
      accounts.push(account);
      await account.init();
      return account;
    },
    async store() {
      const store = new StateStore(dir);
      stores.push(store);
      return store.init();
    },
  };
}

test('seeded administrator, hashed persistence, roles, self-service and session revocation', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const { user: admin, token } = await accounts.login('admin', 'garbageTime_');
  assert.equal(admin.role, 'admin');
  assert.equal(admin.defaultPassword, true);
  assert.equal(publicUser(admin).passwordHash, undefined);
  assert.deepEqual(publicUser(admin).preferences, { volume: 0.8, muted: false });
  assert.ok(!JSON.stringify(accounts.store.load('users')).includes('garbageTime_'));
  assert.equal(accounts.authenticate(`session=${token}`).user.id, admin.id);
  await assert.rejects(accounts.login('admin', 'incorrect password'), /Invalid/);
  await assert.rejects(accounts.update(admin.id, { role: 'user' }), /last administrator/);
  await assert.rejects(accounts.remove(admin.id, 'another-admin'), /last administrator/);
  await assert.rejects(accounts.remove(admin.id, admin.id), /own account/);
  const user = await accounts.create({ username: 'viewer', password: 'correct-password', displayName: 'Viewer' });
  assert.deepEqual(user.preferences, { volume: 0.8, muted: false });
  await assert.rejects(accounts.create({ username: 'VIEWER', password: 'correct-password' }), /already taken/);
  await assert.rejects(accounts.create({ username: 'bad', password: 'short' }), /10–128/);
  const session = await accounts.login('viewer', 'correct-password');
  await accounts.update(user.id, { displayName: 'New name', role: 'admin' }, { self: true });
  assert.equal(user.role, 'user');
  await assert.rejects(accounts.update(user.id, { password: 'new-password' }, { self: true }), /current password/);
  await accounts.update(user.id, { password: 'new-password', currentPassword: 'correct-password' }, { self: true });
  assert.equal(accounts.authenticate(`session=${session.token}`), null);
  await accounts.close();
  const reloaded = await f.open();
  assert.equal((await reloaded.login('viewer', 'new-password')).user.displayName, 'New name');
  assert.equal(reloaded.users.find(u => u.id === user.id).defaultPassword, false);
  assert.equal(reloaded.authenticate(`session=${session.token}`), null);
  await assert.rejects(reloaded.login('viewer', 'correct-password'), /Invalid/);
  await reloaded.remove(user.id, admin.id);
  await assert.rejects(reloaded.login('viewer', 'new-password'), /Invalid/);
});

test('sessions survive restart, while logout, revocation, password resets and deletion persist', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const admin = accounts.users[0];
  const user = await accounts.create({ username: 'viewer', password: 'correct-password' });
  const first = await accounts.login('viewer', 'correct-password');
  const second = await accounts.login('viewer', 'correct-password');
  const third = await accounts.login('viewer', 'correct-password');
  await accounts.close();
  const reloaded = await f.open();
  assert.equal(reloaded.authenticate(`other=1; session=${first.token}`).user.id, user.id);
  reloaded.logout(first.token);
  reloaded.logout(first.token);
  reloaded.revoke(user.id, second.token);
  assert.equal(reloaded.authenticate(`session=${third.token}`), null);
  await reloaded.close();
  const reopened = await f.open();
  assert.equal(reopened.authenticate(`session=${first.token}`), null);
  assert.equal(reopened.authenticate(`session=${third.token}`), null);
  assert.equal(reopened.authenticate(`session=${second.token}`).user.id, user.id);
  const other = await reopened.login('viewer', 'correct-password');
  await reopened.update(user.id, { password: 'changed-password', currentPassword: 'correct-password' },
    { self: true, token: second.token });
  await reopened.close();
  const changed = await f.open();
  assert.equal(changed.authenticate(`session=${second.token}`).user.id, user.id);
  assert.equal(changed.authenticate(`session=${other.token}`), null);
  await changed.update(user.id, { password: 'reset-password' });
  await changed.close();
  const reset = await f.open();
  assert.equal(reset.authenticate(`session=${second.token}`), null);
  const last = await reset.login('viewer', 'reset-password');
  await reset.remove(user.id, admin.id);
  await reset.close();
  const deleted = await f.open();
  assert.equal(deleted.authenticate(`session=${last.token}`), null);
  assert.ok(!deleted.users.some(u => u.id === user.id));
  assert.deepEqual(deleted.store.load('sessions'), []);
});

test('expired and orphaned sessions are removed durably on init, authentication and login', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const admin = accounts.users[0];
  const expired = { token: 'a'.repeat(64), userId: admin.id, expires: 1 };
  const orphaned = { token: 'b'.repeat(64), userId: 'deleted-user', expires: Date.now() + 60000 };
  accounts.store.save('sessions', expired.token, expired);
  accounts.store.save('sessions', orphaned.token, orphaned);
  await accounts.close();
  const reloaded = await f.open();
  assert.deepEqual(reloaded.store.load('sessions'), []);
  reloaded.store.save('sessions', expired.token, expired);
  reloaded.sessions.set(expired.token, { userId: admin.id, expires: 1 });
  assert.equal(reloaded.authenticate(`session=${expired.token}`), null);
  assert.deepEqual(reloaded.store.load('sessions'), []);
  reloaded.store.save('sessions', expired.token, expired);
  reloaded.sessions.set(expired.token, { userId: admin.id, expires: 1 });
  const valid = await reloaded.login('admin', 'garbageTime_');
  assert.deepEqual(reloaded.store.load('sessions').map(s => s.token), [valid.token]);
  await reloaded.close();
  const reopened = await f.open();
  assert.equal(reopened.authenticate(`session=${expired.token}`), null);
  assert.equal(reopened.authenticate(`session=${valid.token}`).user.id, admin.id);
});

test('preferences default, validate partial changes and preserve all other user fields after restart', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const user = accounts.users[0];
  assert.deepEqual(publicUser({ id: 'legacy' }).preferences, { volume: 0.8, muted: false });
  const original = structuredClone(user);
  const { token } = await accounts.login('admin', 'garbageTime_');
  assert.equal(await accounts.updatePreferences(user.id, { volume: 0 }), user);
  assert.deepEqual(user.preferences, { volume: 0, muted: false });
  await accounts.updatePreferences(user.id, { muted: true });
  assert.deepEqual(user.preferences, { volume: 0, muted: true });
  await accounts.updatePreferences(user.id, { volume: 1 });
  assert.deepEqual(user, { ...original, preferences: { volume: 1, muted: true } });
  for (const body of [null, [], 'bad', { volume: -0.1 }, { volume: 1.1 }, { volume: NaN },
    { volume: Infinity }, { volume: '0.5' }, { volume: null }, { volume: undefined },
    { muted: 0 }, { muted: 'false' }, { muted: null }, { muted: undefined },
    { volume: 0.2, muted: 'bad' }, { role: 'user' }, { displayName: 'changed' }]) {
    await assert.rejects(accounts.updatePreferences(user.id, body), { status: 400 });
    assert.deepEqual(user, { ...original, preferences: { volume: 1, muted: true } });
    assert.deepEqual(accounts.store.load('users')[0], user);
  }
  await assert.rejects(accounts.updatePreferences('missing', { muted: true }), { status: 404 });
  await accounts.updatePreferences(user.id, {});
  const visible = publicUser(user);
  visible.preferences.volume = 0.4;
  assert.equal(user.preferences.volume, 1);
  await accounts.close();
  const reloaded = await f.open();
  assert.deepEqual(reloaded.users[0], { ...original, preferences: { volume: 1, muted: true } });
  assert.equal(reloaded.authenticate(`session=${token}`).user.id, user.id);
});

test('legacy migration preserves IDs, hashes, admin flags and profile data, then makes SQLite authoritative', async t => {
  const f = await fixture(t);
  const passwordHash = await hashPassword('legacy-password');
  const legacy = [{ id: 'legacy-admin', username: 'legacy', displayName: 'Original', role: 'admin',
    passwordHash, defaultPassword: true, profile: { retained: true } }];
  const file = path.join(f.dir, 'users.json');
  await writeFile(file, JSON.stringify(legacy));
  await writeFile(`${file}.tmp`, 'incomplete temporary write');
  const accounts = await f.open();
  assert.deepEqual(accounts.users, [{ ...legacy[0], preferences: { volume: 0.8, muted: false } }]);
  assert.equal((await accounts.login('legacy', 'legacy-password')).user.id, 'legacy-admin');
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(readFile(`${file}.tmp`), { code: 'ENOENT' });
  await accounts.updatePreferences('legacy-admin', { muted: true });
  await accounts.close();
  await writeFile(file, '{stale invalid JSON');
  await writeFile(`${file}.tmp`, 'stale');
  const reloaded = await f.open();
  assert.equal(reloaded.users[0].passwordHash, passwordHash);
  assert.equal(reloaded.users[0].defaultPassword, true);
  assert.deepEqual(reloaded.users[0].profile, { retained: true });
  assert.deepEqual(reloaded.users[0].preferences, { volume: 0.8, muted: true });
  await assert.rejects(readFile(file), { code: 'ENOENT' });
  await assert.rejects(readFile(`${file}.tmp`), { code: 'ENOENT' });
});

test('invalid legacy data is never replaced or cleaned up', async t => {
  const passwordHash = await hashPassword('legacy-password');
  const admin = { id: 'admin-id', username: 'admin', displayName: 'Admin', role: 'admin', passwordHash };
  for (const value of ['{broken', '{}', '[]', JSON.stringify([{ ...admin, role: 'user' }]),
    JSON.stringify([{ ...admin, passwordHash: 'invalid' }]),
    JSON.stringify([admin, { ...admin, id: 'other-id', username: 'ADMIN' }]),
    JSON.stringify([admin, { ...admin, username: 'other' }]),
    JSON.stringify([{ ...admin, preferences: { volume: 2 } }])]) {
    const f = await fixture(t);
    const file = path.join(f.dir, 'users.json');
    await writeFile(file, value);
    await writeFile(`${file}.tmp`, 'keep this');
    await assert.rejects(f.open());
    assert.equal(await readFile(file, 'utf8'), value);
    assert.equal(await readFile(`${file}.tmp`, 'utf8'), 'keep this');
    const store = await f.store();
    assert.deepEqual(store.load('users'), []);
  }
});

test('a lone legacy temporary file is recovered only when valid, never silently discarded', async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'users.json.tmp');
  await writeFile(file, '{unfinished');
  await assert.rejects(f.open());
  assert.equal(await readFile(file, 'utf8'), '{unfinished');
  const user = { id: 'recovered', username: 'admin', displayName: 'Recovered', role: 'admin',
    passwordHash: await hashPassword('recovered-password'), defaultPassword: false };
  await writeFile(file, JSON.stringify([user]));
  const accounts = await f.open();
  assert.equal((await accounts.login('admin', 'recovered-password')).user.id, user.id);
  await assert.rejects(readFile(file), { code: 'ENOENT' });
});

test('migration is atomic and leaves legacy files intact when the database rejects a write', async t => {
  const f = await fixture(t);
  const store = await f.store();
  const passwordHash = await hashPassword('legacy-password');
  const legacy = [{ id: 'first', username: 'admin', displayName: 'Admin', role: 'admin', passwordHash },
    { id: 'second', username: 'viewer', displayName: 'Viewer', role: 'user', passwordHash }];
  const file = path.join(f.dir, 'users.json');
  const contents = JSON.stringify(legacy);
  await writeFile(file, contents);
  await writeFile(`${file}.tmp`, 'keep this');
  store.db.exec(`CREATE TRIGGER reject_migration BEFORE INSERT ON documents
    WHEN NEW.collection = 'users' AND NEW.key = 'second'
    BEGIN SELECT RAISE(ABORT, 'migration rejected'); END;`);
  await assert.rejects(f.open(store), /migration rejected/);
  assert.deepEqual(store.load('users'), []);
  assert.equal(await readFile(file, 'utf8'), contents);
  assert.equal(await readFile(`${file}.tmp`, 'utf8'), 'keep this');
  store.db.exec('DROP TRIGGER reject_migration');
  const accounts = await f.open(store);
  assert.deepEqual(accounts.users.map(u => u.id), ['first', 'second']);
  await accounts.close();
  assert.equal(store.load('users').length, 2);
});

test('role changes revoke sessions across restart without changing passwords or preferences', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const user = await accounts.create({ username: 'viewer', password: 'correct-password' });
  await accounts.updatePreferences(user.id, { volume: 0.3, muted: true });
  const passwordHash = user.passwordHash;
  const { token } = await accounts.login('viewer', 'correct-password');
  await accounts.update(user.id, { role: 'admin' });
  await accounts.close();
  const reloaded = await f.open();
  assert.equal(reloaded.authenticate(`session=${token}`), null);
  const loggedIn = (await reloaded.login('viewer', 'correct-password')).user;
  assert.equal(loggedIn.role, 'admin');
  assert.equal(loggedIn.passwordHash, passwordHash);
  assert.deepEqual(loggedIn.preferences, { volume: 0.3, muted: true });
});

test('failed account mutations roll back both persistent data and caches', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const user = await accounts.create({ username: 'viewer', password: 'correct-password' });
  const admin = accounts.users[0];
  const { token } = await accounts.login('viewer', 'correct-password');
  const original = structuredClone(user);
  accounts.store.db.exec(`CREATE TRIGGER reject_revocation BEFORE DELETE ON documents
    WHEN OLD.collection = 'sessions'
    BEGIN SELECT RAISE(ABORT, 'revocation rejected'); END;`);
  await assert.rejects(accounts.update(user.id, { password: 'changed-password' }), /revocation rejected/);
  await assert.rejects(accounts.remove(user.id, admin.id), /revocation rejected/);
  assert.throws(() => accounts.logout(token), /revocation rejected/);
  assert.throws(() => accounts.revoke(user.id), /revocation rejected/);
  assert.deepEqual(user, original);
  assert.deepEqual(accounts.store.load('users').find(u => u.id === user.id), original);
  assert.equal(accounts.authenticate(`session=${token}`).user, user);
  accounts.store.db.exec('DROP TRIGGER reject_revocation');
  accounts.store.db.exec(`CREATE TRIGGER reject_user_update BEFORE UPDATE ON documents
    WHEN NEW.collection = 'users'
    BEGIN SELECT RAISE(ABORT, 'update rejected'); END;`);
  await assert.rejects(accounts.updatePreferences(user.id, { volume: 0.1 }), /update rejected/);
  assert.deepEqual(user, original);
  assert.deepEqual(accounts.store.load('users').find(u => u.id === user.id), original);
});

test('invalid SQLite accounts and sessions are not replaced with default accounts', async t => {
  const f = await fixture(t);
  const store = await f.store();
  store.save('users', 'broken', { id: 'broken', role: 'admin' });
  await assert.rejects(f.open(store), /Invalid account database/);
  assert.deepEqual(store.load('users'), [{ id: 'broken', role: 'admin' }]);
  store.delete('users', 'broken');
  store.save('sessions', 'broken', { token: 'broken', expires: 'never' });
  await assert.rejects(f.open(store), /Invalid session database/);
  assert.deepEqual(store.load('users'), []);
  assert.deepEqual(store.load('sessions'), [{ token: 'broken', expires: 'never' }]);
});

test('init adds persisted defaults to existing SQLite users and never reseeds initialized empty accounts', async t => {
  const f = await fixture(t);
  const store = await f.store();
  const user = { id: 'existing', username: 'admin', displayName: 'Admin', role: 'admin',
    passwordHash: await hashPassword('existing-password'), defaultPassword: false };
  store.save('users', user.id, user);
  const accounts = await f.open(store);
  assert.deepEqual(store.load('users')[0].preferences, { volume: 0.8, muted: false });
  await accounts.close();
  store.delete('users', user.id);
  await assert.rejects(f.open(store), /Invalid account database/);
  assert.deepEqual(store.load('users'), []);
});

test('concurrent password work cannot resurrect deleted users or demote the last admin', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const admin = accounts.users[0];
  const other = await accounts.create({ username: 'other', role: 'admin', password: 'correct-password' });
  const updates = await Promise.allSettled([
    accounts.update(admin.id, { password: 'changed-password', role: 'user' }),
    accounts.update(other.id, { password: 'changed-password', role: 'user' }),
  ]);
  assert.equal(updates.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(updates.find(result => result.status === 'rejected').reason.message, /last administrator/);
  assert.equal(accounts.users.filter(u => u.role === 'admin').length, 1);
  const remaining = accounts.users.find(u => u.role === 'admin');
  const viewer = await accounts.create({ username: 'viewer', password: 'correct-password' });
  const pendingUpdate = accounts.update(viewer.id, { password: 'new-password' });
  const pendingLogin = accounts.login('viewer', 'correct-password');
  const rejected = Promise.all([
    assert.rejects(pendingUpdate, { status: 404 }),
    assert.rejects(pendingLogin, { status: 401 }),
  ]);
  await accounts.remove(viewer.id, remaining.id);
  await rejected;
  assert.ok(!accounts.store.load('users').some(u => u.id === viewer.id));
  assert.ok(!accounts.store.load('sessions').some(s => s.userId === viewer.id));
});

test('malformed password hashes fail authentication safely', async () => {
  for (const stored of [null, undefined, '', 'salt:00', 'invalid']) {
    assert.equal(await checkPassword('correct-password', stored), false);
  }
});
