import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Accounts } from '../server/auth.js';

const helper = fileURLToPath(new URL('../scripts/bootstrap-admin.mjs', import.meta.url));
const password = '0123456789abcdef'.repeat(4);

async function fixture(t) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'bootstrap-admin-'));
  const accounts = [];
  t.after(async () => {
    for (const account of accounts) await account.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    dataDir: path.join(dir, 'data'),
    async open() {
      const account = new Accounts(this.dataDir);
      accounts.push(account);
      await account.init();
      return account;
    },
    run(input = `${password}\n`, dataDir = this.dataDir) {
      const env = { ...process.env, DATA_DIR: dataDir };
      if (dataDir === null) delete env.DATA_DIR;
      const result = spawnSync(process.execPath, [helper], {
        cwd: dir, env, input, encoding: 'utf8', timeout: 15000,
      });
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.ok(!`${result.stdout}${result.stderr}`.includes(password));
      return result;
    },
  };
}

test('fresh bootstrap initializes an admin with the stdin password and removes the default', async t => {
  const f = await fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const accounts = await f.open();
  assert.equal(accounts.users.length, 1);
  assert.equal(accounts.users[0].defaultPassword, false);
  assert.equal((await accounts.login('admin', password)).user.role, 'admin');
  await assert.rejects(accounts.login('admin', 'garbageTime_'), /Invalid/);
  assert.ok(!JSON.stringify(accounts.store.load('users')).includes(password));
});

test('reruns preserve changed credentials, profiles and sessions for all non-default users', async t => {
  const f = await fixture(t);
  assert.equal(f.run().status, 0);
  const accounts = await f.open();
  const admin = accounts.users[0];
  await accounts.update(admin.id, { password: 'changed-admin-password', displayName: 'Owner' });
  await accounts.create({ username: 'viewer', password: 'viewer-password' });
  const { token } = await accounts.login('admin', 'changed-admin-password');
  const users = accounts.store.load('users');
  const sessions = accounts.store.load('sessions');
  await accounts.close();

  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const reopened = await f.open();
  assert.deepEqual(reopened.store.load('users'), users);
  assert.deepEqual(reopened.store.load('sessions'), sessions);
  assert.equal(reopened.authenticate(`session=${token}`).user.id, admin.id);
  await reopened.login('admin', 'changed-admin-password');
  await reopened.login('viewer', 'viewer-password');
  await assert.rejects(reopened.login('admin', password), /Invalid/);
});

test('all flagged users are reset and their sessions revoked, regardless of username or role', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const viewer = await accounts.create({ username: 'viewer', password: 'garbageTime_' });
  const otherAdmin = await accounts.create({ username: 'owner', password: 'garbageTime_', role: 'admin' });
  viewer.defaultPassword = true;
  otherAdmin.defaultPassword = true;
  await accounts.save();
  for (const user of accounts.users) await accounts.login(user.username, 'garbageTime_');
  assert.equal(accounts.store.load('sessions').length, 3);
  const keeper = await accounts.create({ username: 'keeper', password: 'kept-password' });
  const { token } = await accounts.login('keeper', 'kept-password');
  const keptUser = structuredClone(keeper);
  const keptSession = accounts.store.load('sessions').find(session => session.token === token);
  await accounts.close();

  const result = f.run(`${password}\r\n`);
  assert.equal(result.status, 0, result.stderr);
  const reopened = await f.open();
  assert.deepEqual(reopened.store.load('sessions'), [keptSession]);
  assert.deepEqual(reopened.users.find(user => user.id === keeper.id), keptUser);
  assert.equal(reopened.authenticate(`session=${token}`).user.id, keeper.id);
  assert.equal(reopened.users.length, 4);
  for (const user of reopened.users.filter(user => user.id !== keeper.id)) {
    assert.equal(user.defaultPassword, false);
    await reopened.login(user.username, password);
    await assert.rejects(reopened.login(user.username, 'garbageTime_'), /Invalid/);
  }
  await reopened.login('keeper', 'kept-password');
  await assert.rejects(reopened.login('keeper', password), /Invalid/);
});

test('invalid stdin fails without creating the data directory or printing the secret', async t => {
  const f = await fixture(t);
  for (const input of ['', 'garbageTime_', 'a'.repeat(31), 'a'.repeat(129), 'a'.repeat(1024), 'g'.repeat(64),
    `${password}\nextra`, `${password}\n\n`, ` ${password}`, `${password}\0`]) {
    const result = f.run(input);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, '');
    if (input) assert.ok(!result.stderr.includes(input));
    await assert.rejects(stat(f.dataDir), { code: 'ENOENT' });
  }
});

test('missing DATA_DIR fails instead of initializing data in the working directory', async t => {
  const f = await fixture(t);
  assert.equal(f.run(password, null).status, 1);
  await assert.rejects(stat(f.dataDir), { code: 'ENOENT' });
  await assert.rejects(stat(path.join(f.dir, 'helltube.sqlite')), { code: 'ENOENT' });
});

test('invalid existing accounts fail closed and can be reopened after repairing the data', async t => {
  const f = await fixture(t);
  const accounts = await f.open();
  const original = accounts.store.load('users')[0];
  accounts.store.save('users', original.id, { ...original, role: 'invalid' });
  await accounts.close();
  const result = f.run();
  assert.equal(result.status, 1);

  await accounts.store.init();
  assert.equal(accounts.store.load('users')[0].role, 'invalid');
  accounts.store.save('users', original.id, original);
  accounts.store.close();
  assert.equal(f.run(password).status, 0);
  const reopened = await f.open();
  await reopened.login('admin', password);
});