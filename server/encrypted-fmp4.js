import {createCipheriv} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import {readFile, rename, rm, writeFile} from 'node:fs/promises';
import {pipeline} from 'node:stream/promises';
import path from 'node:path';

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
    const lines = [];
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
      lines.push(line);
    }
    if (this.job.cancelled) return;
    const target = path.join(this.job.dir, 'index.m3u8');
    await writeFile(`${target}.tmp`, lines.join('\n'));
    await rename(`${target}.tmp`, target);
    this.contents = contents;
  }
}
