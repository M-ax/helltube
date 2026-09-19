import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, open, readFile, rename, rm, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { COOKIE_USER_AGENT_MARKER, validateCookieUserAgent } from '../../shared/youtube-cookie-metadata.js';

const exec = promisify(execFile);
export class HelperError extends Error {}
export const defaults = directory => ({ browser: 'chrome', intervalMinutes: 60, enabled: false,
  output: path.join(directory, 'youtube-cookies.txt'), sshEnabled: false, sshHost: '', sshUser: '', sshPort: 22, sshIdentity: '' });

export function validateConfig(value, directory) {
  const config = { ...defaults(directory), ...value };
  if (!['edge', 'chrome'].includes(config.browser)) throw new HelperError('Choose Chrome or Edge.');
  if (!Number.isInteger(config.intervalMinutes) || config.intervalMinutes < 15 || config.intervalMinutes > 10080) {
    throw new HelperError('Refresh interval must be between 15 and 10080 minutes.');
  }
  for (const key of ['enabled', 'sshEnabled']) if (typeof config[key] !== 'boolean') throw new HelperError('Invalid setting.');
  for (const key of ['output', 'sshHost', 'sshUser', 'sshIdentity']) {
    if (typeof config[key] !== 'string' || /[\x00-\x1f\x7f]/.test(config[key])) throw new HelperError('Invalid path or SSH setting.');
  }
  if (!path.isAbsolute(config.output) || !/\.txt$/i.test(config.output) || config.output.startsWith('\\\\')) {
    throw new HelperError('Choose an absolute local .txt output path.');
  }
  const relative = path.relative(directory, config.output);
  if (relative && !relative.startsWith('..') && !path.isAbsolute(relative) &&
      (relative.split(path.sep).length !== 1 || relative !== 'youtube-cookies.txt')) {
    throw new HelperError('Inside the helper folder, use youtube-cookies.txt.');
  }
  if (!Number.isInteger(config.sshPort) || config.sshPort < 1 || config.sshPort > 65535) throw new HelperError('Invalid SSH port.');
  if (config.sshEnabled && (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(config.sshHost) ||
      !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(config.sshUser))) throw new HelperError('Enter an SSH hostname (or IPv4 address) and username.');
  if (config.sshIdentity && !path.isAbsolute(config.sshIdentity)) throw new HelperError('Choose an absolute SSH key path.');
  return Object.fromEntries(Object.keys(defaults(directory)).map(key => [key, config[key]]));
}

export function youtubeCookies(cookies, { now = Date.now(), userAgent } = {}) {
  const selected = cookies.filter(cookie => {
    const domain = cookie.domain.replace(/^\./, '').toLowerCase();
    return (domain === 'youtube.com' || domain.endsWith('.youtube.com')) &&
      !cookie.partitionKey && (cookie.expires <= 0 || cookie.expires > now / 1000);
  });
  if (!selected.some(cookie => ['SID', '__Secure-1PSID', '__Secure-3PSID'].includes(cookie.name) && cookie.value)) {
    throw new HelperError('No signed-in YouTube session found. Open Sign in and complete Google verification.');
  }
  const lines = selected.map(cookie => {
    if (!/^\.?([a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*youtube\.com$/i.test(cookie.domain) ||
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(cookie.name) || !cookie.path.startsWith('/') ||
        [cookie.path, cookie.value].some(value => /[\x00-\x1f\x7f]/.test(value)) || !Number.isFinite(cookie.expires)) {
      throw new HelperError('The browser returned an invalid cookie. The previous export was preserved.');
    }
    return [cookie.httpOnly ? '#HttpOnly_' + cookie.domain : cookie.domain,
      cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE', cookie.path, cookie.secure ? 'TRUE' : 'FALSE',
      cookie.expires > 0 ? Math.floor(cookie.expires) : 0, cookie.name, cookie.value].join('\t');
  });
  let metadata = '';
  if (userAgent !== undefined) {
    try { metadata = `${COOKIE_USER_AGENT_MARKER} ${validateCookieUserAgent(userAgent)}\n`; }
    catch { throw new HelperError('Cannot export the browser user agent. The previous export was preserved.'); }
  }
  const text = '# Netscape HTTP Cookie File\n' + metadata + lines.sort().join('\n') + '\n';
  if (Buffer.byteLength(text) >= 1048576) throw new HelperError('Cookie export is too large.');
  return { text, count: lines.length };
}

let sid;
export async function protect(file, directory = false) {
  if (process.platform !== 'win32') return;
  sid ??= (await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    '[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value'], { windowsHide: true })).stdout.trim();
  if (!/^S-1-[0-9-]+$/.test(sid)) throw new HelperError('Cannot determine the Windows account for file protection.');
  const inheritance = directory ? '(OI)(CI)' : '';
  await exec('icacls.exe', [file, '/inheritance:r', '/grant:r', `*${sid}:${inheritance}(F)`,
    `*S-1-5-18:${inheritance}(F)`], { windowsHide: true });
}

export async function privateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new HelperError('The helper folder must be a regular local directory.');
  await protect(directory, true);
}

export async function atomicWrite(destination, text) {
  const temporary = path.join(path.dirname(destination), `.helltube-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await protect(temporary);
    await handle.writeFile(text, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, destination);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

export async function readConfig(directory) {
  try { return validateConfig(JSON.parse((await readFile(path.join(directory, 'settings.json'), 'utf8')).replace(/^\uFEFF/, '')), directory); }
  catch (error) {
    if (error.code === 'ENOENT') return defaults(directory);
    throw new HelperError('Cannot load settings.json. Fix or rename it, then restart the helper.');
  }
}

export function sshArguments(config) {
  return ['-T', '-p', String(config.sshPort), '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'ConnectTimeout=15', '-o', 'ConnectionAttempts=1', '-o', 'ServerAliveInterval=10',
    '-o', 'ServerAliveCountMax=2', ...(config.sshIdentity ? ['-i', config.sshIdentity, '-o', 'IdentitiesOnly=yes'] : []),
    `${config.sshUser}@${config.sshHost}`, 'sudo -n /usr/local/sbin/helltube-import-cookies'];
}

export async function syncSSH(config, text) {
  const executable = process.platform === 'win32'
    ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe') : 'ssh';
  await new Promise((resolve, reject) => {
    const child = spawn(executable, sshArguments(config), { windowsHide: true, stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill(); reject(new HelperError('SSH sync timed out. Local export is saved.')); }, 180000);
    child.on('error', () => { clearTimeout(timer); reject(new HelperError('Cannot start OpenSSH. Install the Windows OpenSSH client.')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new HelperError('SSH sync failed. Check the host key, key login, remote importer and sudo permission. Local export is saved.'));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(text);
  });
}

export function nextRefresh(config, failures = 0, now = Date.now()) {
  if (!config.enabled) return null;
  return now + (failures ? Math.min(config.intervalMinutes, 5 * 2 ** Math.min(failures - 1, 8)) : config.intervalMinutes) * 60000;
}
