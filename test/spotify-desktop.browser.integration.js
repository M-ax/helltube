import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';

test('Spotify visualizations, local view switching and consecutive tracks retain one audible VM stream', {timeout: 90000}, async t => {
  const {instance, url} = await start(t);
  const room = instance.rooms.get('lobby');
  const item = makeItem({kind: 'spotify', url: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'},
    {title: 'VM transport test', status: 'ready', audioOnly: true});
  const next = makeItem({kind: 'spotify', url: 'https://open.spotify.com/track/7ouMYWpwJ422jRcDASZB7P'},
    {title: 'Next Spotify song', status: 'ready', audioOnly: true});
  instance.rooms.add(room, [item, next]);
  let enabled = false, capturing = false, playback = 'Stopped', source = '', encoder;
  let encoderError = '';
  let captures = 0;
  const playerControls = [];
  const stop = () => { encoder?.kill(); encoder = null; capturing = false; };
  t.after(stop);
  instance.spotifyDesktop.enabled = true;
  instance.spotifyDesktop.bridge = {
    async request(action, data) {
      if (action === 'status') return {enabled, capturing, playback, url: source, available: true};
      if (action === 'open') { if (!data.keepCapture) stop(); source = data.uri; playback = 'Playing'; }
      if (action === 'pause') playback = 'Paused';
      if (action === 'play') playback = 'Playing';
      if (action === 'previous' || action === 'next') playerControls.push(action);
      if (action === 'stop') stop();
      if (action === 'capture') {
        captures++;
        const target = track => `rtp://127.0.0.1:${track.port}?rtcpport=${track.rtcpPort}&pkt_size=1200`;
        encoder = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin',
          '-re', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=15',
          '-re', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
          '-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-profile:v', 'baseline', '-level', '4.0', '-threads', '2', '-pix_fmt', 'yuv420p', '-g', '15',
          '-b:v', '4500k', '-maxrate', '6000k', '-bufsize', '3000k',
          '-f', 'rtp', '-payload_type', '102', '-ssrc', String(data.video.ssrc), target(data.video),
          '-map', '1:a:0', '-vn', '-c:a', 'libopus', '-ac', '2', '-ar', '48000', '-b:a', '320k',
          '-application', 'audio', '-compression_level', '10', '-vbr', 'off', '-frame_duration', '20',
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
    await page.addInitScript(() => localStorage.setItem('helltube.visualization', 'off'));
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    await page.getByText('Sign into Spotify and enable Helltube sharing on the private desktop.', {exact: true}).waitFor();
    const controls = page.getByRole('group', {name: 'Spotify playback controls', exact: true});
    assert.equal(await controls.locator('button:disabled').count(), 3);
    assert.equal(await page.locator('iframe').count(), 0, 'Shared mode never also starts local Spotify playback');
  }
  enabled = true;
  for (const page of pages) {
    await until(async () => {
      assert.equal(encoderError, '');
      return page.locator('.desktop-tile video').evaluateAll(videos => videos.length === 1 &&
        videos[0].readyState >= 2 && !videos[0].paused);
    }, 20000);
    assert.equal(await page.locator('iframe').count(), 0);
    assert.deepEqual(await page.locator('.desktop-tile video').evaluate(video =>
      video.srcObject.getTracks().map(track => track.kind).sort()), ['audio']);
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
    await page.getByText('Spotify · one room at a time', {exact: true}).waitFor();
    assert.equal(await page.locator('.player-shell').getAttribute('data-spotify-view'), 'visualizations');
    const library = page.getByLabel('Audio visualization library');
    await library.waitFor();
    assert.equal(await library.getByRole('button', {name: 'Spectrum · normal', exact: true}).getAttribute('aria-pressed'), 'true');
    await until(() => page.locator('.video-canvas').evaluate(canvas => {
      window.dispatchEvent(new Event('resize'));
      const gl = canvas.getContext('webgl');
      if (!gl) return false;
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.some((value, i) => i % 4 === 1 && value > 100);
    }));
    assert.equal(await page.getByText('Spotify keeps its audio private.', {exact: false}).count(), 0);
    await page.locator('.desktop-tile video').evaluate(video => {
      window.spotifyVideo = video;
      window.spotifyStream = video.srcObject;
      window.spotifyAudio = video.srcObject.getAudioTracks()[0];
      window.spotifyEmptyEvents = 0;
      window.spotifyPauseEvents = 0;
      window.spotifyDetachments = 0;
      video.addEventListener('emptied', () => window.spotifyEmptyEvents++);
      video.addEventListener('pause', () => window.spotifyPauseEvents++);
      const context = new AudioContext();
      const analyser = context.createAnalyser();
      context.createMediaStreamSource(video.srcObject).connect(analyser);
      const samples = new Float32Array(analyser.fftSize);
      window.spotifyAudioSamples = [];
      window.spotifyAudioProbe = setInterval(() => {
        analyser.getFloatTimeDomainData(samples);
        window.spotifyAudioSamples.push(Math.max(...samples.map(Math.abs)));
      }, 25);
      new MutationObserver(records => {
        for (const record of records) for (const node of record.removedNodes) {
          if (node === video || node.contains?.(video)) window.spotifyDetachments++;
        }
      }).observe(document.querySelector('.video-viewport'), {childList: true, subtree: true});
    });
  }
  const session = instance.spotifyDesktop.active.session;
  const viewers = [...session.viewers.keys()];
  assert.ok([...session.viewers.values()].every(viewer => [...viewer.consumers.values()].every(c => c.kind === 'audio')),
    'Visualization viewers have no video subscription at all on initial connection');
  const audioConsumers = [...session.viewers.values()].map(viewer => [...viewer.consumers.values()][0]);
  const packets = async consumer => (await consumer.getStats())[0].packetCount;
  const chooseView = (page, name) => page.getByRole('group', {name: 'Spotify view on this device'})
    .getByRole('button', {name, exact: true}).click();
  const visibleDesktop = page => until(() => page.locator('.desktop-tile video').evaluate(video =>
    video.videoWidth === 1920 && video.videoHeight === 1080 && video.readyState >= 2 && !video.paused &&
    video.closest('.player-shell').dataset.spotifyView === 'desktop'), 10000);
  const checkLoading = async page => {
    await page.getByText('Loading desktop video…', {exact: true}).waitFor();
    assert.equal(await page.getByLabel('Audio visualization library').isVisible(), true);
    assert.equal(await page.locator('.player-shell').getAttribute('data-spotify-view'), 'visualizations');
    assert.equal(await page.locator('.desktop-tile video').evaluate(video => getComputedStyle(video).opacity), '0');
    assert.equal(await page.locator('.desktop-video-loading .spinner').isVisible(), true);
    assert.equal(await page.locator('.video-canvas').evaluate(canvas => {
      window.dispatchEvent(new Event('resize'));
      const gl = canvas.getContext('webgl');
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      return pixels.some((value, i) => i % 4 === 1 && value > 100);
    }), true, 'The visualization is still rendered behind the spinner');
  };
  const checkControls = async page => {
    const controls = page.getByRole('group', {name: 'Spotify playback controls', exact: true});
    assert.equal(await controls.locator('button:enabled').count(), 3);
    assert.equal(await page.locator('.shared-controls .play-button').count(), 0, 'The normal pause button is hidden');
    assert.equal(await page.locator('.shared-controls').getByRole('button', {name: 'Skip video for everyone'}).count(), 1);
    assert.equal(await page.locator('.desktop-tile video').evaluate(video => video.controls), false, 'Native desktop controls never pause Spotify locally');
    assert.equal(await page.locator('.desktop-fullscreen').count(), 0, 'Fullscreen uses the whole player, retaining Spotify controls');
    const layout = await controls.evaluate(panel => {
      const box = panel.getBoundingClientRect(), row = panel.closest('.transport-row').getBoundingClientRect();
      const left = panel.previousElementSibling.getBoundingClientRect(), right = panel.nextElementSibling.getBoundingClientRect();
      const viewport = panel.closest('.video-viewport').getBoundingClientRect();
      return {centered: Math.abs(box.x + box.width / 2 - row.x - row.width / 2) < 1,
        insideBar: box.top >= row.top && box.bottom <= row.bottom && Math.abs(row.bottom - viewport.bottom) < 2,
        noOverlap: left.right <= box.left && right.left >= box.right && right.right <= row.right,
        green: getComputedStyle(panel).backgroundColor};
    });
    assert.deepEqual(layout, {centered: true, insideBar: true, noOverlap: true, green: 'rgb(20, 83, 45)'});
  };
  await checkControls(pages[0]);
  await pages[0].screenshot({path: 'test-artifacts/spotify-shared-visualizations.png', fullPage: true});
  const perform = instance.desktop.perform.bind(instance.desktop);
  let failVideo = true;
  let videoResumeGate;
  const delayVideo = () => {
    let release;
    videoResumeGate = new Promise(resolve => release = resolve);
    return () => { videoResumeGate = null; release(); };
  };
  t.mock.method(instance.desktop, 'perform', async (session, peer, message) => {
    if (message.action === 'resume' && peer.consumers.get(message.consumerId)?.kind === 'video') {
      if (failVideo) {
        failVideo = false;
        throw new Error('Temporary video failure');
      }
      await videoResumeGate;
    }
    return perform(session, peer, message);
  });
  await chooseView(pages[0], 'Desktop');
  await pages[0].getByRole('button', {name: 'Retry video', exact: true}).waitFor();
  assert.equal(await pages[0].getByLabel('Audio visualization library').isVisible(), true, 'Video errors keep the visualization visible');
  assert.equal(await pages[0].locator('.desktop-video-loading').count(), 0, 'Errors replace the spinner with a retry control');
  const audioBeforeRetry = await Promise.all(audioConsumers.map(packets));
  await new Promise(resolve => setTimeout(resolve, 500));
  const audioDuringFailure = await Promise.all(audioConsumers.map(packets));
  assert.ok(audioDuringFailure.every((count, i) => count > audioBeforeRetry[i] + 10), 'Video failure leaves both audio receivers running');
  const releaseFirstVideo = delayVideo();
  await pages[0].getByRole('button', {name: 'Retry video', exact: true}).click();
  await checkLoading(pages[0]);
  await checkControls(pages[0]);
  await pages[0].locator('.desktop-tile video').evaluate(video => {
    video.dispatchEvent(new Event('loadeddata'));
    video.dispatchEvent(new Event('playing'));
  });
  await pages[0].waitForTimeout(400);
  await checkLoading(pages[0]);
  await pages[0].screenshot({path: 'test-artifacts/spotify-desktop-loading.png', fullPage: true});
  releaseFirstVideo();
  await visibleDesktop(pages[0]);
  assert.equal(await pages[0].locator('.desktop-video-loading').count(), 0);
  await checkControls(pages[0]);
  assert.equal(await pages[0].getByLabel('Audio visualization library').isVisible(), false);
  assert.equal(await pages[0].locator('.desktop-tile video').evaluate(video => getComputedStyle(video).opacity), '1');
  assert.equal(await pages[1].locator('.player-shell').getAttribute('data-spotify-view'), 'visualizations', 'View selection is local');
  await pages[0].screenshot({path: 'test-artifacts/spotify-shared-desktop.png', fullPage: true});
  const firstVideo = [...session.viewers.values()].flatMap(viewer => [...viewer.consumers.values()]).find(c => c.kind === 'video');
  await chooseView(pages[1], 'Desktop');
  await visibleDesktop(pages[1]);
  const secondVideo = [...session.viewers.values()].flatMap(viewer => [...viewer.consumers.values()]).find(c => c.kind === 'video' && c !== firstVideo);
  await chooseView(pages[0], 'Visualizations');
  await until(() => firstVideo.paused);
  const before = await Promise.all([firstVideo, secondVideo, ...audioConsumers].map(packets));
  await new Promise(resolve => setTimeout(resolve, 1000));
  const after = await Promise.all([firstVideo, secondVideo, ...audioConsumers].map(packets));
  assert.equal(after[0], before[0], 'Hidden desktop sends zero video packets');
  assert.ok(after[1] > before[1], 'Another desktop viewer still receives video');
  assert.ok(after[2] > before[2] + 20 && after[3] > before[3] + 20, 'Both audio streams continue while video is off');
  const releaseResumedVideo = delayVideo();
  await chooseView(pages[0], 'Desktop');
  await checkLoading(pages[0]);
  await pages[0].waitForTimeout(400);
  await checkLoading(pages[0]);
  await chooseView(pages[0], 'Visualizations');
  assert.equal(await pages[0].locator('.desktop-video-loading').count(), 0);
  releaseResumedVideo();
  await pages[0].waitForTimeout(300);
  await until(() => firstVideo.paused);
  assert.equal(await pages[0].locator('.player-shell').getAttribute('data-spotify-view'), 'visualizations', 'A cancelled transition cannot reveal a late frame');
  await chooseView(pages[0], 'Desktop');
  await until(async () => !firstVideo.paused && await packets(firstVideo) > after[0]);
  await visibleDesktop(pages[0]);
  await chooseView(pages[1], 'Visualizations');
  await until(() => secondVideo.paused);
  // Repeated toggles must reuse the video consumer and never touch music.
  for (let i = 0; i < 3; i++) {
    await chooseView(pages[0], 'Visualizations');
    await chooseView(pages[0], 'Desktop');
  }
  await until(() => !firstVideo.paused);
  assert.ok([...session.viewers.values()].every(viewer => viewer.consumers.size === 2));
  await pages[0].getByRole('button', {name: 'Pause Spotify for everyone'}).click();
  for (const page of pages) await page.getByRole('button', {name: 'Play Spotify for everyone'}).waitFor();
  assert.equal(playback, 'Paused');
  await pages[1].getByRole('button', {name: 'Play Spotify for everyone'}).click();
  await pages[0].getByRole('button', {name: 'Pause Spotify for everyone'}).waitFor();
  assert.equal(playback, 'Playing');
  await pages[0].getByRole('button', {name: 'Next track in Spotify', exact: true}).click();
  await pages[1].getByRole('button', {name: 'Previous track in Spotify', exact: true}).click();
  await until(() => playerControls.length === 2);
  assert.deepEqual(playerControls, ['next', 'previous']);
  assert.equal(room.current, item, 'Spotify navigation does not invoke the Helltube queue skip command');
  await pages[0].getByRole('button', {name: 'Skip video for everyone'}).click();
  await until(() => room.current === next && room.spotifyDesktop.state === 'sharing');
  assert.equal(instance.spotifyDesktop.active.session, session);
  assert.deepEqual([...session.viewers.keys()], viewers, 'Skipping does not reconnect the WebRTC viewers');
  assert.equal(captures, 1);
  for (const page of pages) {
    await page.getByRole('heading', {name: next.title, exact: true}).waitFor();
    assert.deepEqual(await page.locator('.desktop-tile video').evaluate(video => ({
      sameVideo: video === window.spotifyVideo, sameStream: video.srcObject === window.spotifyStream,
      sameAudio: video.srcObject.getAudioTracks()[0] === window.spotifyAudio,
      emptied: window.spotifyEmptyEvents, pauses: window.spotifyPauseEvents, detached: window.spotifyDetachments, playing: !video.paused,
    })), {sameVideo: true, sameStream: true, sameAudio: true, emptied: 0, pauses: 0, detached: 0, playing: true});
    const samples = await page.evaluate(() => { clearInterval(window.spotifyAudioProbe); return window.spotifyAudioSamples; });
    assert.ok(samples.length > 20);
    assert.ok(samples.filter(peak => peak > 0.01).length / samples.length > 0.98, 'Actual decoded music continues through view changes and skips');
  }
  assert.equal(await pages[0].locator('.player-shell').getAttribute('data-spotify-view'), 'desktop', 'The selected view survives song changes');
  await pages[0].getByRole('group', {name: 'Spotify view on this device'}).getByRole('button', {name: 'Visualizations', exact: true}).click();
  await pages[0].getByLabel('Audio visualization library').waitFor();
  await pages[0].getByRole('button', {name: 'Bass boosted', exact: true}).click();
  for (const page of pages) {
    await page.locator('[data-reaction="bassboost"]').waitFor();
    await until(() => page.locator('.desktop-tile video').evaluate(video => video.srcObject !== window.spotifyStream && !video.paused));
    assert.equal(await page.locator('.desktop-tile video').evaluate(video => video.srcObject.getVideoTracks()[0]
        === window.spotifyStream.getVideoTracks()[0]), true);
  }
  await chooseView(pages[0], 'Desktop');
  await visibleDesktop(pages[0]);
  await chooseView(pages[0], 'Visualizations');
  await until(() => pages[0].locator('[data-reaction="bassboost"]').count().then(count => count === 0));
  assert.equal(instance.spotifyDesktop.active.session, session, 'Bass processing keeps the Spotify relay session.');
  for (const width of [1440, 900, 700, 390, 320]) {
    await pages[0].setViewportSize({width, height: 900});
    for (const view of ['Desktop', 'Visualizations']) {
      await chooseView(pages[0], view);
      await checkControls(pages[0]);
    }
  }
  await pages[0].setViewportSize({width: 390, height: 844});
  assert.equal(await pages[0].evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await pages[0].screenshot({path: 'test-artifacts/spotify-shared-mobile.png', fullPage: true});
  await pages[0].getByRole('button', {name: 'Skip video for everyone'}).click();
  await until(() => instance.desktop.sessions.size === 0 && !capturing);
  for (const page of pages) await until(() => page.locator('.desktop-tile').count().then(count => count === 0));
  assert.deepEqual(room.history.map(value => value.id), [next.id, item.id]);
  assert.equal(room.current, null);
});
