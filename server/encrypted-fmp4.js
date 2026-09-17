import {createCipheriv} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import {setTimeout as delay} from 'node:timers/promises';
import path from 'node:path';
import {fmp4Timeline} from './fmp4-timeline.js';

// FFmpeg's HLS muxer cannot AES-128 encrypt fMP4. It writes copied packets to a
// private staging directory; only complete, encrypted files reach media delivery.
export class EncryptedFmp4 {
  constructor(job) {
    this.job = job;
    this.published = new Set();
    this.pending = Promise.resolve();
    this.contents = null;
  }

  publish() {
    this.pending = this.pending.then(() => this.publishOnce());
    return this.pending;
  }

  async encrypt(file, sequence) {
    const iv = Buffer.alloc(16);
    iv.writeBigUInt64BE(BigInt(sequence), 8);
    if (!this.published.has(file)) {
      const source = path.join(this.job.clearDir, file);
      const target = path.join(this.job.dir, file);
      await pipeline(createReadStream(source), createCipheriv('aes-128-cbc', this.job.key, iv),
        createWriteStream(`${target}.tmp`, {mode: 0o600}));
      await rename(`${target}.tmp`, target);
      this.published.add(file);
      // The EVENT playlist retains old names; the published set prevents rereads.
      if (file !== 'init.mp4') await rm(source);
    }
    return `#EXT-X-KEY:METHOD=AES-128,URI="/direct/media/${this.job.id}/key.bin",IV=0x${iv.toString('hex')}`;
  }

  async publishOnce() {
    if (this.job.cancelled) return;
    let contents;
    try { contents = await readFile(path.join(this.job.clearDir, 'index.m3u8'), 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (contents === this.contents) return;
    if (this.job.copyTimestamps && !this.job.timelineReady) {
      const first = contents.split(/\r?\n/).find(line => /^segment-\d{6,}\.m4s$/.test(line));
      if (!first) return;
      const timeline = await fmp4Timeline(path.join(this.job.clearDir, 'init.mp4'), path.join(this.job.clearDir, first));
      if (this.job.cancelled) return;
      if (timeline.baseTime > this.job.requestedStart) throw new Error('Copied stream starts after the requested position.');
      this.job.baseTime = timeline.baseTime;
      this.job.leadingDuration = timeline.leadingDuration;
      this.job.timelineReady = true;
    }
    const lines = [];
    let firstDuration = true;
    for (const line of contents.split(/\r?\n/)) {
      if (this.job.cancelled) return;
      if (line.startsWith('#EXT-X-MAP:')) {
        if (line !== '#EXT-X-MAP:URI="init.mp4"') throw new Error('Unexpected media initialization file.');
        lines.push(await this.encrypt('init.mp4', 0));
      } else if (line && !line.startsWith('#')) {
        const match = /^segment-(\d{6,})\.m4s$/.exec(line);
        if (!match) throw new Error('Unexpected media fragment.');
        lines.push(await this.encrypt(line, BigInt(match[1]) + 1n));
      }
      if (firstDuration && line.startsWith('#EXTINF:')) {
        firstDuration = false;
        lines.push(line.replace(/^#EXTINF:([\d.]+)/, (_, duration) =>
          `#EXTINF:${(Number(duration) + (this.job.leadingDuration || 0)).toFixed(6)}`));
      } else lines.push(line);
    }
    if (this.job.cancelled) return;
    const target = path.join(this.job.dir, 'index.m3u8');
    await writeFile(`${target}.tmp`, lines.join('\n'));
    // Windows can briefly lock the existing playlist while it is being served.
    // Keep that valid playlist in place until the atomic replacement succeeds.
    for (let attempt = 0; ; attempt++) {
      if (this.job.cancelled) return;
      try { await rename(`${target}.tmp`, target); break; }
      catch (error) {
        if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 6) throw error;
        await delay(50 * (attempt + 1));
      }
    }
    this.contents = contents;
  }
}
