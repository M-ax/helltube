import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { normalizeCommit } from './shared/deployment.js';

let commit = process.env.HELLTUBE_COMMIT?.trim();
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', '--verify', 'HEAD'], {
      cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch { /* Source archives may not include Git metadata. */ }
}
const deployedCommit = normalizeCommit(commit);
const buildId = randomUUID();

export default defineConfig({
  define: { __DEPLOYED_COMMIT__: JSON.stringify(deployedCommit), __BUILD_ID__: JSON.stringify(buildId) },
  plugins: [svelte(), {
    name: 'frontend-version',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId, commit: deployedCommit }) });
    },
  }],
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:3000',
      '/media': 'http://127.0.0.1:3000',
      '/direct': 'http://127.0.0.1:3000',
      '/ws': { target: 'ws://127.0.0.1:3000', ws: true },
    },
  },
});
