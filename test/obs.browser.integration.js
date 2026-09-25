import test from 'node:test';
import assert from 'node:assert/strict';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';

test('WHIP publishes decoded H264 video and Opus audio to room viewers, including late joins', {timeout: 60000}, async t => {
    const h = await start(t, {ffmpeg: 'missing-obs-test', ytdlp: 'missing-obs-test'});
    const browser = await chromium.launch({channel: 'chrome', headless: true,
        args: ['--autoplay-policy=no-user-gesture-required', '--disable-background-timer-throttling', '--disable-renderer-backgrounding']});
    t.after(() => browser.close());
    const errors = [];
    async function viewer(username = 'admin') {
        const page = await browser.newPage();
        page.on('pageerror', e => errors.push(e.message));
        await page.goto(h.url);
        await page.getByLabel('Username', {exact: true}).fill(username);
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
        await page.getByRole('button', {name: 'Share desktop', exact: true}).click();
        return page;
    }
    const first = await viewer();
    await first.getByText('Stream with OBS Studio', {exact: true}).click();
    await first.getByRole('button', {name: 'Create OBS token'}).click();
    await until(() => first.getByLabel('Bearer token', {exact: true}).count());
    const token = await first.getByLabel('Bearer token', {exact: true}).inputValue();
    const endpoint = await first.getByLabel('Server URL', {exact: true}).inputValue();
    assert.equal(token.length, 64);
    assert.equal(await first.getByLabel('Bearer token', {exact: true}).getAttribute('type'), 'password');
    const sender = await browser.newPage();
    await sender.goto(h.url);
    // A real browser WHIP sender exercises SDP and encrypted media against the
    // native SFU; the OBS-shaped offer is also covered in obs.test.js.
    const result = await sender.evaluate(async ({endpoint, token}) => {
        const peer = new RTCPeerConnection({bundlePolicy: 'max-bundle'});
        const canvas = document.createElement('canvas');
        canvas.width = 640; canvas.height = 360;
        const ctx = canvas.getContext('2d');
        const draw = () => { ctx.fillStyle = '#d32010'; ctx.fillRect(0, 0, canvas.width, canvas.height); };
        draw();
        const timer = setInterval(draw, 40);
        const stream = canvas.captureStream(25);
        const audio = new AudioContext();
        const oscillator = audio.createOscillator(); oscillator.frequency.value = 440;
        const gain = audio.createGain(); gain.gain.value = 0.15;
        const destination = audio.createMediaStreamDestination();
        oscillator.connect(gain).connect(destination); oscillator.start(); await audio.resume();
        peer.addTransceiver(destination.stream.getAudioTracks()[0], {direction: 'sendonly'});
        const video = peer.addTransceiver(stream.getVideoTracks()[0], {direction: 'sendonly'});
        video.setCodecPreferences(RTCRtpSender.getCapabilities('video').codecs.filter(c =>
            c.mimeType === 'video/H264' && /profile-level-id=42e0/.test(c.sdpFmtpLine) && /packetization-mode=1/.test(c.sdpFmtpLine)));
        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const response = await fetch(endpoint, {method: 'POST', headers: {'Content-Type': 'application/sdp', Authorization: `Bearer ${token}`}, body: offer.sdp});
        const answer = await response.text();
        if (response.status !== 201) throw new Error(`${response.status}: ${answer}`);
        await peer.setRemoteDescription({type: 'answer', sdp: answer});
        window.obsTest = {peer, stream, audio, oscillator, timer};
        return {location: response.headers.get('location')};
    }, {endpoint, token});
    const session = await until(() => [...h.instance.desktop.sessions.values()].find(s => s.ready));
    const checkMedia = async page => {
        const video = page.locator('.desktop-tile video');
        await until(() => video.evaluateAll(videos => videos.length === 1 && videos[0].videoWidth === 640 &&
            videos[0].readyState >= 2 && !videos[0].paused), 20000);
        const media = await video.evaluate(async video => {
            const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
            const context = canvas.getContext('2d'); context.drawImage(video, 0, 0, 1, 1);
            const audio = new AudioContext(); await audio.resume();
            const analyser = audio.createAnalyser();
            audio.createMediaStreamSource(video.srcObject).connect(analyser);
            const samples = new Float32Array(analyser.fftSize);
            let peak = 0;
            for (let i = 0; i < 20 && peak < 0.05; i++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                analyser.getFloatTimeDomainData(samples);
                peak = Math.max(...samples.map(Math.abs));
            }
            await audio.close();
            return {pixel: [...context.getImageData(0, 0, 1, 1).data], peak};
        });
        assert.ok(media.pixel[0] > 150 && media.pixel[1] < 80, JSON.stringify(media));
        assert.ok(media.peak > 0.05, 'Opus audio must decode into non-silent samples');
    };
    await checkMedia(first);
    const ownVideo = first.locator('.desktop-tile video');
    assert.equal(await ownVideo.evaluate(video => video.muted), true, 'An OBS publisher starts muted in their browser');
    await first.getByRole('button', {name: 'Mute on this device', exact: true}).click();
    await first.getByRole('button', {name: 'Unmute on this device', exact: true}).click();
    assert.equal(await ownVideo.evaluate(video => video.muted), true, 'Master unmute preserves the own-stream mute');
    await ownVideo.evaluate(video => { video.muted = false; });
    await until(() => ownVideo.evaluate(video => !video.muted));
    h.instance.rooms.changed(h.instance.rooms.get('lobby'));
    await first.getByRole('button', {name: 'Mute on this device', exact: true}).click();
    await until(() => ownVideo.evaluate(video => video.muted));
    await first.getByRole('button', {name: 'Unmute on this device', exact: true}).click();
    await until(() => ownVideo.evaluate(video => !video.muted));
    const late = await viewer();
    await checkMedia(late);
    assert.equal(await late.locator('.desktop-tile video').evaluate(video => video.muted), true,
        'Another browser session for the publisher also starts muted');
    const created = await h.api('/api/users', {method: 'POST', body: {username: 'obs_viewer',
        displayName: h.instance.accounts.users.find(user => user.username === 'admin').displayName, password: 'garbageTime_'}});
    assert.equal(created.status, 201);
    const other = await viewer('obs_viewer');
    await checkMedia(other);
    assert.equal(await other.locator('.desktop-tile video').evaluate(video => video.muted), false,
        'Other accounts hear the stream, even with the same display name');
    assert.equal(session.viewers.size, 3);
    await first.close();
    await checkMedia(late);
    assert.equal(h.instance.desktop.sessions.size, 1, 'Closing the token-issuing page does not stop OBS');
    const stopped = await fetch(h.url + result.location, {method: 'DELETE', headers: {Authorization: `Bearer ${token}`}});
    assert.equal(stopped.status, 200);
    await until(() => late.locator('.desktop-tile video').count().then(count => count === 0));
    assert.equal(h.instance.desktop.sessions.size, 0);
    assert.equal(session.router.closed, true);
    assert.deepEqual(errors, []);
});
