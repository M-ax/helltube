import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { atomicWrite } from './core.mjs';

export const CHROME_SHARE_URL = 'https://gs.statcounter.com/browser-version-market-share/desktop/worldwide';
export const IDENTITY_CHECK_INTERVAL = 24 * 60 * 60 * 1000;
// Latest completed worldwide desktop usage report verified on 2026-09-18.
// Usage share is a proxy for installed popularity; it is not an installation census.
export const BUNDLED_CHROME_SHARE = Object.freeze({ major: 151, period: '2026-08', share: 18.86 });
const MAX_RESPONSE_BYTES = 1024 * 1024;
const months = 'January February March April May June July August September October November December'.split(' ');

function validateShare(value, now) {
  if (!value || !Number.isInteger(value.major) || value.major < 100 || value.major > 999 ||
      !Number.isFinite(value.share) || value.share <= 0 || value.share > 100 ||
      typeof value.period !== 'string' || !/^20\d{2}-(0[1-9]|1[0-2])$/.test(value.period) ||
      Date.parse(value.period + '-01T00:00:00Z') > now) throw new Error('Invalid Chrome usage data.');
  return { major: value.major, period: value.period, share: value.share };
}

export function parseChromeShare(html, now = Date.now()) {
  if (typeof html !== 'string' || Buffer.byteLength(html) > MAX_RESPONSE_BYTES) throw new Error('Invalid Chrome usage response.');
  const table = html.match(/<table\b[^>]*class=["'][^"']*\bstats-snapshot\b[^"']*["'][^>]*>([\s\S]*?)<\/table>/i)?.[1];
  const period = table?.match(/Desktop Browser Version Market Share Worldwide\s*-\s*([A-Za-z]+)\s+(20\d{2})/);
  const month = months.indexOf(period?.[1]);
  if (!period || month < 0) throw new Error('Chrome usage period is unavailable.');
  const date = `${period[2]}-${String(month + 1).padStart(2, '0')}`;
  const tbody = table.match(/<tbody\b[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] || '';
  const candidates = [];
  for (const row of tbody.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
    // Unversioned "Chrome for Android" cannot identify a Chrome release.
    const version = row[1].match(/<th\b[^>]*>\s*Chrome (\d{3})(?:\.0){1,3}\s*<\/th>/);
    if (!version) continue;
    const percentage = row[1].match(/<span\b[^>]*class=["']count["'][^>]*>\s*(\d+(?:\.\d+)?)\s*<\/span>\s*%/);
    if (!percentage) throw new Error('Invalid Chrome usage percentage.');
    candidates.push(validateShare({ major: Number(version[1]), share: Number(percentage[1]), period: date }, now));
  }
  if (!candidates.length) throw new Error('No numbered Chrome versions in the usage report.');
  candidates.sort((a, b) => b.share - a.share || b.major - a.major);
  return candidates[0];
}

export function chromeUserAgent(major) {
  if (!Number.isInteger(major) || major < 100 || major > 999) throw new Error('Invalid Chrome version.');
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

export function chromeUserAgentOverride(major) {
  const version = String(major);
  const fullVersion = `${major}.0.0.0`;
  return {
    userAgent: chromeUserAgent(major), platform: 'Win32',
    userAgentMetadata: {
      brands: [{ brand: 'Not_A Brand', version: '99' }, { brand: 'Chromium', version }, { brand: 'Google Chrome', version }],
      fullVersionList: [{ brand: 'Not_A Brand', version: '99.0.0.0' },
        { brand: 'Chromium', version: fullVersion }, { brand: 'Google Chrome', version: fullVersion }],
      fullVersion, platform: 'Windows', platformVersion: '10.0.0', architecture: 'x86', bitness: '64',
      model: '', mobile: false, wow64: false,
    },
  };
}

async function responseText(response) {
  if (!response.ok || !response.headers.get('content-type')?.includes('text/html') ||
      Number(response.headers.get('content-length') || 0) > MAX_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new Error('Chrome usage lookup failed.');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > MAX_RESPONSE_BYTES) throw new Error('Chrome usage response is too large.');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  } finally { await reader.cancel().catch(() => {}); }
}

export async function loadChromeIdentity(directory, { fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  const file = path.join(directory, 'chrome-identity.json');
  let record = { ...BUNDLED_CHROME_SHARE, checkedAt: 0, fetchedAt: 0 };
  try {
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const share = validateShare(saved, now);
    if (!Number.isFinite(saved.checkedAt) || saved.checkedAt < 0 || saved.checkedAt > now ||
        !Number.isFinite(saved.fetchedAt) || saved.fetchedAt < 0 || saved.fetchedAt > saved.checkedAt) throw new Error('Invalid cache.');
    record = { ...share, checkedAt: saved.checkedAt, fetchedAt: saved.fetchedAt };
  } catch {}
  if (!record.checkedAt || now - record.checkedAt >= IDENTITY_CHECK_INTERVAL) {
    try {
      const response = await fetchImpl(CHROME_SHARE_URL, { signal: AbortSignal.timeout(10000), credentials: 'omit', redirect: 'error',
        headers: { Accept: 'text/html', 'User-Agent': 'HelltubeCookieHelper/1.0' } });
      const share = parseChromeShare(await responseText(response), now);
      // Do not replace a good selection with an old CDN snapshot or implausibly stale report.
      if (share.period < record.period || now - Date.parse(share.period + '-01T00:00:00Z') > 120 * IDENTITY_CHECK_INTERVAL) {
        throw new Error('Chrome usage report is stale.');
      }
      record = { ...share, checkedAt: now, fetchedAt: now };
    } catch {
      record.checkedAt = now;
    }
    // Lookup/cache failures must not prevent a cookie refresh or restore the native headless UA.
    await atomicWrite(file, JSON.stringify(record, null, 2)).catch(() => {});
  }
  const source = !record.fetchedAt ? 'bundled' : record.fetchedAt < record.checkedAt ? 'cached' : 'statcounter';
  return { ...record, source, userAgent: chromeUserAgent(record.major),
    description: `Chrome ${record.major} (${record.period} worldwide usage${source === 'statcounter' ? '' : `, ${source}`})` };
}
