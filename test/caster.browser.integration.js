import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {createRequire} from 'node:module';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {_electron, chromium} from 'playwright';
import {start, until} from './helpers.js';

const require = createRequire(import.meta.url);
const executablePath = process.env.CASTER_TEST_EXECUTABLE || require('../apps/caster/node_modules/electron');
const native = process.platform === 'win32' && process.env.CASTER_TEST_BACKEND !== 'chromium';

test('native caster captures a real window, crops it, publishes mixed audio and stops on room skip', {timeout: 120000}, async t => {
    const {instance, url} = await start(t, {ffmpeg: 'missing-caster-test', desktopIceServers: '[]'});
    const profile = path.resolve('test-artifacts', `caster-profile-${randomUUID()}`);
    const application = await _electron.launch({executablePath, args: [...(process.env.CASTER_TEST_EXECUTABLE ? [] : [path.resolve('apps/caster')]), `--user-data-dir=${profile}`],
        env: {...process.env, ELECTRON_ENABLE_LOGGING: '1'}});
    t.after(async () => {
        const timeout = setTimeout(() => application.process().kill(), 5000);
        try { await application.close(); } catch {} finally { clearTimeout(timeout); }
        await rm(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
    });
    const page = await application.firstWindow();
    t.after(async () => { if (!page.isClosed()) await page.screenshot({path: 'test-artifacts/caster-last.png', fullPage: true}).catch(() => {}); });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') console.log('CASTER:', message.text()); });
    await page.getByLabel('Frontend URL').fill(url);
    await page.getByLabel('Username', {exact: true}).fill('admin');
    await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await page.getByRole('button', {name: 'Connect to Helltube'}).click();
    await page.getByLabel('Broadcast to room').selectOption('lobby');
    await page.getByText('Room ready.', {exact: false}).waitFor();
    assert.equal(await page.evaluate(() => typeof window.require), 'undefined');
    assert.equal(await page.evaluate(() => typeof window.caster.cookie), 'undefined');
    if (process.platform === 'win32') await page.getByLabel('Capture engine').selectOption(native ? 'native' : 'chromium');
    await page.evaluate(() => {
        const getDisplayMedia = navigator.mediaDevices.getDisplayMedia.bind(navigator.mediaDevices);
        window.captureRequests = [];
        navigator.mediaDevices.getDisplayMedia = async options => {
            window.captureRequests.push(options);
            window.lastNativeCapture = await getDisplayMedia(options);
            return window.lastNativeCapture;
        };
        const captureStream = HTMLCanvasElement.prototype.captureStream;
        window.canvasCaptures = 0;
        window.nativeFrameCount = 0;
        window.VideoFrame = new Proxy(window.VideoFrame, {construct(target, args) {
            window.nativeFrameCount++;
            return Reflect.construct(target, args);
        }});
        HTMLCanvasElement.prototype.captureStream = function (...args) {
            window.canvasCaptures++;
            return captureStream.apply(this, args);
        };
    });

    // This is an actual captured native window, not a getDisplayMedia mock.
    await application.evaluate(async ({BrowserWindow}) => {
        const pattern = new BrowserWindow({title: 'Caster capture test pattern', width: 640, height: 400,
            webPreferences: {nodeIntegration: false, contextIsolation: true}});
        await pattern.loadURL('data:text/html,<title>Caster capture test pattern</title><style>body{margin:0;background:%232f9857;color:white;font:40px sans-serif}div{padding:50px}</style><div>Helltube capture test</div>');
    });
    await page.getByRole('button', {name: 'Application', exact: true}).click();
    await page.getByRole('button', {name: /Caster capture test pattern/}).click();
    await page.getByRole('button', {name: 'Start preview', exact: false}).click();
    await page.getByLabel('Outgoing broadcast preview').waitFor();
    await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 0));
    const initialPreview = await page.getByLabel('Outgoing broadcast preview').evaluate(video => ({width: video.videoWidth, height: video.videoHeight}));
    assert.ok(initialPreview.width > 0);
    assert.ok(initialPreview.width <= 640 && initialPreview.height <= 400, 'Small windows are not enlarged');
    assert.equal(await page.evaluate(() => window.canvasCaptures), 0, 'Uncropped capture does not allocate a canvas stream');
    if (native) {
        assert.equal(await page.evaluate(() => window.captureRequests.length), 0, 'Native capture bypasses getDisplayMedia');
        await page.getByText('Native WGC', {exact: false}).waitFor();
        await page.getByLabel('Outgoing broadcast preview').evaluate(video => { window.lastNativeCapture = video.srcObject; });
    } else {
        assert.equal(await page.getByLabel('Outgoing broadcast preview').evaluate(video =>
            video.srcObject.getVideoTracks()[0] === window.lastNativeCapture.getVideoTracks()[0]), true, 'Compatibility preview uses the Chromium track');
    }
    await application.evaluate(({BrowserWindow}) => {
        BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Caster capture test pattern').setSize(1600, 1000);
    });
    await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 640));
    const resized = await page.getByLabel('Outgoing broadcast preview').evaluate(video => video.srcObject.getVideoTracks()[0].getSettings());
    assert.ok(resized.width <= 1280 && resized.height <= 720 && (!resized.frameRate || resized.frameRate <= 30),
        'Frames stay bounded when the source grows: ' + JSON.stringify(resized));
    await page.getByRole('button', {name: 'Go live', exact: false}).click();
    await until(() => instance.desktop.sessions.size === 1);
    await page.getByRole('button', {name: 'You’re live', exact: false}).waitFor();

    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--autoplay-policy=no-user-gesture-required']});
    t.after(() => browser.close());
    const viewer = await browser.newPage();
    await viewer.goto(url);
    await viewer.getByLabel('Username', {exact: true}).fill('admin');
    await viewer.getByLabel('Password', {exact: true}).fill('garbageTime_');
    await viewer.getByRole('button', {name: 'Enter Helltube'}).click();
    await viewer.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^The living room(?: |$)/}).click();
    await until(() => viewer.locator('.desktop-tile video').evaluateAll(videos => videos.some(video => video.videoWidth > 0 && video.readyState >= 2)), 20000);
    const color = await viewer.locator('.desktop-tile video').first().evaluate(video => {
        const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
        const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
        return [...context.getImageData(canvas.width - 40, canvas.height - 40, 1, 1).data];
    });
    assert.ok(color[1] > color[0] * 1.4 && color[1] > color[2] * 1.4, `Remote frame contains the captured green window: ${color}`);
    await page.getByLabel('Outgoing broadcast preview').evaluate(video => { window.hiddenPreviewElement = video; });
    await page.getByRole('button', {name: 'Hide preview', exact: true}).click();
    assert.equal(await page.getByLabel('Outgoing broadcast preview').count(), 0);
    assert.equal(await page.evaluate(() => window.hiddenPreviewElement.paused && window.hiddenPreviewElement.srcObject === null), true,
        'Hidden preview stops consuming frames immediately, without waiting for garbage collection');
    assert.equal(instance.desktop.sessions.size, 1, 'Hiding preview leaves the broadcast active');
    assert.equal(await page.evaluate(() => window.lastNativeCapture.getVideoTracks()[0].readyState), 'live');
    assert.equal(await page.evaluate(() => window.captureRequests.length), native ? 0 : 1, 'Hiding preview does not restart capture');
    if (native) {
        const frames = await page.evaluate(() => window.nativeFrameCount);
        await application.evaluate(async ({BrowserWindow}) => {
            const pattern = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Caster capture test pattern');
            await pattern.webContents.executeJavaScript("document.body.style.background = '#3344dd'");
        });
        await until(() => page.evaluate(previous => window.nativeFrameCount > previous, frames));
        await until(() => viewer.locator('.desktop-tile video').first().evaluate(video => {
            const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
            const context = canvas.getContext('2d'); context.drawImage(video, 0, 0);
            const [r, g, b] = context.getImageData(canvas.width - 40, canvas.height - 40, 1, 1).data;
            return b > g * 2 && b > r * 2;
        }));
    }
    await page.getByRole('button', {name: 'Show preview', exact: true}).click();
    await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 0));
    if (native) {
        await application.evaluate(async ({BrowserWindow}) => {
            const pattern = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Caster capture test pattern');
            await pattern.webContents.executeJavaScript("window.motionTest = setInterval(() => { document.querySelector('div').style.transform = 'translateX(' + (Date.now() % 180) + 'px)'; }, 16)");
        });
        const before = await page.evaluate(() => ({frames: window.nativeFrameCount, time: performance.now()}));
        await page.waitForTimeout(2000);
        const rate = await page.evaluate(before => (window.nativeFrameCount - before.frames) * 1000 / (performance.now() - before.time), before);
        t.diagnostic('Native animated-window delivery: ' + rate.toFixed(1) + ' fps at the 30 fps preset');
        assert.ok(rate >= 10 && rate <= 33, 'Native motion delivers sustained bounded frames without a growing queue');
        await application.evaluate(async ({BrowserWindow}) => {
            const pattern = BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Caster capture test pattern');
            await pattern.webContents.executeJavaScript('clearInterval(window.motionTest)');
        });
    }
    await page.screenshot({path: 'test-artifacts/caster-live.png', fullPage: true});
    await viewer.getByRole('button', {name: 'Skip video for everyone'}).click();
    await until(() => instance.desktop.sessions.size === 0);
    await page.getByRole('button', {name: 'Start preview', exact: false}).waitFor();
    assert.equal(await page.getByLabel('Outgoing broadcast preview').count(), 0);

    // Crop a monitor using the native screen source and verify bounded output.
    await page.getByRole('button', {name: 'Region', exact: true}).click();
    const monitor = native ? (await page.evaluate(() => window.caster.sources('screen', 'native'))).sources[0] : null;
    await page.getByLabel('Width %', {exact: true}).fill('25');
    await page.getByLabel('Height %', {exact: true}).fill('25');
    await page.getByRole('button', {name: 'Start preview', exact: false}).click();
    await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 0));
    const cropped = await page.getByLabel('Outgoing broadcast preview').evaluate(video => ({width: video.videoWidth, height: video.videoHeight}));
    assert.ok(cropped.width <= 1280 && cropped.height <= 720);
    if (native) assert.deepEqual(cropped, {width: Math.max(2, Math.floor(monitor.width * .25) & ~1),
        height: Math.max(2, Math.floor(monitor.height * .25) & ~1)}, 'Native GPU cropping retains only the selected quarter of the monitor');
    assert.equal(await page.evaluate(() => window.canvasCaptures), native ? 0 : 1, 'Native regions do not create a canvas stream');
    if (native) await page.getByText('Native DXGI', {exact: false}).waitFor();
    await page.getByLabel('Outgoing broadcast preview').evaluate(video => { window.regionOutput = video.srcObject; });
    await page.getByRole('button', {name: 'Hide preview', exact: true}).click();
    await page.getByRole('button', {name: 'Show preview', exact: true}).click();
    await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 0));
    await page.getByRole('button', {name: 'Stop preview'}).click();
    assert.equal(await page.evaluate(() => [window.lastNativeCapture, window.regionOutput].every(stream =>
        stream.getTracks().every(track => track.readyState === 'ended'))), true, 'Stopping a region releases both native capture and canvas tracks');
    if (native) {
        await page.getByRole('button', {name: 'Application', exact: true}).click();
        await page.getByRole('button', {name: /Caster capture test pattern/}).click();
        await page.getByRole('button', {name: 'Start preview', exact: false}).click();
        await until(() => page.getByLabel('Outgoing broadcast preview').evaluate(video => video.videoWidth > 0));
        await application.evaluate(({BrowserWindow}) => {
            BrowserWindow.getAllWindows().find(window => window.getTitle() === 'Caster capture test pattern').close();
        });
        await page.getByRole('button', {name: 'Start preview', exact: false}).waitFor();
        await page.getByText('The selected capture source closed', {exact: false}).waitFor();
        assert.equal(await page.getByLabel('Outgoing broadcast preview').count(), 0, 'Closing a WGC source releases the generated track');
        await page.getByRole('button', {name: 'Monitor', exact: true}).click();
    }

    // A separate browser owns an actual Windows audio session. Select only that
    // process, then inspect the mixed Opus track at the receiving browser.
    if (process.platform === 'win32') {
        const audioBrowser = await chromium.launch({channel: 'chrome', headless: false,
            args: ['--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--mute-audio']});
        t.after(() => audioBrowser.close());
        const tonePage = await audioBrowser.newPage();
        await tonePage.setContent('<title>Caster audio test</title><p>Helltube audio capture test</p>');
        await tonePage.evaluate(async () => {
            window.audio = new AudioContext({sampleRate: 48000});
            window.tone = audio.createOscillator(); window.volume = audio.createGain();
            tone.frequency.value = 523.25; volume.gain.value = .05;
            tone.connect(volume); volume.connect(audio.destination); tone.start(); await audio.resume();
        });
        const excludedBrowser = await chromium.launch({channel: 'chrome', headless: false,
            args: ['--autoplay-policy=no-user-gesture-required'], ignoreDefaultArgs: ['--mute-audio']});
        t.after(() => excludedBrowser.close());
        const excludedPage = await excludedBrowser.newPage();
        await excludedPage.setContent('<title>Excluded audio test</title>Unselected audio application');
        await excludedPage.evaluate(async () => {
            const context = new AudioContext();
            const tone = context.createOscillator(), gain = context.createGain();
            tone.frequency.value = 880; gain.gain.value = .05;
            tone.connect(gain); gain.connect(context.destination); tone.start(); await context.resume();
        });
        const cdp = await audioBrowser.newBrowserCDPSession();
        const processes = await cdp.send('SystemInfo.getProcessInfo');
        const pids = new Set(processes.processInfo.map(process => process.id));
        const audioSource = await until(async () => {
            const result = await page.evaluate(() => window.caster.audioSources());
            return result.sources.find(source => source.kind === 'application' && pids.has(source.pid));
        });
        await page.getByRole('button', {name: 'Refresh', exact: false}).filter({hasText: 'Refresh'}).last().click();
        await page.locator('.audio-option').filter({hasText: `PID ${audioSource.pid}`}).getByRole('checkbox').check();
        await page.getByRole('button', {name: 'Start preview', exact: false}).click();
        await page.getByLabel('Outgoing broadcast preview').waitFor();
        await until(() => page.getByLabel('Master output level').evaluate(meter => meter.value > -50));
        await page.getByRole('button', {name: 'Go live', exact: false}).click();
        await page.getByRole('button', {name: 'You’re live', exact: false}).waitFor();
        await until(() => viewer.locator('.desktop-tile video').evaluateAll(videos => videos.some(video => video.srcObject?.getAudioTracks().length)), 20000);
        const remotePeak = () => viewer.locator('.desktop-tile video').first().evaluate(async video => {
            const context = new AudioContext(); await context.resume();
            const analyser = context.createAnalyser(); analyser.fftSize = 2048;
            context.createMediaStreamSource(video.srcObject).connect(analyser);
            const samples = new Float32Array(analyser.fftSize);
            let peak = 0;
            for (let index = 0; index < 8; index++) {
                await new Promise(resolve => setTimeout(resolve, 100));
                analyser.getFloatTimeDomainData(samples);
                peak = Math.max(peak, ...samples.map(Math.abs));
            }
            await context.close(); return peak;
        });
        assert.ok(await remotePeak() > .005, 'A selected application is audible through the native PCM mixer and Opus relay');
        await page.getByRole('button', {name: `Mute ${audioSource.label}`, exact: true}).click();
        await new Promise(resolve => setTimeout(resolve, 500));
        assert.ok(await remotePeak() < .002, 'Muting the selected application silences the mix even while an unselected application plays audio');
        await page.getByRole('button', {name: `Mute ${audioSource.label}`, exact: true}).click();
        assert.ok(await remotePeak() > .005, 'Unmuting restores the existing mixed audio track');
        await page.screenshot({path: 'test-artifacts/caster-mixer.png', fullPage: true});
        await audioBrowser.close();
        await page.getByText('This audio source ended.', {exact: false}).waitFor();
        assert.equal(await page.getByRole('button', {name: 'You’re live', exact: false}).count(), 1, 'Source exit leaves video sharing alive');
        await page.getByRole('button', {name: 'Stop sharing', exact: false}).click();
        await until(() => instance.desktop.sessions.size === 0);
    }
    await page.getByRole('button', {name: 'Encoding & quality'}).click();
    await page.getByLabel('Video bitrate ceiling (kbps)').fill('99999');
    await page.getByLabel('Video bitrate ceiling (kbps)').blur();
    assert.equal(await page.getByLabel('Video bitrate ceiling (kbps)').inputValue(), '6000');
    await page.screenshot({path: 'test-artifacts/caster-quality.png', fullPage: true});
    await page.getByRole('button', {name: 'Sign out'}).click();
    await page.getByLabel('Password', {exact: true}).waitFor();
    assert.deepEqual(errors, []);
});
