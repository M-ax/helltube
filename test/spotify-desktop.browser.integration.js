import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';

test('Spotify VM RTP reaches two browsers with audio, shared controls, and skip cleanup', {timeout: 60000}, async t => {
  const {instance, url} = await start(t);
  const room = instance.rooms.get('lobby');
  const item = makeItem({kind: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'},
    {title: 'VM transport test', status: 'ready', audioOnly: true});
  instance.rooms.add(room, [item]);
  let enabled = false, capturing = false, playback = 'Stopped', source = '', encoder;
  let encoderError = '';
  const stop = () => { encoder?.kill(); encoder = null; capturing = false; };
  t.after(stop);
  instance.spotifyDesktop.enabled = true;
  instance.spotifyDesktop.bridge = {
    async request(action, data) {
      if (action === 'status') return {enabled, capturing, playback, url: source, available: true};
      if (action === 'open') { source = data.uri; playback = 'Playing'; }
      if (action === 'pause') playback = 'Paused';
      if (action === 'play') playback = 'Playing';
      if (action === 'stop') stop();
      if (action === 'capture') {
        const target = track => `rtp://127.0.0.1:${track.port}?rtcpport=${track.rtcpPort}&pkt_size=1200`;
        encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-re', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=15',
          '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
          '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p', '-g', '15',
          '-f', 'rtp', '-payload_type', '102', '-ssrc', String(data.video.ssrc), target(data.video),
          '-map', '1:a:0', '-vn', '-c:a', 'libopus', '-ac', '2', '-ar', '48000', '-b:a', '128k',
          '-f', 'rtp', '-payload_type', '111', '-ssrc', String(data.audio.ssrc), target(data.audio)],
        {stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true});
        encoder.stderr.on('data', chunk => { encoderError += chunk.toString(); });
        encoder.on('error', error => { encoderError += error.message; capturing = false; });
        encoder.on('exit', () => { capturing = false; });
        capturing = true;
      }
      return {};
    },
    close: stop,
  };
  instance.spotifyDesktop.start();
  const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
  t.after(() => browser.close());
  const pages = await Promise.all([browser.newPage(), browser.newPage()]);
  for (const page of pages) {
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.getByText('Sign into Spotify and enable Helltube sharing on the private desktop.', {exact: true}).waitFor();
    assert.equal(await page.locator('iframe').count(), 0, 'Shared mode never also starts local Spotify playback');
  }
  enabled = true;
  for (const page of pages) {
    await until(async () => {
      assert.equal(encoderError, '');
      return page.locator('.desktop-tile video').evaluateAll(videos => videos.length === 1 &&
        videos[0].videoWidth === 640 && videos[0].readyState >= 2 && !videos[0].paused);
    }, 20000);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(await page.locator('.desktop-tile video').evaluate(video =>
      video.srcObject.getTracks().map(track => track.kind).sort()), ['audio', 'video']);
    const audible = await page.locator('.desktop-tile video').evaluate(async video => {
      const context = new AudioContext();
      await context.resume();
      const source = context.createMediaStreamSource(video.srcObject);
      const analyser = context.createAnalyser();
      source.connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      let peak = 0;
      for (let i = 0; i < 20 && peak < 0.01; i++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        analyser.getFloatTimeDomainData(samples);
        peak = Math.max(...samples.map(Math.abs));
      }
      await context.close();
      return peak;
    });
    assert.ok(audible > 0.01, 'The received audio contains the actual test tone');
  }
  await pages[0].getByRole('button', {name: 'Pause Spotify for everyone'}).click();
  for (const page of pages) await page.getByRole('button', {name: 'Play Spotify for everyone'}).waitFor();
  assert.equal(playback, 'Paused');
  await pages[1].getByRole('button', {name: 'Play Spotify for everyone'}).click();
  await pages[0].getByRole('button', {name: 'Pause Spotify for everyone'}).waitFor();
  assert.equal(playback, 'Playing');
  await pages[0].getByRole('button', {name: 'Skip video for everyone'}).click();
  await until(() => instance.desktop.sessions.size === 0 && !capturing);
  for (const page of pages) await until(() => page.locator('.desktop-tile').count().then(count => count === 0));
  assert.equal(room.history[0].id, item.id);
  assert.equal(room.current, null);
});
