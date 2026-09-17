import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:net';
import {randomBytes} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {chromium, firefox} from 'playwright';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';

const firefoxReceiver = process.env.DESKTOP_TEST_FIREFOX === 'true';
const tcpOnly = process.env.DESKTOP_TEST_TCP === 'true';

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
test(`desktop capture delivers ${withAudio ? 'video and audible audio' : 'video only'} to a late viewer (${split ? 'Worker + metal' : 'local'}${firefoxReceiver && split && !withAudio ? ', Firefox receiver' : ''})`, {timeout: 90000}, async t => {
    const codecScenario = split ? (withAudio ? 'retry' : 'unavailable') : (withAudio ? 'vp8' : 'h264');
    const backend = await start(t, {ffmpeg: 'missing-ffmpeg-desktop-test', desktopIceServers: '[]',
        ...(process.env.DESKTOP_TEST_LISTEN_IP ? {desktopListenIp: process.env.DESKTOP_TEST_LISTEN_IP} : {})});
    const {instance} = backend;
    if (tcpOnly) {
        const connection = instance.desktop.connection.bind(instance.desktop);
        t.mock.method(instance.desktop, 'connection', (...args) => {
            const value = connection(...args);
            value.transportOptions.iceCandidates = value.transportOptions.iceCandidates.filter(candidate => candidate.protocol === 'tcp');
            return value;
        });
    }
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
    assert.equal(instance.capabilities.ffmpeg, false, 'Desktop sharing must work without FFmpeg');
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required',
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows']});
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
    await sender.addInitScript(({withAudio, codecScenario}) => {
        window.captureAudio = withAudio;
        window.captureTracks = [];
        window.desktopPeers = [];
        window.codecFailures = 0;
        Object.defineProperty(navigator, 'mediaCapabilities', {value: {async encodingInfo({video}) {
            if (codecScenario === 'unavailable') throw new TypeError('WebRTC capability detection unavailable');
            return {supported: true, smooth: true,
                powerEfficient: codecScenario === 'vp8' ? video.contentType === 'video/VP8' :
                    codecScenario === 'retry' ? video.contentType.startsWith('video/H264') :
                        video.contentType.includes('profile-level-id=42001f')};
        }}});
        const Peer = window.RTCPeerConnection;
        window.RTCPeerConnection = class extends Peer {
            constructor(config) { super(config); window.desktopPeers.push(this); }
            async getStats(...args) {
                const report = await super.getStats(...args);
                if (codecScenario !== 'unavailable') return report;
                return new Map([...report].map(([id, entry]) => {
                    const value = {...entry};
                    delete value.totalEncodeTime;
                    delete value.encoderImplementation;
                    delete value.powerEfficientEncoder;
                    delete value.qualityLimitationReason;
                    return [id, value];
                }));
            }
            async setRemoteDescription(description) {
                if (codecScenario === 'retry' && description.type === 'answer' && /a=rtpmap:\d+ H264\/90000/i.test(description.sdp)) {
                    window.codecFailures++;
                    throw new DOMException('Simulated H264 negotiation failure', 'OperationError');
                }
                return super.setRemoteDescription(description);
            }
        };
        // Substitute only the OS picker. Exercise real WebRTC capture encoding,
        // authenticated signaling (including Worker proxy), and browser decoding.
        navigator.mediaDevices.getDisplayMedia = async options => {
            window.captureOptions = options;
            const canvas = document.createElement('canvas');
            canvas.width = 640; canvas.height = 360;
            const context = canvas.getContext('2d');
            let frame = 0;
            function draw() {
                context.fillStyle = '#ff0000'; context.fillRect(0, 0, 640, 360);
                context.fillStyle = '#ffffff'; context.fillRect(frame++ % 500, 250, 40, 40);
                const timestamp = Date.now() % 2 ** 24;
                for (let bit = 0; bit < 24; bit++) {
                    context.fillStyle = timestamp & (1 << bit) ? '#ffffff' : '#000000';
                    context.fillRect(bit * 20, 0, 20, 20);
                }
                window.captureAnimation = requestAnimationFrame(draw);
            }
            draw();
            const stream = canvas.captureStream(options.video.frameRate.ideal);
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
    }, {withAudio, codecScenario});
    await join(sender, url);
    await sender.getByRole('button', {name: 'Share desktop', exact: true}).click();
    await sender.getByRole('button', {name: 'Choose screen to share'}).click();
    await sender.getByRole('button', {name: 'Stop sharing', exact: true}).waitFor();
    await until(() => instance.rooms.get('lobby').current?.transport === 'mediasoup' && [...instance.desktop.sessions.values()][0]?.ready);
    const item = instance.rooms.get('lobby').current;
    const publisher = [...instance.desktop.sessions.values()][0];
    const expectedCodec = ['retry', 'vp8'].includes(codecScenario) ? 'video/VP8' : 'video/H264';
    assert.equal(publisher.producers.get('video').rtpParameters.codecs[0].mimeType, expectedCodec);
    if (expectedCodec === 'video/H264') assert.equal(publisher.producers.get('video').rtpParameters.codecs[0].parameters['profile-level-id'], '42001f');
    assert.equal(await sender.evaluate(() => window.codecFailures), codecScenario === 'retry' ? 2 : 0);
    assert.equal(publisher.publisher.videoRetries || 0, codecScenario === 'retry' ? 2 : 0);
    assert.equal(instance.media.jobs.size, 0);
    assert.equal(item.media, null);
    assert.equal(item.kind, 'desktop');
    assert.equal(await sender.locator('video').evaluate(video => video.muted), true);
    assert.match(await sender.locator('.desktop-sharing-status').textContent(), withAudio ? /Audio included/ : /Video only/);
    const receiver = firefoxReceiver && split && !withAudio ? await firefox.launch({headless: true}) : browser;
    if (receiver !== browser) t.after(() => receiver.close());
    const viewer = await receiver.newPage();
    await viewer.addInitScript(() => {
        window.desktopVideoReports = [];
        const getStats = RTCPeerConnection.prototype.getStats;
        RTCPeerConnection.prototype.getStats = async function (...args) {
            const report = await getStats.apply(this, args);
            window.desktopVideoReports.push([...report.values()].filter(entry => entry.type === 'inbound-rtp' && entry.kind === 'video')
                .map(({id, ssrc, trackIdentifier, bytesReceived, framesDecoded, framesPerSecond}) =>
                    ({id, ssrc, trackIdentifier, bytesReceived, framesDecoded, framesPerSecond})));
            window.desktopVideoReports = window.desktopVideoReports.slice(-3);
            if (window.desktopStatsMode) return new Map([...report].map(([id, entry]) => {
                if (entry.type !== 'inbound-rtp' || entry.kind !== 'video') return [id, entry];
                const value = {...entry};
                if (window.desktopStatsMode === 'wide') {
                    value.bytesReceived += Math.floor(value.timestamp * 1250);
                    value.framesPerSecond = 120;
                    value.frameWidth = 3840; value.frameHeight = 2160;
                    value.jitter = 9.999;
                    value.framesDropped += 9999;
                } else if (window.desktopStatsMode === 'missing') {
                    for (const key of ['bytesReceived', 'framesPerSecond', 'framesDecoded', 'frameWidth', 'frameHeight',
                        'jitter', 'framesDropped', 'packetsReceived', 'packetsLost']) delete value[key];
                }
                return [id, value];
            }));
            return report;
        };
    });
    watch(viewer);
    viewer.on('pageerror', error => errors.push(error.message));
    await join(viewer, url);
    await until(() => viewer.locator('video').evaluate(video => video.readyState >= 2 && video.videoWidth > 0 && !video.paused && video.currentTime > 0), 20000)
        .catch(async error => {
            t.diagnostic(await viewer.locator('.video-viewport').innerText());
            t.diagnostic(JSON.stringify(errors));
            for (const session of instance.desktop.sessions.values()) for (const peer of session.viewers.values()) {
                t.diagnostic(JSON.stringify({ice: peer.transport.iceState, dtls: peer.transport.dtlsState,
                    stats: await peer.transport.getStats(), consumers: await Promise.all([...peer.consumers.values()].map(c => c.getStats()))}));
            }
            throw error;
        });
    assert.equal(await viewer.locator('video').evaluate(video => video.srcObject instanceof MediaStream && !video.getAttribute('src')), true);
    assert.deepEqual(await sender.evaluate(() => {
        const {maxBitrate, maxFramerate} = window.desktopPeers.find(peer => peer.connectionState !== 'closed').getSenders()
            .find(sender => sender.track?.kind === 'video').getParameters().encodings[0];
        return {maxBitrate, maxFramerate, captureFrameRate: window.captureOptions.video.frameRate};
    }), {maxBitrate: 6_000_000, maxFramerate: 60, captureFrameRate: {ideal: 60, max: 60}});
    const encoding = await sender.evaluate(async () => {
        const peer = window.desktopPeers.find(peer => peer.connectionState !== 'closed');
        const stats = await peer.getSenders().find(sender => sender.track?.kind === 'video').getStats();
        const outbound = [...stats.values()].find(stat => stat.type === 'outbound-rtp' && stat.kind === 'video');
        return {encoder: outbound?.encoderImplementation, powerEfficient: outbound?.powerEfficientEncoder,
            framesEncoded: outbound?.framesEncoded, totalEncodeTime: outbound?.totalEncodeTime};
    });
    assert.ok(encoding.framesEncoded > 0);
    const senderStats = sender.getByLabel('Desktop stream statistics');
    const viewerStats = viewer.getByLabel('Desktop stream statistics');
    await until(async () => /(?:kbps|Mbps) sent/.test(await senderStats.innerText()));
    await until(async () => /(?:kbps|Mbps) received/.test(await viewerStats.innerText()));
    await until(async () => {
        const text = await viewerStats.innerText();
        return Number(text.match(/([\d.]+) (?:kbps|Mbps) received/)?.[1]) > 0 &&
            Number(text.match(/([\d.]+) fps/)?.[1]) > 0;
    }).catch(async error => {
        t.diagnostic(await viewerStats.innerText());
        t.diagnostic(JSON.stringify(await viewer.evaluate(() => window.desktopVideoReports)));
        throw error;
    });
    const senderStatus = await senderStats.innerText();
    assert.match(senderStatus, /Encoder active/);
    assert.match(senderStatus, /640×360/);
    assert.match(senderStatus, /fps/);
    assert.match(senderStatus, new RegExp(expectedCodec.replace('video/', ''), 'i'));
    if (codecScenario === 'unavailable') assert.doesNotMatch(senderStatus, /Encoder load|ms\/frame|power efficient|quality limit/i);
    else {
        if (Number.isFinite(encoding.totalEncodeTime)) assert.match(senderStatus, /Encoder load ≈\d+%/);
        if (encoding.encoder) assert.ok(senderStatus.includes(encoding.encoder));
    }
    assert.match(await viewerStats.innerText(), /Receiving desktop/);
    assert.doesNotMatch(await viewerStats.innerText(), /Encoder load/);
    assert.match(await viewerStats.innerText(), /640×360/);
    if (!split && !withAudio) {
        await viewerStats.locator('[data-metric="packetLoss"]').waitFor();
        const bounds = () => viewerStats.evaluate(row => [...row.children].map(slot => {
            const {x, y, width, height} = slot.getBoundingClientRect();
            return {metric: slot.dataset.metric, x, y, width, height};
        }));
        const initial = await bounds();
        await viewer.evaluate(() => window.desktopStatsMode = 'wide');
        await until(async () => (await viewerStats.locator('[data-metric="fps"]').innerText()) === '120.0 fps');
        assert.deepEqual(await bounds(), initial, 'Wider values cannot resize slots or move neighboring labels');
        await viewer.evaluate(() => window.desktopStatsMode = 'missing');
        await until(async () => (await viewerStats.locator('[data-metric="fps"]').innerText()) === '—');
        assert.equal(await viewerStats.locator('[data-metric="bitrate"]').innerText(), '—');
        assert.deepEqual(await bounds(), initial, 'Temporarily missing values retain their slots');
        await viewer.evaluate(() => window.desktopStatsMode = null);
        await until(async () => Number((await viewerStats.locator('[data-metric="bitrate"]').innerText()).match(/[\d.]+/)?.[0]) > 0);
    }
    assert.equal(await sender.getByLabel('Playback buffer health').count(), 0);
    assert.equal(await viewer.getByLabel('Playback buffer health').count(), 0);
    t.diagnostic(`Codec scenario ${codecScenario}: ${expectedCodec}, ${JSON.stringify(encoding)}`);
    if (tcpOnly) assert.equal([...instance.desktop.sessions.values()][0].publisher.transport.iceSelectedTuple.protocol, 'tcp');
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
        const source = audio.createMediaStreamSource(video.srcObject);
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
    const latency = await viewer.locator('video').evaluate(async video => {
        const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
        const context = canvas.getContext('2d', {willReadFrequently: true});
        const samples = [];
        for (let i = 0; i < 25; i++) {
            await new Promise(resolve => setTimeout(resolve, 80));
            context.drawImage(video, 0, 0, 640, 360);
            let timestamp = 0;
            for (let bit = 0; bit < 24; bit++) {
                if (context.getImageData(bit * 20 + 10, 10, 1, 1).data[0] > 128) timestamp += 2 ** bit;
            }
            samples.push((Date.now() - timestamp + 2 ** 24) % 2 ** 24);
        }
        return samples.sort((a, b) => a - b);
    });
    t.diagnostic(`Metal WebRTC capture-to-decoded-frame latency: median ${latency[12]}ms, p95 ${latency[23]}ms`);
    assert.ok(latency[23] < 1000, `Local desktop latency must remain subsecond: ${latency}`);
    assert.deepEqual(responses, [], 'Desktop must not request any HLS media');
    await viewer.locator('.video-viewport').hover();
    assert.equal(await viewer.getByRole('slider', {name: 'Seek shared video'}).isDisabled(), true);
    assert.equal(await viewer.getByRole('button', {name: 'Pause for everyone'}).isDisabled(), true);
    if (!split && !withAudio) {
        await sender.screenshot({path: 'test-artifacts/desktop-encoder-stats.png', fullPage: true});
        await sender.setViewportSize({width: 390, height: 844});
        await sender.screenshot({path: 'test-artifacts/desktop-encoder-stats-mobile.png', fullPage: true});
        assert.equal(await senderStats.evaluate(row => [...row.children].every(child => {
            const bounds = child.getBoundingClientRect();
            return bounds.left >= 0 && bounds.right <= window.innerWidth;
        })), true, 'Statistics wrap within the mobile viewport');
    }
    if (!split && withAudio) {
        const extra = await browser.newPage();
        watch(extra);
        extra.on('pageerror', error => errors.push(error.message));
        await join(extra, url);
        await until(() => extra.locator('video').evaluate(video => video.srcObject?.getVideoTracks().length && video.readyState >= 2 && !video.paused));
        const session = [...instance.desktop.sessions.values()][0];
        assert.equal(session.viewers.size, 2);
        const publisherId = session.publisher.transport.id;
        assert.equal(await sender.evaluate(() => window.desktopPeers.filter(peer => peer.connectionState !== 'closed').length), 1,
            'Additional viewers must not create additional publisher WebRTC connections');
        assert.equal(session.producers.size, 2, 'One video and one audio producer feed every viewer');
        assert.ok([...session.viewers.values()].every(peer => peer.consumers.size === 2));
        const relayStats = await session.publisher.transport.getStats();
        assert.ok(relayStats[0].rtpBytesReceived > 0, 'Metal receives the encoded desktop');
        for (const peer of session.viewers.values()) {
            const stats = await peer.transport.getStats();
            assert.ok(stats[0].rtpBytesSent > 0, 'Metal forwards encoded media independently to each viewer');
        }
        const previousPeers = [...session.viewers.keys()];
        await viewer.reload();
        await until(() => viewer.locator('video').evaluate(video => video.srcObject && video.readyState >= 2 && !video.paused));
        assert.equal(session.viewers.size, 2);
        assert.equal([...session.viewers.keys()].filter(id => !previousPeers.includes(id)).length, 1);
        assert.equal(session.publisher.transport.id, publisherId);
        assert.equal(await sender.evaluate(() => window.desktopPeers.filter(peer => peer.connectionState !== 'closed').length), 1);
        await extra.close();
        await until(() => session.viewers.size === 1);
        // Simulate the browser's stop-capture notification, not the app button.
        await sender.evaluate(() => {
            const video = window.captureTracks.find(track => track.kind === 'video');
            video.stop(); video.dispatchEvent(new Event('ended'));
        });
    } else await sender.getByRole('button', {name: 'Stop sharing', exact: true}).click();
    await until(() => instance.rooms.get('lobby').current === null && instance.desktop.sessions.size === 0);
    assert.equal(await sender.evaluate(() => window.captureTracks.every(track => track.readyState === 'ended')), true);
    assert.equal(instance.rooms.get('lobby').history.length, 0);
    assert.equal(instance.media.jobs.has(item.id), false);
    const relayDump = await instance.desktop.relay.webRtcServer.dump();
    assert.deepEqual(relayDump.webRtcTransportIds, [], 'Stopping releases all metal transports');
    await until(() => viewer.locator('video').evaluate(video => video.srcObject === null));
    assert.equal(await sender.getByLabel('Desktop stream statistics').count(), 0);
    assert.equal(await viewer.getByLabel('Desktop stream statistics').count(), 0);
    assert.deepEqual(responses, [], 'Multiple viewers and reconnects must also bypass HLS');
    assert.deepEqual(errors, []);
});
}
}

