import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, stat, rm } from 'node:fs/promises';
import path from 'node:path';

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
  constructor(config, rooms, uploads, youtube) {
    this.config = config;
    this.rooms = rooms;
    this.uploads = uploads;
    this.youtube = youtube;
    this.jobs = new Map();
    this.dir = path.join(config.dataDir, 'media', randomUUID());
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
    await mkdir(this.dir, { recursive: true });
    this.rooms.on('prepare', () => this.schedule());
    this.rooms.on('seek', (room, position) => {
      const job = this.jobs.get(room.current.id);
      if (job && position >= job.baseTime && (position < (room.current.media?.bufferedUntil || 0) - 1 ||
        (position === job.baseTime && !job.done))) return;
      if (job) this.dispose(job);
      room.current.status = 'queued';
      room.current.error = null;
      room.current.media = null;
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
      if (this.jobs.has(item.id) || item.status === 'error') continue;
      if (item.kind === 'upload') {
        const upload = this.uploads.uploads.get(item.source.uploadId);
        if (!upload || (!upload.complete && upload.received < 64 * 1024)) continue;
      }
      running++;
      this.start(item, item.source.startAt || 0);
    }
  }

  start(item, baseTime) {
    const id = randomUUID();
    const job = { id, item, baseTime, dir: path.join(this.dir, id), child: null, done: false, cancelled: false,
      lastProgress: Date.now(), lastBuffered: baseTime, errors: '' };
    this.jobs.set(item.id, job);
    item.status = 'processing';
    item.media = null;
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

  async run(job) {
    await mkdir(job.dir, { recursive: true });
    const { item, baseTime } = job;
    const args = ['-hide_banner', '-loglevel', this.config.ffmpegLogLevel || 'warning', '-nostdin', '-y'];
    let inputs;
    if (item.kind === 'youtube') {
      const resolved = await this.youtube.resolve(item.source.url);
      if (resolved.duration) item.duration = resolved.duration;
      if (baseTime > 0 && item.duration > 0 && baseTime >= item.duration) {
        throw new Error(`Start time must be before the end of the video (${item.duration} seconds).`);
      }
      inputs = resolved.inputs;
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
    const inputFormats = 'mov,matroska,webm,avi,mpegts,mpeg,mpegvideo,ogg' + (item.kind === 'youtube' ? ',hls' : '');
    for (const input of inputs) {
      if (baseTime > 0) args.push('-ss', String(baseTime));
      const headers = Object.entries(input.headers).filter(([key, value]) =>
        /^[a-zA-Z-]+$/.test(key) && !/[\r\n]/.test(String(value))).map(([k, v]) => `${k}: ${v}\r\n`).join('');
      if (headers) args.push('-headers', headers);
      args.push('-rw_timeout', '120000000', '-protocol_whitelist', 'http,https,tcp,tls,crypto',
        '-format_whitelist', inputFormats, '-i', input.url);
    }
    args.push('-map', '0:v:0', '-map', inputs.length > 1 ? '1:a:0?' : '0:a:0?',
      '-vf', 'scale=w=min(1280\\,iw):h=min(720\\,ih):force_original_aspect_ratio=decrease:force_divisible_by=2',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-maxrate', '3000k', '-bufsize', '6000k',
      '-threads', '2', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
      '-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-avoid_negative_ts', 'make_zero',
      '-f', 'hls', '-hls_time', '2', '-hls_playlist_type', 'event', '-hls_list_size', '0',
      '-hls_flags', 'independent_segments+temp_file', '-hls_segment_filename', path.join(job.dir, 'segment-%06d.ts'),
      path.join(job.dir, 'index.m3u8'));
    await new Promise((resolve, reject) => {
      job.child = spawn(this.config.ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
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
    if (!job.cancelled) {
      await this.refresh(job);
      if (!item.media?.complete) throw new Error('The source did not produce a playable video.');
      job.done = true;
      item.duration = item.media.bufferedUntil;
    }
  }

  async refresh(job) {
    if (job.cancelled || job.item.status === 'error') return;
    let contents;
    try { contents = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (job.cancelled) return;
    const progress = playlistProgress(contents, job.baseTime);
    if (progress.segments > 0) {
      job.item.media = { url: `/media/${job.id}/index.m3u8`, baseTime: job.baseTime,
        bufferedUntil: progress.bufferedUntil, complete: progress.complete };
      job.item.status = 'ready';
      if (progress.bufferedUntil > job.lastBuffered) {
        job.lastBuffered = progress.bufferedUntil;
        job.lastProgress = Date.now();
      }
    }
  }

  async poll() {
    if (this.closed || this.polling) return;
    this.polling = true;
    try {
      await Promise.all([...this.jobs.values()].filter(j => !j.done).map(async job => {
        await this.refresh(job);
        if (job.item.kind === 'youtube' && Date.now() - job.lastProgress > 180000) {
          job.child?.kill();
        }
      }));
      if (Date.now() - this.lastQuotaCheck > 10000) {
        this.lastQuotaCheck = Date.now();
        let bytes = [...this.uploads.uploads.values()].reduce((n, u) => n + u.received, 0);
        for (const job of this.jobs.values()) {
          const files = await readdir(job.dir).catch(() => []);
          for (const file of files) bytes += (await stat(path.join(job.dir, file)).catch(() => ({ size: 0 }))).size;
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
      if (this.retiring.has(entry) || [...this.jobs.values()].some(job => job.id === entry)) continue;
      await rm(path.join(this.dir, entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
    for (const entry of await readdir(path.dirname(this.dir))) {
      if (entry === path.basename(this.dir)) continue;
      await rm(path.join(path.dirname(this.dir), entry), { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }

  dispose(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    job.child?.kill();
    if (this.jobs.get(job.item.id) === job) this.jobs.delete(job.item.id);
    job.item.media = null;
    job.item.status = 'queued';
    job.cleanup = Promise.resolve(job.task).then(() => rm(job.dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }))
      .catch(error => console.error('Media cleanup:', error.message));
    this.retiring.add(job.id);
    this.cleanups.add(job.cleanup);
    void job.cleanup.finally(() => { this.cleanups.delete(job.cleanup); this.retiring.delete(job.id); });
  }

  async close() {
    this.closed = true;
    clearInterval(this.timer);
    this.youtube.close();
    const jobs = [...this.jobs.values()];
    for (const job of jobs) this.dispose(job);
    await Promise.all(this.cleanups);
    await rm(this.dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}