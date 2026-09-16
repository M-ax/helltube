import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StateStore } from '../server/store.js';

async function fixture(t) {
  await mkdir('test-artifacts', { recursive: true });
  const dir = await mkdtemp(path.resolve('test-artifacts', 'store-'));
  const stores = [];
  t.after(async () => {
    for (const store of stores) store.close();
    await rm(dir, { recursive: true, force: true });
  });
  return {
    dir,
    create(dataDir = dir) {
      const store = new StateStore(dataDir);
      stores.push(store);
      return store;
    },
  };
}

test('SQLite store creates directories, configures SQLite and persists JSON documents across reopen', async t => {
  const f = await fixture(t);
  const dir = path.join(f.dir, 'nested', 'state');
  const store = f.create(dir);
  assert.equal(await store.init(), store);
  assert.equal(await store.init(), store);
  assert.equal(store.file, path.join(dir, 'helltube.sqlite'));
  assert.equal(store.db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(store.db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1);
  assert.ok(store.db.prepare('PRAGMA busy_timeout').get().timeout > 0);
  assert.deepEqual(store.load('users'), []);
  const value = { id: 'one', nested: { name: 'Unicode: привет', flags: [true, null, 3] } };
  store.save('users', 'one', value);
  store.save('rooms', 'one', { title: 'Different collection' });
  value.nested.name = 'changed only in caller';
  assert.equal(store.load('users')[0].nested.name, 'Unicode: привет');
  store.save('users', 'one', { id: 'one', updated: true });
  store.save('users', 'two', { id: 'two' });
  store.delete('users', 'two');
  store.delete('users', 'missing');
  store.save('values', 'null', null);
  store.save('values', 'array', [1, 'two', false]);
  store.close();
  store.close();
  assert.throws(() => store.load('users'), /initialized|closed/);
  const reopened = f.create(dir);
  await reopened.init();
  assert.deepEqual(reopened.load('users'), [{ id: 'one', updated: true }]);
  assert.deepEqual(reopened.load('rooms'), [{ title: 'Different collection' }]);
  assert.deepEqual(reopened.load('values'), [[1, 'two', false], null]);
});

test('transactions commit return values and roll back inserts, updates and deletes together', async t => {
  const f = await fixture(t);
  const store = await f.create().init();
  store.save('items', 'old', { version: 1 });
  store.save('other', 'keep', { retained: true });
  assert.throws(() => store.transaction(() => {
    store.save('items', 'old', { version: 2 });
    store.save('items', 'new', { created: true });
    store.delete('other', 'keep');
    throw new Error('abort transaction');
  }), /abort transaction/);
  assert.deepEqual(store.load('items'), [{ version: 1 }]);
  assert.deepEqual(store.load('other'), [{ retained: true }]);
  assert.equal(store.transaction(() => {
    store.save('items', 'old', { version: 3 });
    store.delete('other', 'keep');
    return 42;
  }), 42);
  store.close();
  const reopened = await f.create().init();
  assert.deepEqual(reopened.load('items'), [{ version: 3 }]);
  assert.deepEqual(reopened.load('other'), []);
});

test('transactions reject async and nested callbacks without leaking writes', async t => {
  const f = await fixture(t);
  const store = await f.create().init();
  assert.throws(() => store.transaction(async () => {
    store.save('items', 'async', { invalid: true });
  }), /synchronous/);
  assert.throws(() => store.transaction(() => {
    store.save('items', 'promise', { invalid: true });
    return Promise.resolve();
  }), /synchronous/);
  assert.throws(() => store.transaction(() => {
    store.save('items', 'nested', { invalid: true });
    store.transaction(() => {});
  }), /nested/i);
  assert.deepEqual(store.load('items'), []);
  store.transaction(() => store.save('items', 'valid', { valid: true }));
  assert.deepEqual(store.load('items'), [{ valid: true }]);
});

test('invalid JSON values and SQL input cannot overwrite stored documents', async t => {
  const f = await fixture(t);
  const store = await f.create().init();
  store.save('items', 'one', { original: true });
  const circular = {};
  circular.self = circular;
  for (const value of [undefined, () => {}, Symbol('invalid'), 1n, circular]) {
    assert.throws(() => store.save('items', 'one', value));
    assert.deepEqual(store.load('items'), [{ original: true }]);
  }
  assert.throws(() => store.db.prepare('INSERT INTO documents(collection, key, value) VALUES (?, ?, ?)')
    .run('items', 'invalid', '{bad JSON'));
  const key = "'; DROP TABLE documents; --";
  store.save(key, key, { safe: true });
  assert.deepEqual(store.load(key), [{ safe: true }]);
  assert.deepEqual(store.load('items'), [{ original: true }]);
});

test('incompatible schemas are rejected without destructive reset', async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'helltube.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec('CREATE TABLE documents (original TEXT); INSERT INTO documents VALUES (\'keep me\')');
  } finally {
    db.close();
  }
  await assert.rejects(f.create().init(), /schema/i);
  const original = new DatabaseSync(file);
  try {
    assert.equal(original.prepare('SELECT original FROM documents').get().original, 'keep me');
  } finally {
    original.close();
  }
});

test('existing invalid JSON is rejected without erasing it', async t => {
  const f = await fixture(t);
  const file = path.join(f.dir, 'helltube.sqlite');
  const db = new DatabaseSync(file);
  try {
    db.exec(`CREATE TABLE documents (
      collection TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (collection, key)
    )`);
    db.prepare('INSERT INTO documents VALUES (?, ?, ?)').run('users', 'one', '{corrupt');
  } finally {
    db.close();
  }
  await assert.rejects(f.create().init(), /JSON/i);
  const original = new DatabaseSync(file);
  try {
    assert.equal(original.prepare('SELECT value FROM documents').get().value, '{corrupt');
  } finally {
    original.close();
  }
});