test('desktop WebRTC interrupts HLS and returns both viewers to the saved video position', {timeout: 60000}, async t => {
    const {instance, url, dir} = await start(t);
    const sample = path.join(dir, 'desktop-resume.mp4');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i',
        'color=c=blue:s=640x360:r=10', '-t', '45', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '20',
        '-pix_fmt', 'yuv420p', '-movflags', '+faststart', sample]);
    instance.app.get('/desktop-resume.mp4', (_req, res) => res.sendFile(sample, {dotfiles: 'allow'}));
    t.mock.method(instance.youtube, 'resolve', async () => ({duration: 45, inputs: [{url: `${url}/desktop-resume.mp4`, headers: {}}]}));
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const sender = await browser.newPage(), viewer = await browser.newPage();
    const errors = [];
    for (const page of [sender, viewer]) page.on('pageerror', error => errors.push(error.message));
    await sender.addInitScript(() => {
        navigator.mediaDevices.getDisplayMedia = async () => {
            const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 360;
            const context = canvas.getContext('2d');
            context.fillStyle = 'red'; context.fillRect(0, 0, 640, 360);
            const stream = canvas.captureStream(10);
            const timer = setInterval(() => context.fillRect(0, 0, 640, 360), 100);
            window.addEventListener('pagehide', () => clearInterval(timer), {once: true});
            return stream;
        };
    });
    await join(sender, url); await join(viewer, url);
    const room = instance.rooms.get('lobby');
    const item = makeItem({kind: 'youtube', url: 'https://www.youtube.com/watch?v=abcdefghijk'}, {title: 'Resume fixture', duration: 45});
    instance.rooms.add(room, [item]);
    await until(() => item.media?.bufferedUntil >= 20);
    instance.rooms.stamp(room, 12, false); instance.rooms.changed(room);
    for (const page of [sender, viewer]) await until(() => page.locator('video').evaluate(video => video.currentTime >= 12 && !video.paused));
    await sender.getByRole('button', {name: 'Share desktop', exact: true}).click();
    await sender.getByRole('button', {name: 'Choose screen to share'}).click();
    await until(() => room.current?.kind === 'desktop');
    const resumeAt = room.queue[0].resumeAt;
    assert.ok(resumeAt >= 12);
    await until(() => viewer.locator('video').evaluate(video => video.srcObject && video.readyState >= 2 && !video.paused));
    await sender.getByRole('button', {name: 'Stop sharing', exact: true}).click();
    await until(() => room.current?.id === item.id);
    for (const page of [sender, viewer]) {
        await until(() => page.locator('video').evaluate((video, resume) => video.srcObject === null &&
            video.readyState >= 2 && !video.paused && video.currentTime >= resume - 0.75, resumeAt));
        assert.equal(await page.getByRole('button', {name: 'Pause for everyone'}).isDisabled(), false);
    }
    assert.equal(room.history.some(item => item.kind === 'desktop'), false);
    assert.deepEqual(errors, []);
});
