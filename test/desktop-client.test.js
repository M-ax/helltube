import test from 'node:test';
import assert from 'node:assert/strict';
import {get, writable} from 'svelte/store';
import {createDesktopShare, desktopCaptureOptions, desktopMimeType, desktopVideoMimeType, desktopSupport} from '../src/lib/desktop-share.js';

function fixture(t, {audio = true, capture} = {}) {
    const tracks = ['video', ...(audio ? ['audio'] : [])].map(kind => Object.assign(new EventTarget(), {
        kind, label: 'Test screen', readyState: 'live', stop() { this.readyState = 'ended'; },
    }));
    const stream = {getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
        getAudioTracks: () => tracks.filter(t => t.kind === 'audio')};
    const recordings = [];
    class Recorder {
        static isTypeSupported = type => [desktopMimeType, desktopVideoMimeType].includes(type);
        state = 'inactive';
        constructor(source, options) { assert.equal(source, stream); this.options = options; recordings.push(this); }
        start() { this.state = 'recording'; }
        stop() { this.state = 'inactive'; this.onstop?.(); }
    }
    const commands = [], chunks = [];
    const client = {state: writable({joined: true, status: 'connected', room: {id: 'lobby'}}), desktopMessages: writable(null),
        command: command => { commands.push(command); return true; }, sendCapture: data => { chunks.push(data); return true; }};
    const devices = {getDisplayMedia: options => { assert.equal(options, desktopCaptureOptions); return capture ? capture() : Promise.resolve(stream); }};
    const share = createDesktopShare(client, {devices, Recorder, secure: true});
    t.after(() => share.dispose());
    const accept = () => {
        const requestId = commands.find(c => c.type === 'desktop:start').requestId;
        client.desktopMessages.set({type: 'desktop:started', requestId, itemId: 'desktop', roomId: 'lobby'});
    };
    return {share, client, commands, chunks, recordings, tracks, stream, accept};
}

test('captures video and audio, waits for server acceptance, sends bounded chunks and stops tracks', async t => {
    const h = fixture(t);
    await h.share.start();
    assert.equal(h.share.active(), true);
    assert.equal(h.recordings[0].state, 'inactive');
    assert.equal(h.commands[0].audio, true);
    h.accept();
    assert.equal(get(h.share.state).status, 'sharing');
    h.recordings[0].ondataavailable({data: new Blob([new Uint8Array(700000)])});
    assert.equal(h.chunks.reduce((n, chunk) => n + chunk.size, 0), 700000);
    assert.ok(h.chunks.every(chunk => chunk.size <= 256 * 1024));
    h.share.stop();
    assert.ok(h.tracks.every(track => track.readyState === 'ended'));
    assert.equal(h.commands.at(-1).type, 'desktop:stop');
    assert.equal(h.share.active(), false);
});

test('missing audio starts a video-only share and advertises its actual audio state', async t => {
    const h = fixture(t, {audio: false});
    await h.share.start();
    h.accept();
    assert.equal(get(h.share.state).error, '');
    assert.equal(get(h.share.state).status, 'sharing');
    assert.equal(get(h.share.state).hasAudio, false);
    assert.equal(h.commands[0].audio, false);
    assert.equal(h.recordings[0].options.mimeType, desktopVideoMimeType);
    assert.equal(h.recordings[0].options.audioBitsPerSecond, undefined);
    assert.ok(h.tracks.every(track => track.readyState === 'live'));
});

test('ending audio updates the status without stopping video capture', async t => {
    const h = fixture(t);
    await h.share.start();
    h.accept();
    assert.equal(get(h.share.state).hasAudio, true);
    h.tracks[1].stop();
    h.tracks[1].dispatchEvent(new Event('ended'));
    assert.equal(h.share.active(), true);
    assert.equal(get(h.share.state).hasAudio, false);
    assert.equal(h.tracks[0].readyState, 'live');
    assert.equal(h.recordings[0].state, 'recording');
    assert.equal(h.commands.length, 1);
});

test('cancelling a pending picker releases a subsequently selected screen', async t => {
    const pending = Promise.withResolvers();
    const h = fixture(t, {capture: () => pending.promise});
    const start = h.share.start();
    h.share.stop();
    pending.resolve(h.stream);
    await start;
    assert.ok(h.tracks.every(track => track.readyState === 'ended'));
    assert.equal(h.commands.length, 0);
});

for (const cause of ['ended', 'disconnect', 'room', 'backpressure', 'server', 'cancel-before-ack']) {
    test(`sharing cleans up on ${cause}`, async t => {
        const h = fixture(t);
        await h.share.start();
        if (cause !== 'cancel-before-ack') h.accept();
        if (cause === 'ended') h.tracks[0].dispatchEvent(new Event('ended'));
        if (cause === 'disconnect') h.client.state.update(s => ({...s, joined: false}));
        if (cause === 'room') h.client.state.update(s => ({...s, room: {id: 'other'}}));
        if (cause === 'backpressure') {
            h.client.sendCapture = () => false;
            h.recordings[0].ondataavailable({data: new Blob(['video'])});
        }
        if (cause === 'server') h.client.desktopMessages.set({type: 'desktop:stopped', requestId: h.commands[0].requestId, message: 'Conversion failed'});
        if (cause === 'cancel-before-ack') { h.share.stop(); h.accept(); }
        assert.equal(h.share.active(), false);
        assert.ok(h.tracks.every(track => track.readyState === 'ended'));
        assert.equal(h.recordings[0].state, 'inactive');
        if (cause === 'server') assert.match(get(h.share.state).error, /Conversion failed/);
    });
}

test('insecure and unsupported browsers receive a useful explanation', () => {
    assert.match(desktopSupport({secure: false}), /HTTPS/);
    assert.match(desktopSupport({secure: true, devices: {}}), /Chrome or Edge/);
    assert.equal(desktopSupport({secure: true, devices: {getDisplayMedia() {}},
        Recorder: {isTypeSupported: type => type === desktopVideoMimeType}}), '');
});
