import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { deploymentOrigin, normalizeCommit } from '../shared/deployment.js';

const root = fileURLToPath(new URL('..', import.meta.url));

export function deploymentTargets(output, override = '') {
  if (override) return [deploymentOrigin(override)];
  const deployment = output.trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.type === 'deploy').at(-1);
  const origins = [];
  for (const target of deployment?.targets || []) {
    // Wrangler emits workers.dev URLs, custom domains, and route patterns.
    const value = target.replace(/ \(.*\)$/, '').replace(/\/\*$/, '');
    if (value.includes('*')) continue;
    try { origins.push(deploymentOrigin(value.includes('://') ? value : `https://${value}`)); } catch { /* Not an origin-wide route. */ }
  }
  return [...new Set(origins)];
}

export async function notifyPublishedWorker(origins, version, { fetch: request = fetch, wait = sleep, attempts = 6 } = {}) {
  if (!origins.length) throw new Error('Worker published, but no Worker origin was found. Set HELLTUBE_WORKER_ORIGIN to its frontend HTTPS origin.');
  for (let attempt = 0; attempt < attempts; attempt++) {
    for (const origin of origins) {
      try {
        const url = new URL('/__deployment', origin);
        url.searchParams.set('buildId', version.buildId);
        const response = await request(url, { method: 'POST', redirect: 'manual', cache: 'no-store', signal: AbortSignal.timeout(15000) });
        if (!response.ok) continue;
        const result = await response.json();
        if (result.ok === true && result.buildId === version.buildId && result.commit === version.commit) return;
      } catch { /* Allow publication propagation and brief backend outages. */ }
    }
    if (attempt + 1 < attempts) await wait(3000);
  }
  throw new Error('Worker published, but metal did not acknowledge the deployment. Version checks will retry; verify the backend and Worker bindings.');
}

async function deploy(args) {
  const version = JSON.parse(await readFile(path.join(root, 'dist/version.json'), 'utf8'));
  if (!normalizeCommit(version.commit)) throw new Error('Build has no commit hash. Set HELLTUBE_COMMIT to the full source commit and rebuild.');
  const cacheDir = path.join(root, '.wrangler');
  await mkdir(cacheDir, { recursive: true });
  const directory = await mkdtemp(path.join(cacheDir, 'deployment-'));
  const outputFile = path.join(directory, 'output.jsonl');
  try {
    await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(root, 'node_modules/wrangler/bin/wrangler.js'), 'deploy', ...args], {
        cwd: root, stdio: 'inherit', env: { ...process.env, WRANGLER_OUTPUT_FILE_PATH: outputFile },
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Worker deployment failed (exit ${code}).`)));
    });
    if (args.some(arg => arg === '--dry-run' || arg === '--dry-run=true')) return;
    const origins = deploymentTargets(await readFile(outputFile, 'utf8'), process.env.HELLTUBE_WORKER_ORIGIN);
    await notifyPublishedWorker(origins, version);
    console.log(`Metal notified of Worker commit ${version.commit.slice(0, 7)}.`);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  deploy(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
