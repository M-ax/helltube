import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

async function join(page, url) {
    await page.goto(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Enter Helltube'}).click();
    await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button').first().click();
    await page.getByRole('button', {name: 'Your files', exact: true}).waitFor();
}

async function availablePort() {
    const server = createServer();
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const port = server.address().port;
    await new Promise(resolve => server.close(resolve));
    return port;
}

for (const split of [false, true]) {
for (const withAudio of [false, true]) {
test(`desktop capture delivers ${withAudio ? 'video and audible audio' : 'video only'} to a late viewer (${split ? 'Worker + metal' : 'local'})`, {timeout: 90000}, async t => {
    const backend = await start(t);
    const {instance} = backend;
    let url = backend.url;
    if (split) {
        const {unstable_dev} = await import('wrangler');
        const port = await availablePort(), inspectorPort = await availablePort();
        url = `http://127.0.0.1:${port}`;
        const directOrigin = backend.url.replace('127.0.0.1', 'localhost');
        const secret = randomBytes(32).toString('hex');
        Object.assign(instance.media.config, {bareMetalOrigin: directOrigin, edgeProxySecret: secret});
        instance.media.config.origins.push(url);
        const worker = await unstable_dev(path.resolve('worker.js'), {
            config: path.resolve('wrangler.jsonc'), ip: '127.0.0.1', port, inspectorPort,
            local: true, persist: false, persistTo: path.join(backend.dir, 'worker'), logLevel: 'none',
            vars: {BARE_METAL_ORIGIN: directOrigin, EDGE_PROXY_SECRET: secret},
            experimental: {disableExperimentalWarning: true, disableDevRegistry: true, forceLocal: true,
                watch: false, liveReload: false, showInteractiveDevSession: false},
        });
        t.after(() => worker.stop());
    }
    assert.ok(instance.capabilities.ffmpeg, 'FFmpeg is required for desktop integration');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const sender = await browser.newPage();
    const errors = [];
    const responses = [];
    const watch = page => page.on('response', response => {
        const target = new URL(response.url());
        if (/\/(?:direct\/)?media\//.test(target.pathname)) responses.push({origin: target.origin, path: target.pathname, status: response.status()});
    });
    watch(sender);
    sender.on('pageerror', error => errors.push(error.message));
    await sender.addInitScript(withAudio => {
        window.captureAudio = withAudio;
        window.captureTracks = [];
        // Substitute only the OS picker. Exercise the real MediaRecorder, socket,
        // FFmpeg, encrypted HLS, and receiving browser decoder.
        navigator.mediaDevices.getDisplayMedia = async options => {
            window.captureOptions = options;
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const context = canvas.getContext('2d');
            let frame = 0;
            function draw() {
                context.fillStyle = '#ff0000'; context.fillRect(0, 0, 640, 360);
                context.fillStyle = '#ffffff'; context.fillRect(frame++ % 500, 250, 40, 40);
                window.captureAnimation = requestAnimationFrame(draw);
            }
            draw();
            const stream = canvas.captureStream(30);
            if (window.captureAudio) {
                window.captureContext = new AudioContext();
                await window.captureContext.resume();
                const oscillator = window.captureContext.createOscillator();
                const destination = window.captureContext.createMediaStreamDestination();
                oscillator.frequency.value = 440;
                oscillator.connect(destination); oscillator.start();
                stream.addTrack(destination.stream.getAudioTracks()[0]);
            }
            window.captureTracks.push(...stream.getTracks());
            return stream;
        };
    }, withAudio);
    await join(sender, url);
    await sender.getByRole('button', {name: 'Share desktop', exact: true}).click();
    await sender.getByRole('button', {name: 'Choose screen to share'}).click();
    await sender.getByRole('button', {name: 'Stop sharing', exact: true}).waitFor();
    await until(() => instance.rooms.get('lobby').current?.media?.bufferedUntil >= 4, 20000);
    const item = instance.rooms.get('lobby').current;
    const job = instance.media.jobs.get(item.id);
    assert.ok(job);
    assert.equal(item.kind, 'desktop');
    assert.equal(await sender.locator('video').evaluate(video => video.muted), withAudio);
    assert.match(await sender.locator('.desktop-sharing-status').textContent(), withAudio ? /Audio included/ : /Video only/);
    const viewer = await browser.newPage();
    watch(viewer);
    viewer.on('pageerror', error => errors.push(error.message));
    await join(viewer, url);
    await until(() => viewer.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && !video.paused && video.currentTime > 0), 20000);
    // Room alignment can briefly seek between readiness and pixel sampling.
    const pixel = await until(() => viewer.locator('video').evaluate(video => {
        if (video.readyState < 2) return false;
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
        const pixel = [...context.getImageData(0, 0, 1, 1).data];
        return pixel[3] === 255 ? pixel : false;
    }));
    assert.ok(pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50, `Received desktop frame: ${pixel}`);
    if (withAudio) {
      const audioPeak = await viewer.locator('video').evaluate(async video => {
        const audio = new AudioContext(); await audio.resume();
        const analyser = audio.createAnalyser(); analyser.fftSize = 2048;
        const source = audio.createMediaElementSource(video);
        source.connect(analyser); analyser.connect(audio.destination);
        const values = new Float32Array(analyser.fftSize);
        let peak = 0;
        for (let i = 0; i < 40 && peak < 0.1; i++) {
            await new Promise(resolve => setTimeout(resolve, 100));
            analyser.getFloatTimeDomainData(values);
            peak = Math.max(...values.map(Math.abs));
        }
        await audio.close();
        return peak;
    });
      assert.ok(audioPeak > 0.1, `Captured tone was audible in the receiving browser: ${audioPeak}`);
    }
    assert.equal(responses.some(response => response.status >= 400), false, JSON.stringify(responses.filter(response => response.status >= 400)));
    if (split) {
        const segments = responses.filter(response => response.path.endsWith('.ts'));
        assert.ok(segments.length > 0);
        assert.ok(segments.every(response => response.origin === backend.url.replace('127.0.0.1', 'localhost') && response.path.startsWith('/direct/media/')));
        assert.equal(await viewer.locator('.playback-health').getAttribute('data-delivery'), 'metal');
    }
    assert.equal(await viewer.getByRole('slider', {name: 'Seek shared video'}).isDisabled(), true);
    assert.equal(await viewer.getByRole('button', {name: 'Pause for everyone'}).isDisabled(), true);
    await sender.getByRole('button', {name: 'Stop sharing', exact: true}).click();
    await until(() => instance.rooms.get('lobby').current === null && instance.desktop.sessions.size === 0);
    assert.equal(await sender.evaluate(() => window.captureTracks.every(track => track.readyState === 'ended')), true);
    assert.equal(instance.rooms.get('lobby').history.length, 0);
    assert.equal(instance.media.jobs.has(item.id), false);
    await job.cleanup;
    assert.deepEqual(errors, []);
});
}
}
