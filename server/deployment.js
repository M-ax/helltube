import { execFileSync } from 'node:child_process';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeCommit } from '../shared/deployment.js';

export async function backendCommit(root = fileURLToPath(new URL('..', import.meta.url)), override = process.env.HELLTUBE_COMMIT) {
  if (override?.trim()) return normalizeCommit(override.trim());
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return normalizeCommit(commit);
  } catch { /* Installed releases have no Git metadata; use their saved build manifest. */ }
  try {
    return normalizeCommit(JSON.parse(await readFile(path.join(root, 'dist/version.json'), 'utf8')).commit);
  } catch { return null; }
}

export class Deployment {
  constructor(config, store) {
    this.config = config;
    this.store = store;
    this.pending = Promise.resolve();
  }

  async init() {
    // Snapshot once: files on disk can change before this process is restarted.
    this.commit = this.config.backendCommit === undefined ? await backendCommit() : normalizeCommit(this.config.backendCommit);
    this.store.save('deployment', 'backend', { id: 'backend', commit: this.commit });
  }

  announce(commit) {
    const saving = this.pending.then(async () => {
      const previous = this.store.load('deployment').find(value => value.id === 'worker');
      if (previous?.commit === commit) return;
      const record = { id: 'worker', commit, announcedAt: Date.now() };
      if (commit !== this.commit) {
        // A systemd path unit can wake the existing, opt-in updater. The updater
        // still resolves trusted main itself; this file never selects code to run.
        const file = path.join(this.config.dataDir, 'worker-deployment.json');
        await writeFile(`${file}.tmp`, JSON.stringify(record), { mode: 0o600 });
        await rename(`${file}.tmp`, file);
      }
      this.store.save('deployment', 'worker', record);
    });
    this.pending = saving.catch(() => {});
    return saving;
  }
}
