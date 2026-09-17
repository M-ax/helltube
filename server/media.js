import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, open, readFile, readdir, stat, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { youtubeNetwork } from './youtube-network.js';
import { FILE_INPUT_FORMATS, HOSTED_INPUT_FORMATS, probeCommand, probeDuration } from './media-metadata.js';
import { sponsorPosition } from '../shared/sponsorblock.js';
import { createProgressReader } from './media-progress.js';
import { EncryptedFmp4 } from './encrypted-fmp4.js';

export function playlistProgress(contents, baseTime = 0) {
  const durations = [...contents.matchAll(/^#EXTINF:([\d.]+)/gm)].map(m => Number(m[1]));
  return { bufferedUntil: baseTime + durations.reduce((n, d) => n + d, 0),
    complete: contents.includes('#EXT-X-ENDLIST'), segments: durations.length };
}

export async function available(command, args = ['-version']) {
  return new Promise(resolve => {
    const child = spawn(command, args, { windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { child.kill(); resolve(false); }, 10000);
    child.on('error', () => { clearTimeout(timer); resolve(false); });
    child.on('close', code => { clearTimeout(timer); resolve(code === 0); });
  });
}

export class Media {
  constructor(config, rooms, uploads, youtube, twitch) {
    this.config = config;
    this.rooms = rooms;
    this.uploads = uploads;
    this.youtube = youtube;
    this.twitch = twitch;
    this.sourceSecret = randomBytes(32).toString('hex');
    this.jobs = new Map();
    this.dir = path.join(config.dataDir, 'media', randomUUID());
    this.keyDir = path.join(config.dataDir, 'media-keys', path.basename(this.dir));
    this.closed = false;
    this.listening = false;
    this.polling = false;
    this.port = config.port;
    this.lastQuotaCheck = 0;
    this.cleanups = new Set();
    this.retiring = new Set();
  }

  async init() {
    await rm(path.dirname(this.dir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await rm(path.dirname(this.keyDir), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    await mkdir(this.dir, { recursive: true });
    await mkdir(this.keyDir, { recursive: true, mode: 0o700 });
    await chmod(path.dirname(this.keyDir), 0o700);
    await chmod(this.keyDir, 0o700);
    this.rooms.on('prepare', () => this.schedule());
    this.rooms.on('seek', (room, position) => {
      const job = this.jobs.get(room.current.id);
      const qualities = room.current.media?.qualities || [room.current.media].filter(Boolean);
      const prepared = qualities.find(quality => position >= quality.baseTime &&
        (quality.complete ? position <= quality.bufferedUntil : position < quality.bufferedUntil - 1));
      if (job && prepared) {
        room.current.media = {...prepared, qualities};
        return;
      }
      if (job && position === job.baseTime && !job.done) return;
      if (job) this.dispose(job);
      room.current.status = 'queued';
      room.current.error = null;
      room.current.media = null;
      room.current.preparation = null;
      room.current.source.startAt = position;
    });
    this.timer = setInterval(() => this.poll().catch(error => console.error('Media monitor:', error.message)), 500);
    this.timer.unref();
  }

  schedule() {
    if (this.closed || !this.listening) return;
    const allRooms = [...this.rooms.rooms.values()];
    const wanted = [...allRooms.map(r => r.current), ...allRooms.map(r => r.queue[0])].filter(Boolean);
    const wantedIds = new Set(wanted.map(i => i.id));
    const referenced = new Set(this.rooms.allItems().map(i => i.id));
    for (const job of this.jobs.values()) {
      if (!referenced.has(job.item.id) || (!wantedIds.has(job.item.id) && !job.done)) this.dispose(job);
    }
    for (const upload of this.uploads.uploads.values()) {
      if (!upload.creating && !referenced.has(upload.item.id)) this.uploads.discard(upload).catch(error => console.error('Upload cleanup:', error.message));
    }
    let running = [...this.jobs.values()].filter(j => !j.done).length;
    for (const item of wanted) {
      if (running >= this.config.maxTranscoders) break;
      if (this.jobs.has(item.id) || item.status === 'error' || item.kind === 'desktop') continue;
      if (item.kind === 'upload') {
        const upload = this.uploads.uploads.get(item.source.uploadId);
        if (!upload || (!upload.complete && upload.received < 64 * 1024)) continue;
      }
      running++;
      this.start(item, item.source.startAt || 0);
    }
  }

  start(item, baseTime, input = null) {
    const id = randomUUID();
    const job = { id, item, baseTime, input, dir: path.join(this.dir, id), child: null, done: false, cancelled: false,
      key: randomBytes(16), keyDir: path.join(this.keyDir, id), lastProgress: Date.now(), lastBuffered: baseTime, errors: '' };
    this.jobs.set(item.id, job);
    item.status = 'processing';
    item.media = null;
    item.preparation = { stage: 'metadata', baseTime, seconds: 0 };
    job.task = this.run(job).catch(error => {
      if (job.cancelled) return;
      if (item.kind === 'upload' && item.source.complete && job.inputComplete === false && !item.media) {
        this.dispose(job);
        return;
      }
      job.done = true;
      item.status = 'error';
      item.error = error.message;
      for (const room of this.rooms.rooms.values()) {
        if (room.current?.id === item.id) {
          room.resumeWhenReady = false;
          this.rooms.stamp(room, this.rooms.position(room), true);
        }
      }
    });
  }

  allJobs() {
    return [...this.jobs.values()].flatMap(job => job.original ? [job, job.original] : [job]);
  }

  async prepareEncryption(job) {
    await mkdir(job.dir, { recursive: true });
    await mkdir(job.keyDir, { recursive: true, mode: 0o700 });
    await chmod(job.keyDir, 0o700);
    const keyFile = path.resolve(job.keyDir, 'key.bin');
    const keyInfoFile = path.join(job.keyDir, 'key-info');
    await writeFile(keyFile, job.key, { flag: 'wx', mode: 0o600 });
    await writeFile(keyInfoFile, `/direct/media/${job.id}/key.bin\n${keyFile}\n`, { flag: 'wx', mode: 0o600 });
    await chmod(keyFile, 0o600);
    await chmod(keyInfoFile, 0o600);
    return keyInfoFile;
  }

  async run(job) {
    const keyInfoFile = await this.prepareEncryption(job);
    const { item } = job;
    let { baseTime } = job;
    const network = youtubeNetwork(item.kind === 'youtube' ? this.config : {});
    const args = ['-hide_banner', '-loglevel', this.config.ffmpegLogLevel || 'warning', '-nostdin', '-y'];
    let inputs;
    let copyQuality;
    if (item.kind === 'youtube' || item.kind === 'twitch') {
      const resolved = await this[item.kind].resolve(item.source.url);
      if (job.cancelled) return;
      if (resolved.duration) item.duration = resolved.duration;
      if (item.kind === 'youtube') {
        item.sponsorSegments = resolved.sponsorSegments || [];
        const start = sponsorPosition(item, baseTime);
        if (start !== baseTime) {
          baseTime = job.baseTime = job.lastBuffered = item.source.startAt = start;
          if (item.duration > 0 && start >= item.duration) { job.done = true; return; }
        }
      }
      if (baseTime > 0 && item.duration > 0 && baseTime >= item.duration) {
        throw new Error(`Start time must be before the end of the video (${item.duration} seconds).`);
      }
      inputs = resolved.inputs;
      copyQuality = resolved.copyQuality;
    } else if (item.kind === 'http') {
      inputs = [{ url: `http://127.0.0.1:${this.port}/internal/remote/${job.id}?key=${this.sourceSecret}`, headers: {} }];
      if (job.cancelled) return;
      if (!(Number.isFinite(item.duration) && item.duration > 0)) {
        job.probeController = new AbortController();
        const duration = await probeDuration(inputs[0].url, {
          command: probeCommand(this.config), signal: job.probeController.signal,
        });
        job.probeController = null;
        if (job.cancelled) return;
        if (duration !== null) item.duration = duration;
      }
      if (baseTime > 0 && item.duration > 0 && baseTime >= item.duration) {
        throw new Error(`Start time must be before the end of the video (${item.duration} seconds).`);
      }
    } else if (item.kind === 'desktop') {
      inputs = [{url: 'pipe:0', headers: {}}];
    } else {
      const upload = this.uploads.get(item.source.uploadId);
      job.inputComplete = upload.complete;
      const handle = await open(upload.file, 'r');
      const header = Buffer.alloc(512);
      try { await handle.read(header, 0, header.length, 0); }
      finally { await handle.close(); }
      if (header.toString('utf8').trimStart().startsWith('#EXTM3U') || /<MPD[\s>]/i.test(header.toString('utf8'))) {
        job.errors = 'Uploaded network playlists are not on whitelist.';
        throw new Error(job.errors);
      }
      if (header.toString('ascii', 4, 8) === 'ftyp') args.push('-use_mfra_for', '0');
      if (!upload.complete) args.push('-seekable', '0', '-probesize', '1048576', '-analyzeduration', '2000000');
      inputs = [{ url: `http://127.0.0.1:${this.port}/internal/uploads/${upload.id}?key=${this.uploads.secret}`, headers: {} }];
    }
    if (job.cancelled) return;
    item.preparation = { stage: 'transcoding', baseTime, seconds: 0 };
    const inputFormats = item.kind === 'http' ? HOSTED_INPUT_FORMATS : FILE_INPUT_FORMATS +
      (item.kind === 'youtube' || item.kind === 'twitch' ? ',hls' : '');
    const inputArgs = (start) => {
      const result = [];
      for (const input of inputs) {
        if (item.kind === 'desktop') {
          result.push('-probesize', '1048576', '-analyzeduration', '1000000',
            '-protocol_whitelist', 'pipe', '-f', 'webm', '-i', 'pipe:0');
          continue;
        }
        if (start > 0) result.push('-ss', String(start));
        if (network.proxy) result.push('-http_proxy', network.proxy);
        const headers = Object.entries(input.headers).filter(([key, value]) =>
          /^[a-zA-Z-]+$/.test(key) && !/[\r\n]/.test(String(value))).map(([k, v]) => `${k}: ${v}\r\n`).join('');
        if (headers) result.push('-headers', headers);
        result.push('-rw_timeout', '120000000', '-protocol_whitelist', `http,https,tcp,tls,crypto${network.proxy ? ',httpproxy' : ''}`,
          '-format_whitelist', inputFormats, '-i', input.url);
      }
      return result;
    };
    const outputArgs = (rendition, keyInfo) => ['-avoid_negative_ts', rendition.copyTimestamps ? 'disabled' : 'make_zero',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'event', '-hls_list_size', '0',
      ...(rendition.clearDir ? ['-hls_segment_type', 'fmp4', '-hls_fmp4_init_filename', 'init.mp4'] : ['-hls_key_info_file', keyInfo]),
      ...(rendition.copyTimestamps ? ['-hls_segment_options', 'movflags=+frag_discont:use_editlist=0:avoid_negative_ts=disabled'] : []),
      '-hls_flags', `independent_segments+temp_file${rendition.clearDir ? '' : '+periodic_rekey'}`,
      '-hls_segment_filename', path.join(rendition.clearDir || rendition.dir, `segment-%06d.${rendition.clearDir ? 'm4s' : 'ts'}`),
      path.join(rendition.clearDir || rendition.dir, 'index.m3u8')];
    let originalTask = Promise.resolve();
    if (copyQuality) {
      const id = randomUUID();
      // Retain a short preroll, then measure the copied fragment's real start so an
      // imprecise keyframe seek cannot shift the room timeline.
      const copyStart = Math.max(0, baseTime - 4);
      job.original = {id, item, baseTime: 0, requestedStart: baseTime, copyTimestamps: copyStart > 0,
        dir: path.join(this.dir, id), keyDir: path.join(this.keyDir, id),
        key: randomBytes(16), label: copyQuality.label, lastProgress: Date.now(), lastBuffered: 0, errors: ''};
      const original = job.original;
      if (copyQuality.container === 'fmp4' || original.copyTimestamps) {
        original.clearDir = path.join(original.keyDir, 'staging');
        original.publisher = new EncryptedFmp4(original);
      }
      originalTask = (async () => {
        const keyInfo = await this.prepareEncryption(original);
        if (original.clearDir) await mkdir(original.clearDir, {recursive: true, mode: 0o700});
        if (job.cancelled) return;
        await this.convert(original, ['-hide_banner', '-loglevel', this.config.ffmpegLogLevel || 'warning', '-nostdin', '-y',
          ...(original.copyTimestamps ? ['-copyts', '-start_at_zero'] : []),
          ...inputArgs(copyStart), '-map', '0:v:0', '-map', inputs.length > 1 ? '1:a:0?' : '0:a:0?',
          '-c', 'copy', ...(original.clearDir && copyQuality.aacAudio ? ['-bsf:a', 'aac_adtstoasc'] : []),
          ...outputArgs(original, keyInfo)], network);
        await original.publisher?.publish();
      })().catch(error => { original.failed ||= error; }).finally(() => { original.done = true; });
    }
    args.push(...inputArgs(baseTime));
    args.push('-progress', 'pipe:1', '-stats_period', '0.5', '-nostats',
      '-map', item.kind === 'http' ? '0:v:0?' : '0:v:0', '-map', item.kind === 'desktop' ? '0:a:0' : inputs.length > 1 ? '1:a:0?' : '0:a:0?',
      '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '3000k', '-bufsize', '6000k',
      '-threads', '2', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', ...outputArgs(job, keyInfoFile));
    await Promise.all([
      this.convert(job, args, network, true).catch(error => { job.failed = error; }).finally(() => { job.encodingDone = true; }),
      originalTask,
    ]);
    if (!job.cancelled) {
      await this.refresh(job);
      if (!item.media?.complete) throw job.failed || new Error('The source did not produce a playable video.');
      job.done = true;
      item.duration = item.media.bufferedUntil;
    }
  }

  async convert(job, args, network, reportProgress = false) {
    await new Promise((resolve, reject) => {
      const command = /[\\/]/.test(this.config.ffmpeg) ? path.resolve(this.config.ffmpeg) : this.config.ffmpeg;
      job.child = spawn(command, args, { windowsHide: true, env: network.env,
        ...(job.clearDir ? {cwd: job.clearDir} : {}), stdio: [job.input ? 'pipe' : 'ignore', 'pipe', 'pipe'] });
      if (job.input) {
        job.child.stdin.on('error', () => {}); // FFmpeg reports input failures on close.
        job.input.pipe(job.child.stdin);
      }
      job.child.stdout.on('data', createProgressReader(progress => {
        if (job.cancelled || !reportProgress) return;
        job.item.preparation = { ...job.item.preparation, ...progress };
      }));
      job.child.stderr.on('data', data => { job.errors = (job.errors + data).slice(-12000); });
      job.child.on('error', error => reject(new Error(`Could not start FFmpeg: ${error.code || error.message}`)));
      job.child.on('close', code => {
        if (job.cancelled) return resolve();
        if (code !== 0) {
          console.error('FFmpeg conversion:', job.errors.replace(/https?:\/\/\S+/g, '[source]'));
          return reject(new Error('Video conversion failed. Check the source format and server FFmpeg logs; skip to continue.'));
        }
        resolve();
      });
    });
  }

  async refresh(job) {
    if (job.cancelled || job.item.status === 'error') return;
    const qualities = [];
    for (const rendition of [job.original, job].filter(Boolean)) {
      if (rendition.failed) continue;
      try { await rendition.publisher?.publish(); }
      catch (error) {
        rendition.failed = error;
        console.error('Original HLS publication:', error.message.replace(/https?:\/\/\S+/g, '[source]'));
        rendition.child?.kill();
        continue;
      }
      let contents;
      try { contents = await readFile(path.join(rendition.dir, 'index.m3u8'), 'utf8'); }
      catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      const progress = playlistProgress(contents, rendition.baseTime);
      if (progress.bufferedUntil > rendition.lastBuffered) {
        rendition.lastBuffered = progress.bufferedUntil;
        rendition.lastProgress = Date.now();
      }
      if (!progress.segments || progress.bufferedUntil <= job.baseTime) continue;
      qualities.push({id: rendition === job ? 'standard' : 'original',
        label: rendition === job ? 'Standard (up to 720p)' : rendition.label,
        url: `/media/${rendition.id}/index.m3u8`, baseTime: rendition.baseTime,
        bufferedUntil: progress.bufferedUntil, complete: progress.complete});
    }
    if (job.cancelled) return;
    if (!qualities.length) {
      job.item.media = null;
      return;
    }
    const room = [...this.rooms.rooms.values()].find(room => room.current?.id === job.item.id);
    const position = room ? this.rooms.position(room) : job.baseTime;
    // The room follows the furthest prepared rendition; each viewer selects its own.
    const selected = qualities.filter(quality => quality.baseTime <= position)
      .reduce((best, quality) => !best || quality.bufferedUntil > best.bufferedUntil ? quality : best, null) || qualities[0];
    job.item.media = {...selected, qualities};
    job.item.status = 'ready';
    job.item.preparation = { ...job.item.preparation, stage: selected.complete ? 'ready' : 'buffering' };
  }

  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.jobs.values()].filter(j => !j.done).map(async job => {
        await this.refresh(job);
        for (const rendition of [job, job.original].filter(Boolean)) {
          if (job.item.kind !== 'upload' && Date.now() - rendition.lastProgress > 180000) rendition.child?.kill();
        }
      }));
      if (Date.now() - this.lastQuotaCheck > 10000) {
        this.lastQuotaCheck = Date.now();
        let bytes = [...this.uploads.uploads.values()].reduce((n, u) => n + u.received, 0);
        for (const job of this.allJobs()) {
          for (const dir of [job.dir, job.clearDir].filter(Boolean)) {
            const files = await readdir(dir).catch(() => []);
            for (const file of files) bytes += (await stat(path.join(dir, file)).catch(() => ({ size: 0 }))).size;
          }
        }
        if (bytes > this.config.maxStorageBytes) {
          for (const job of [...this.jobs.values()].filter(j => !j.done)) {
            this.dispose(job);
            job.item.status = 'error';
            job.item.error = 'Media storage budget reached. Remove queue items or increase MAX_STORAGE_BYTES.';
          }
        }
      }
      this.schedule();
    } finally { this.polling = false; }
  }

  async cleanup() {
    this.schedule();
    await Promise.all(this.cleanups);
    for (const entry of await readdir(this.dir)) {
      if (this.retiring.has(entry) || this.allJobs().some(job => job.id === entry)) continue;
      await rm(path.join(this.dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const entry of await readdir(path.dirname(this.dir))) {
      if (entry === path.basename(this.dir)) continue;
      await rm(path.join(path.dirname(this.dir), entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  dispose(job) {
    job.input?.destroy();
    if (job.cancelled) return;
    job.cancelled = true;
    job.probeController?.abort();
    job.child?.kill();
    if (job.original) {
      job.original.cancelled = true;
      job.original.child?.kill();
      this.retiring.add(job.original.id);
    }
    if (this.jobs.get(job.item.id) === job) this.jobs.delete(job.item.id);
    job.item.media = null;
    job.item.preparation = null;
    job.item.status = 'queued';
    job.cleanup = Promise.resolve(job.task).then(async () => {
      for (const rendition of [job, job.original].filter(Boolean)) {
        await rendition.publisher?.pending.catch(() => {});
        rendition.key.fill(0);
        await Promise.all([rendition.dir, rendition.keyDir].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })));
      }
    })
      .catch(error => console.error('Media cleanup:', error.message));
    this.retiring.add(job.id);
    this.cleanups.add(job.cleanup);
    void job.cleanup.finally(() => {
      this.cleanups.delete(job.cleanup);
      this.retiring.delete(job.id);
      this.retiring.delete(job.original?.id);
    });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.youtube.close();
    this.twitch?.close();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.dispose(job);
    await Promise.all(this.cleanups);
    await Promise.all([this.dir, this.keyDir].map(dir => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })));
  }
}
