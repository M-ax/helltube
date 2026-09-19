import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDecipheriv } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { start, until } from './helpers.js';
import { BEN_ZONE_ID } from '../server/ben-zone.js';

const exec = promisify(execFile);

test('automatic mix contains cartoon video and only soundtrack audio; leaving kills the live encoder', {timeout: 45000}, async t => {
  const {instance, dir, url, connect} = await start(t, {benZone: {maxSongSeconds: 30}});
  const video = path.join(dir, 'cartoon.mp4');
  const audio = path.join(dir, 'song.wav');
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=160x90:r=30',
    '-f', 'lavfi', '-i', 'sine=frequency=300:sample_rate=48000', '-t', '30', '-c:v', 'libx264', '-preset', 'ultrafast',
    '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-movflags', '+faststart', '-y', video]);
  await exec('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=900:sample_rate=48000',
    '-t', '30', '-y', audio]);
  instance.app.get('/test-cartoon', (_req, res) => res.sendFile(video, {dotfiles: 'allow'}));
  instance.app.get('/test-song', (_req, res) => res.sendFile(audio, {dotfiles: 'allow'}));
  t.mock.method(instance.youtube, 'liveStreams', async () => [{id: 'aaaaaaaaaaa', channel: 'Cartoon', title: 'Cartoon live', url: 'https://www.youtube.com/watch?v=aaaaaaaaaaa'}]);
  let extractionSignal;
  t.mock.method(instance.youtube, 'resolveLive', async (_url, {signal}) => {
    extractionSignal = signal;
    return {inputs: [{url: `${url}/test-cartoon`, headers: {}}]};
  });
  t.mock.method(instance.soundcloud, 'resolve', async () => ({inputs: [{url: `${url}/test-song`, headers: {}}], duration: 30}));
  const ws = await connect();
  ws.send(JSON.stringify({type: 'join', roomId: BEN_ZONE_ID}));
  const room = instance.rooms.get(BEN_ZONE_ID);
  await until(() => {
    if (room.current?.status === 'error') throw new Error(instance.media.jobs.get(room.current.id)?.errors || room.current.error);
    return room.current?.status === 'ready';
  }, 20000);
  const job = instance.media.jobs.get(room.current.id);
  assert.ok(job.child);
  assert.equal(job.original, undefined, 'No rendition can leak the original cartoon soundtrack.');
  const playlist = await readFile(path.join(job.dir, 'index.m3u8'), 'utf8');
  const iv = Buffer.from(playlist.match(/IV=0x([a-f0-9]+)/)[1], 'hex');
  const segment = playlist.split(/\r?\n/).find(line => /^segment-.*\.ts$/.test(line));
  const encrypted = await readFile(path.join(job.dir, segment));
  const decipher = createDecipheriv('aes-128-cbc', job.key, iv);
  const decrypted = path.join(dir, 'mixed.ts');
  await writeFile(decrypted, Buffer.concat([decipher.update(encrypted), decipher.final()]));
  const probe = JSON.parse((await exec('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', decrypted])).stdout);
  assert.equal(probe.streams.filter(stream => stream.codec_type === 'video').length, 1);
  assert.equal(probe.streams.filter(stream => stream.codec_type === 'audio').length, 1);
  const {stdout: pcm} = await exec('ffmpeg', ['-v', 'error', '-i', decrypted, '-vn', '-ac', '1', '-ar', '48000', '-f', 's16le', '-'], {encoding: 'buffer'});
  const samples = Math.floor(pcm.length / 2);
  let crossings = 0;
  for (let i = 1; i < samples; i++) if (pcm.readInt16LE((i - 1) * 2) <= 0 && pcm.readInt16LE(i * 2) > 0) crossings++;
  const frequency = crossings / (samples / 48000);
  assert.ok(Math.abs(frequency - 900) < 25, `Expected soundtrack at 900 Hz, measured ${frequency} Hz; cartoon audio was 300 Hz.`);
  ws.terminate();
  await until(() => !room.members.size && job.cancelled);
  assert.equal(extractionSignal.aborted, true);
  assert.equal(instance.media.jobs.size, 0);
  await job.cleanup;
  assert.notEqual(job.child.exitCode, undefined);
  assert.equal(room.current, null);
});
