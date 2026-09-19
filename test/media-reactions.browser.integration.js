import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {chromium} from 'playwright';
import {start, until} from './helpers.js';
import {makeItem} from '../server/rooms.js';
import {BASS_BOOST_OUTPUT_GAIN, MEDIA_REACTION_LIFETIME_MS} from '../src/lib/media-reactions.js';

test('bass processing distorts real samples, attenuates after clipping, and restores clean playback', {timeout: 30000}, async t => {
    const {instance, url} = await start(t, {maxTranscoders: 0});
    instance.app.get('/media-reactions.js', (_req, res) => res.sendFile(path.resolve('src/lib/media-reactions.js')));
    instance.app.get('/audio-visualizations.js', (_req, res) => res.sendFile(path.resolve('src/lib/audio-visualizations.js')));
    const browser = await chromium.launch({channel: 'chrome', headless: true});
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.goto(url);
    const results = await page.evaluate(async () => {
        const {createBassBoost} = await import('/media-reactions.js');
        async function render({frequency = 60, amplitude = 1, volume = 1, enabled = true} = {}) {
            const context = new OfflineAudioContext(1, 48000, 48000);
            const source = context.createOscillator();
            const input = context.createGain();
            source.frequency.value = frequency;
            input.gain.value = amplitude;
            source.connect(input).connect(context.destination);
            const effect = createBassBoost(context, input);
            effect.set(true, volume);
            if (!enabled) effect.set(false, volume);
            source.start();
            const buffer = await context.startRendering();
            const samples = buffer.getChannelData(0).slice(24000);
            const peak = Math.max(...samples.map(Math.abs));
            const rms = Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
            // Measure both phases so bass-filter phase shift cannot hide distortion.
            const magnitude = hz => {
                let real = 0, imaginary = 0;
                samples.forEach((value, i) => {
                    real += value * Math.cos(2 * Math.PI * hz * i / 48000);
                    imaginary += value * Math.sin(2 * Math.PI * hz * i / 48000);
                });
                return Math.hypot(real, imaginary) * 2 / samples.length;
            };
            const fundamental = magnitude(frequency);
            const harmonic = magnitude(frequency * 3);
            return {frequency, volume, peak, rms, fundamental, harmonic};
        }
        const levels = [];
        for (const volume of [1, .25, 0]) levels.push(await render({volume}));
        const spectrum = [];
        for (const frequency of [60, 1000, 4000]) spectrum.push(await render({frequency, amplitude: .04}));
        return {levels, spectrum, clean: await render({enabled: false}),
            quietBass: await render({frequency: 60, amplitude: .002}),
            quietMid: await render({frequency: 1000, amplitude: .002})};
    });
    for (const {volume, peak, harmonic} of results.levels) {
        assert.ok(peak <= BASS_BOOST_OUTPUT_GAIN * volume + .00001, `Processed peak ${peak} respects volume ${volume}`);
        if (volume) assert.ok(harmonic > .005 * volume, 'The effect adds distorted harmonics.');
    }
    for (const {frequency, peak, fundamental, harmonic} of results.spectrum) {
        assert.ok(harmonic / fundamental > .15, `${frequency} Hz is heavily distorted even at a modest input level.`);
        assert.ok(peak <= BASS_BOOST_OUTPUT_GAIN + .00001, `${frequency} Hz remains attenuated after processing.`);
    }
    assert.ok(results.quietBass.rms > results.quietMid.rms * 3, 'Bass retains extra emphasis at low input levels.');
    assert.ok(results.clean.peak > .99, 'Disabling the effect restores the clean signal.');
    assert.ok(results.clean.harmonic < .0001, 'Disabling the effect removes distortion.');
    const streamResult = await page.evaluate(async () => {
        const {createAudioAnalysis} = await import('/audio-visualizations.js');
        const analysis = createAudioAnalysis();
        const context = new AudioContext();
        await context.resume();
        const tone = context.createOscillator();
        const stream = context.createMediaStreamDestination();
        tone.connect(stream);
        tone.start();
        const canvas = document.createElement('canvas');
        const videoTrack = canvas.captureStream().getVideoTracks()[0];
        stream.stream.addTrack(videoTrack);
        const untouched = await analysis.boostStream(stream.stream, false, true);
        const processed = await analysis.boostStream(stream.stream, true, true);
        const source = context.createMediaStreamSource(processed);
        const analyser = context.createAnalyser();
        source.connect(analyser);
        await new Promise(resolve => setTimeout(resolve, 300));
        const samples = new Float32Array(analyser.fftSize);
        analyser.getFloatTimeDomainData(samples);
        const boostedPeak = Math.max(...samples.map(Math.abs));
        const clean = await analysis.boostStream(stream.stream, false);
        await new Promise(resolve => setTimeout(resolve, 300));
        analyser.getFloatTimeDomainData(samples);
        const cleanPeak = Math.max(...samples.map(Math.abs));
        const restored = await analysis.boostStream(stream.stream, true);
        const sameVideo = processed.getVideoTracks()[0] === videoTrack;
        stream.stream.removeTrack(videoTrack);
        await analysis.boostStream(stream.stream, true);
        const removedVideo = processed.getVideoTracks().length === 0;
        stream.stream.addTrack(videoTrack);
        await analysis.boostStream(stream.stream, true);
        const restoredVideo = processed.getVideoTracks()[0] === videoTrack;
        analysis.releaseStream(stream.stream);
        const originalAlive = stream.stream.getTracks().every(track => track.readyState === 'live');
        const processedEnded = processed.getAudioTracks().every(track => track.readyState === 'ended');
        analysis.destroy();
        videoTrack.stop();
        tone.stop();
        await context.close();
        return {boostedPeak, cleanPeak, sameVideo, removedVideo, restoredVideo, originalAlive, processedEnded,
            untouched: untouched === stream.stream, reused: clean === processed && restored === processed};
    });
    assert.ok(streamResult.boostedPeak > .1 && streamResult.boostedPeak <= BASS_BOOST_OUTPUT_GAIN + .001);
    assert.ok(streamResult.cleanPeak > .99);
    for (const property of ['sameVideo', 'removedVideo', 'restoredVideo', 'originalAlive', 'processedEnded', 'untouched', 'reused']) {
        assert.equal(streamResult[property], true, property);
    }
});

