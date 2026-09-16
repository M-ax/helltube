import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export class StateStore {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'helltube.sqlite');
    this.db = null;
    this.statements = null;
    this.inTransaction = false;
  }

  async init() {
    if (this.db) return this;
    await mkdir(path.dirname(this.file), { recursive: true });
    if (this.db) return this;
    const db = new DatabaseSync(this.file);
    try {
      db.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
      db.exec(`CREATE TABLE IF NOT EXISTS documents (
        collection TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL CHECK (json_valid(value)),
        PRIMARY KEY (collection, key)
      ) STRICT`);
      const columns = db.prepare('PRAGMA table_info(documents)').all();
      const expected = [{ name: 'collection', pk: 1 }, { name: 'key', pk: 2 }, { name: 'value', pk: 0 }];
      if (columns.length !== expected.length || columns.some((column, index) =>
        column.name !== expected[index].name || column.type.toUpperCase() !== 'TEXT' ||
        column.notnull !== 1 || column.pk !== expected[index].pk)) {
        throw new Error('Invalid SQLite documents schema; refusing to overwrite it.');
      }
      if (db.prepare('SELECT 1 FROM documents WHERE NOT json_valid(value) LIMIT 1').get()) {
        throw new Error('Invalid JSON in SQLite documents; refusing to overwrite it.');
      }
      this.statements = {
        load: db.prepare('SELECT value FROM documents WHERE collection = ? ORDER BY key'),
        save: db.prepare(`INSERT INTO documents (collection, key, value) VALUES (?, ?, ?)
          ON CONFLICT (collection, key) DO UPDATE SET value = excluded.value`),
        delete: db.prepare('DELETE FROM documents WHERE collection = ? AND key = ?'),
      };
      this.db = db;
      return this;
    } catch (error) {
      db.close();
      this.statements = null;
      throw error;
    }
  }

  assertOpen() {
    if (!this.db) throw new Error('SQLite store is not initialized or has been closed.');
  }

  load(collection) {
    this.assertOpen();
    if (typeof collection !== 'string') throw new TypeError('Collection must be a string.');
    return this.statements.load.all(collection).map(row => JSON.parse(row.value));
  }

  save(collection, key, value) {
    this.assertOpen();
    if (typeof collection !== 'string' || typeof key !== 'string') {
      throw new TypeError('Collection and key must be strings.');
    }
    const data = JSON.stringify(value);
    if (data === undefined) throw new TypeError('Document must be a JSON value.');
    return this.statements.save.run(collection, key, data);
  }

  delete(collection, key) {
    this.assertOpen();
    if (typeof collection !== 'string' || typeof key !== 'string') {
      throw new TypeError('Collection and key must be strings.');
    }
    return this.statements.delete.run(collection, key);
  }

  transaction(fn) {
    this.assertOpen();
    if (typeof fn !== 'function' || fn.constructor?.name === 'AsyncFunction') {
      throw new TypeError('SQLite transactions require a synchronous callback.');
    }
    if (this.inTransaction) throw new Error('Nested SQLite transactions are not supported.');
    this.db.exec('BEGIN IMMEDIATE');
    this.inTransaction = true;
    try {
      const result = fn();
      if (result && typeof result.then === 'function') {
        throw new TypeError('SQLite transactions require a synchronous callback.');
      }
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], 'Failed to roll back SQLite transaction.');
      }
      throw error;
    } finally {
      this.inTransaction = false;
    }
  }

  close() {
    if (!this.db) return;
    if (this.inTransaction) throw new Error('Cannot close SQLite store during a transaction.');
    this.db.close();
    this.db = null;
    this.statements = null;
  }
}
