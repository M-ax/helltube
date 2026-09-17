import test from 'node:test';
import assert from 'node:assert/strict';
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

test('desktop capture delivers live video and audible audio to a late viewer and releases tracks on stop', {timeout: 60000}, async t => {
    const {instance, url} = await start(t);
    assert.ok(instance.capabilities.ffmpeg, 'FFmpeg is required for desktop integration');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const sender = await browser.newPage();
    const errors = [];
    sender.on('pageerror', error => errors.push(error.message));
    await sender.addInitScript(() => {
        window.captureAudio = false;
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
    });
    await join(sender, url);
    await sender.getByRole('button', {name: 'Share desktop', exact: true}).click();
    await sender.getByRole('button', {name: 'Choose screen to share'}).click();
    await sender.getByRole('alert').filter({hasText: 'No shared audio'}).waitFor();
    assert.equal(instance.rooms.get('lobby').current, null);
    assert.equal(await sender.evaluate(() => window.captureTracks.every(track => track.readyState === 'ended')), true);
    await sender.evaluate(() => { window.captureAudio = true; });
    await sender.getByRole('button', {name: 'Choose screen to share'}).click();
    await sender.getByRole('button', {name: 'Stop sharing', exact: true}).waitFor();
    await until(() => instance.rooms.get('lobby').current?.media?.bufferedUntil >= 4, 20000);
    const item = instance.rooms.get('lobby').current;
    const job = instance.media.jobs.get(item.id);
    assert.ok(job);
    assert.equal(item.kind, 'desktop');
    assert.equal(await sender.locator('video').evaluate(video => video.muted), true);
    const viewer = await browser.newPage();
    viewer.on('pageerror', error => errors.push(error.message));
    await join(viewer, url);
    await until(() => viewer.locator('video').evaluate(video => video.videoWidth > 0 && !video.paused && video.currentTime > 0), 20000);
    const pixel = await viewer.locator('video').evaluate(video => {
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data];
    });
    assert.ok(pixel[0] > 180 && pixel[1] < 50 && pixel[2] < 50, `Received desktop frame: ${pixel}`);
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