test('deep fried and bass boosted are shared, bounded, locally controlled, and leave video playing', {timeout: 60000}, async t => {
    const {instance, url, dir} = await start(t);
    instance.rooms.create('Quiet room');
    const sample = path.join(dir, 'media-reactions.mp4');
    await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
        '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24', '-f', 'lavfi', '-i', 'sine=frequency=60:sample_rate=48000',
        '-t', '60', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '48', '-pix_fmt', 'yuv420p', '-c:a', 'aac', sample]);
    instance.app.get('/media-fixture.mp4', (_req, res) => res.sendFile(sample, {dotfiles: 'allow'}));
    t.mock.method(instance.twitch, 'resolve', async () => ({duration: 60,
        inputs: [{url: `${url}/media-fixture.mp4`, headers: {}}]}));
    const browser = await chromium.launch({channel: 'chrome', headless: true, args: ['--enable-unsafe-swiftshader']});
    t.after(() => browser.close());
    const a = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const b = await browser.newPage({viewport: {width: 900, height: 800}});
    const errors = [];
    for (const page of [a, b]) {
        page.setDefaultTimeout(8000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => {
            window.mediaSources = [];
            window.audioOutputs = [];
            const createSource = AudioContext.prototype.createMediaElementSource;
            const connect = AudioNode.prototype.connect;
            AudioContext.prototype.createMediaElementSource = function (...args) {
                const source = createSource.apply(this, args);
                window.mediaSources.push(source);
                return source;
            };
            AudioNode.prototype.connect = function (target, ...args) {
                if (this instanceof GainNode && target === this.context.destination) window.audioOutputs.push(this);
                return connect.call(this, target, ...args);
            };
        });
        await page.goto(url);
        await page.getByLabel('Username', {exact: true}).fill('admin');
        await page.getByLabel('Password', {exact: true}).fill('garbageTime_');
        await page.getByRole('button', {name: 'Enter Helltube'}).click();
        await page.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: new RegExp(`^${instance.rooms.get('lobby').name}`)}).click();
    }
    const room = instance.rooms.get('lobby');
    const item = makeItem({kind: 'twitch', url: 'https://twitch.tv/videos/12345'}, {duration: 60, title: 'Media reactions test'});
    instance.rooms.add(room, [item]);
    await until(async () => (await Promise.all([a, b].map(page => page.locator('.video-viewport > video')
        .evaluate(video => video.readyState >= 2 && !video.paused)))).every(Boolean), 15000);
    const revision = room.playback.revision;
    const effect = (page, kind) => page.locator(`[data-reaction="${kind}"]`);
    const enabled = page => page.getByRole('switch', {name: 'Enable reactions on this device'});
    const mute = page => page.getByRole('button', {name: 'Mute reaction sounds', exact: true});
    const outputLevels = page => page.evaluate(() => window.audioOutputs.map(node => node.gain.value));
    const before = await a.locator('video').evaluate(video => video.currentTime);
    await a.getByRole('button', {name: 'Deep fried', exact: true}).click();
    await effect(b, 'deepfried').waitFor();
    assert.equal(await effect(a, 'deepfried').getAttribute('data-reaction-id'), await effect(b, 'deepfried').getAttribute('data-reaction-id'));
    assert.match(await b.locator('video').evaluate(video => getComputedStyle(video).filter), /deep-fried-colors/);
    assert.equal(await b.locator('.player-controls').evaluate(node => getComputedStyle(node).filter), 'none');
    await a.locator('.video-viewport').screenshot({path: 'test-artifacts/deep-fried.png'});
    await a.getByRole('button', {name: 'Bass boosted', exact: true}).click();
    await effect(b, 'bassboost').waitFor();
    assert.equal(await effect(a, 'bassboost').getAttribute('data-reaction-id'), await effect(b, 'bassboost').getAttribute('data-reaction-id'));
    await until(async () => (await outputLevels(b)).length === 2 && (await outputLevels(b))[0] < .001);
    for (const page of [a, b]) {
        const levels = await outputLevels(page);
        assert.ok(Math.abs(levels[1] - BASS_BOOST_OUTPUT_GAIN * .8) < .001);
    }
    const samples = await a.evaluate(async () => {
        const output = window.audioOutputs[1];
        const analyser = output.context.createAnalyser();
        output.connect(analyser);
        const video = document.querySelector('.video-viewport > video');
        const slider = document.querySelector('.volume-range');
        const setVolume = value => { slider.value = value; slider.dispatchEvent(new Event('input', {bubbles: true})); };
        const peak = async () => {
            await new Promise(resolve => setTimeout(resolve, 150));
            const data = new Float32Array(analyser.fftSize);
            analyser.getFloatTimeDomainData(data);
            return Math.max(...data.map(Math.abs));
        };
        const audible = await peak();
        setVolume('0.70');
        const quiet = await peak();
        const quietVolume = video.volume;
        document.querySelector('[aria-label="Mute on this device"]').click();
        let muted = await peak();
        for (let i = 0; i < 10 && muted >= .0001; i++) muted = await peak();
        document.querySelector('[aria-label="Unmute on this device"]').click();
        setVolume('0.95');
        output.disconnect(analyser);
        return {audible, quiet, quietVolume, muted};
    });
    assert.ok(samples.audible > .01 && samples.audible <= BASS_BOOST_OUTPUT_GAIN * .8 + .001);
    assert.ok(samples.quiet > 0 && samples.quiet <= BASS_BOOST_OUTPUT_GAIN * samples.quietVolume + .001);
    assert.ok(samples.muted < .0001, `The final signal respects native player mute: ${JSON.stringify(samples)}`);
    await mute(b).click();
    await until(async () => (await outputLevels(b))[0] > .99 && (await outputLevels(b))[1] < .001);
    assert.ok((await outputLevels(a))[0] < .001, 'Reaction mute is local.');
    const previousId = await effect(a, 'bassboost').getAttribute('data-reaction-id');
    await a.getByRole('button', {name: 'Bass boosted', exact: true}).click();
    await until(async () => await effect(a, 'bassboost').getAttribute('data-reaction-id') !== previousId);
    assert.equal(await effect(a, 'bassboost').count(), 1);
    assert.equal(await a.evaluate(() => window.mediaSources.length), 1, 'Repeated effects reuse the media source.');
    assert.equal(await a.evaluate(() => window.audioOutputs.length), 2, 'Repeated effects never stack gain.');
    await enabled(a).click();
    assert.equal(await effect(a, 'deepfried').count(), 0);
    assert.equal(await effect(a, 'bassboost').count(), 0);
    assert.equal(await a.locator('video').evaluate(video => getComputedStyle(video).filter), 'none');
    await until(async () => (await outputLevels(a))[0] > .99);
    await enabled(a).click();
    await until(async () => await effect(b, 'deepfried').count() === 0 && await effect(b, 'bassboost').count() === 0);
    assert.ok(await a.locator('video').evaluate(video => video.currentTime) > before + 3);
    assert.equal(room.playback.revision, revision);

    const emit = (kind, id, age = 0) => instance.reactions.broadcast('lobby', {type: 'reaction', roomId: 'lobby', id,
        kind, userId: instance.accounts.users[0].id, x: .5, y: .65, serverTime: Date.now() - age});
    emit('bassboost', 'late-bass', MEDIA_REACTION_LIFETIME_MS - 900);
    await effect(a, 'bassboost').waitFor();
    await until(async () => await effect(a, 'bassboost').count() === 0, 2000);
    await until(async () => (await outputLevels(a))[0] > .99);
    emit('deepfried', 'expired-fry', MEDIA_REACTION_LIFETIME_MS + 100);
    await a.getByRole('heading', {name: 'Reactions', exact: true}).click();
    assert.equal(await effect(a, 'deepfried').count(), 0);
    emit('bassboost', 'hide-bass');
    await effect(a, 'bassboost').waitFor();
    await a.evaluate(() => { Object.defineProperty(document, 'hidden', {configurable: true, value: true}); document.dispatchEvent(new Event('visibilitychange')); });
    await until(async () => await effect(a, 'bassboost').count() === 0 && (await outputLevels(a))[0] > .99);
    await a.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    assert.equal(await effect(a, 'bassboost').count(), 0, 'Returning to the tab never restarts the distortion.');
    emit('deepfried', 'room-fry');
    emit('bassboost', 'room-bass');
    await effect(a, 'bassboost').waitFor();
    await a.getByRole('navigation', {name: 'Screening rooms'}).getByRole('button', {name: /^Quiet room/}).click();
    await until(async () => await effect(a, 'deepfried').count() === 0 && await effect(a, 'bassboost').count() === 0);
    await until(async () => (await outputLevels(a))[0] > .99);
    await b.setViewportSize({width: 320, height: 844});
    assert.equal(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
});
