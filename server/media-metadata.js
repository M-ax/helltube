import { spawn } from 'node:child_process';
import path from 'node:path';

export const FILE_INPUT_FORMATS = 'mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,ogg';
export const HOSTED_INPUT_FORMATS = `${FILE_INPUT_FORMATS},mp3,flac,wav,aac,aiff`;

export function metadataDuration(output) {
  try {
    const data = JSON.parse(output);
    const positive = value => (typeof value === 'string' || typeof value === 'number') &&
      Number.isFinite(Number(value)) && Number(value) > 0 && Number(value) <= Number.MAX_SAFE_INTEGER;
    if (positive(data?.format?.duration)) return Number(data.format.duration);
    const durations = (Array.isArray(data?.streams) ? data.streams : [])
      .filter(stream => ['video', 'audio'].includes(stream?.codec_type) && positive(stream.duration))
      .map(stream => Number(stream.duration));
    return durations.length ? Math.max(...durations) : null;
  } catch { return null; }
}

export function probeCommand(config = {}) {
  return config.ffprobe || path.join(path.dirname(config.ffmpeg || 'ffmpeg'),
    process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
}

// Input is the job's authenticated loopback URL, never the upstream or signed watch-page URL.
export function probeDuration(source, { command = 'ffprobe', signal, timeoutMs = 10000 } = {}) {
  if (signal?.aborted) return Promise.resolve(null);
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, ['-v', 'error', '-rw_timeout', '5000000',
        '-probesize', '1048576', '-analyzeduration', '1000000', '-fpsprobesize', '0',
        '-skip_estimate_duration_from_pts', '1', '-protocol_whitelist', 'http,tcp',
        '-format_whitelist', HOSTED_INPUT_FORMATS, '-show_entries', 'format=duration:stream=codec_type,duration',
        '-of', 'json', '-i', source], {
        windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(https?|all|no)_proxy$/i.test(key))),
      });
    } catch { resolve(null); return; }
    const chunks = [];
    let bytes = 0;
    let invalid = false;
    let killTimer;
    const stop = () => {
      if (invalid) return;
      invalid = true;
      child.kill();
      killTimer = setTimeout(() => child.kill('SIGKILL'), 1000);
      killTimer.unref();
    };
    const timer = setTimeout(stop, timeoutMs);
    timer.unref();
    signal?.addEventListener('abort', stop, { once: true });
    child.stdout.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 64 * 1024) stop();
      if (!invalid) chunks.push(chunk);
    });
    child.on('error', () => { invalid = true; });
    child.on('close', code => {
      clearTimeout(timer);
      clearTimeout(killTimer);
      signal?.removeEventListener('abort', stop);
      resolve(!invalid && !signal?.aborted && code === 0 ? metadataDuration(Buffer.concat(chunks).toString('utf8')) : null);
    });
    if (signal?.aborted) stop();
  });
}
