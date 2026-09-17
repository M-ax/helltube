import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {get, writable} from 'svelte/store';
import {createDesktopShare, desktopCaptureOptions, desktopSupport} from '../src/lib/desktop-share.js';
import {createDesktopPeer} from '../src/lib/desktop-peer.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
class FakeStream {
    tracks = [];
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
}
function fixture(t, {audio = true, capture, connectTimeout, peerStart} = {}) {
    const tracks = ['video', ...(audio ? ['audio'] : [])].map(kind => Object.assign(new EventTarget(), {
        id: kind, kind, label: 'Test screen', readyState: 'live', stop() { this.readyState = 'ended'; },
    }));
    const stream = {getTracks: () => tracks, getVideoTracks: () => tracks.filter(t => t.kind === 'video'),
        getAudioTracks: () => tracks.filter(t => t.kind === 'audio')};
    const peers = [], commands = [];
    const client = {state: writable({joined: true, status: 'connected', room: {id: 'lobby', current: null}}),
        desktopMessages: writable(null), command: command => { commands.push(command); return true; }};
    const makePeer = options => {
        const peer = {...options, closed: false, restarts: 0,
            async start() {
                if (peerStart) await peerStart();
                if (!this.closed && options.stream) options.onState('connected');
            },
            async restartIce() { this.restarts++; },
            close() { this.closed = true; }};
        peers.push(peer);
        return peer;
    };
    const devices = {getDisplayMedia: options => { assert.equal(options, desktopCaptureOptions); return capture ? capture() : Promise.resolve(stream); }};
    const share = createDesktopShare(client, {devices, Peer: class {}, Stream: FakeStream, makePeer, secure: true, connectTimeout});
    t.after(() => share.dispose());
    const current = id => client.state.update(value => ({...value, room: {id: 'lobby', current: {id, kind: 'desktop'}}}));
    const accept = () => {
        const requestId = commands.find(c => c.type === 'desktop:start').requestId;
        client.desktopMessages.set({type: 'desktop:started', requestId, itemId: 'desktop', peerId: 'metal', roomId: 'lobby'});
        current('desktop');
    };
    return {share, client, commands, peers, tracks, stream, accept, current};
}

test('one metal uplink starts after acceptance and the sender uses its local preview', async t => {
    const h = fixture(t);
    await h.share.start();
    assert.equal(h.commands[0].transport, 'mediasoup');
    assert.equal(h.peers.length, 0);
    h.accept(); await flush();
    assert.equal(get(h.share.state).status, 'sharing');
    assert.equal(get(h.share.playback).stream, h.stream);
    assert.equal(get(h.share.playback).local, true);
    assert.equal(h.commands.some(command => command.type === 'desktop:watch'), false);
    assert.equal(h.peers.length, 1);
    assert.equal(h.peers[0].stream, h.stream);
    h.current('desktop');
    h.client.desktopMessages.set({type: 'desktop:peer', requestId: h.commands[0].requestId, peerId: 'viewer'});
    assert.equal(h.peers.length, 1, 'Legacy viewer notices cannot create per-viewer uploads');
    h.share.stop();
    assert.ok(h.tracks.every(track => track.readyState === 'ended'));
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.commands.at(-1).type, 'desktop:stop');
});

test('video-only capture and ending audio preserve the video share', async t => {
    const h = fixture(t, {audio: false});
    await h.share.start(); h.accept(); await flush();
    assert.equal(get(h.share.state).hasAudio, false);
    assert.equal(h.commands[0].audio, false);
    const a = fixture(t);
    await a.share.start(); a.accept(); await flush();
    a.tracks[1].stop(); a.tracks[1].dispatchEvent(new Event('ended'));
    assert.equal(a.share.active(), true);
    assert.equal(get(a.share.state).hasAudio, false);
    assert.equal(a.tracks[0].readyState, 'live');
});

test('cancelling a pending picker releases a subsequently selected screen', async t => {
    const pending = Promise.withResolvers();
    const h = fixture(t, {capture: () => pending.promise});
    const start = h.share.start();
    h.share.stop(); pending.resolve(h.stream); await start;
    assert.ok(h.tracks.every(track => track.readyState === 'ended'));
    assert.equal(h.commands.length, 0);
});

for (const cause of ['ended', 'disconnect', 'room', 'server', 'cancel-before-ack']) {
    test('sharing cleans up on ' + cause, async t => {
        const h = fixture(t);
        await h.share.start();
        if (cause !== 'cancel-before-ack') { h.accept(); await flush(); }
        if (cause === 'ended') h.tracks[0].dispatchEvent(new Event('ended'));
        if (cause === 'disconnect') h.client.state.update(s => ({...s, joined: false}));
        if (cause === 'room') h.client.state.update(s => ({...s, room: {id: 'other'}}));
        if (cause === 'server') h.client.desktopMessages.set({type: 'desktop:stopped', requestId: h.commands[0].requestId, message: 'Share ended'});
        if (cause === 'cancel-before-ack') {
            h.share.stop();
            h.client.desktopMessages.set({type: 'desktop:started', requestId: h.commands[0].requestId, itemId: 'desktop'});
        }
        assert.equal(h.share.active(), false);
        assert.ok(h.tracks.every(track => track.readyState === 'ended'));
        assert.equal(get(h.share.playback).stream, null);
        assert.ok(h.peers.every(peer => peer.closed));
    });
}

test('viewers subscribe once, accept forwarded tracks, retry with fresh identity and close on leaving', async t => {
    const h = fixture(t);
    h.current('desktop');
    const requestId = h.commands.at(-1).requestId;
    h.client.desktopMessages.set({type: 'desktop:watching', requestId, itemId: 'desktop', peerId: 'viewer'});
    const peer = h.peers[0];
    peer.onStream(h.stream);
    assert.equal(get(h.share.playback).stream, h.stream);
    h.current('desktop');
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 1);
    h.share.retryView();
    assert.equal(peer.closed, true);
    assert.notEqual(h.commands.at(-1).requestId, requestId);
    peer.onStream(h.stream);
    assert.equal(get(h.share.playback).stream, null, 'A closed receiver cannot reattach stale media');
    h.client.state.update(value => ({...value, joined: false}));
    assert.equal(get(h.share.playback).stream, null);
});

test('failed viewer connections retry a bounded number of times with a metal connectivity hint', async t => {
    const h = fixture(t, {connectTimeout: 10});
    h.current('desktop');
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 3);
    assert.match(get(h.share.playback).error, /media port or TURN/);
    h.current('desktop');
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 3);
});

test('publisher ICE retries keep one transport and stop capture after repeated failure', async t => {
    const h = fixture(t);
    await h.share.start(); h.accept(); await flush();
    const peer = h.peers[0];
    peer.onState('failed'); await flush();
    peer.onState('failed'); await flush();
    assert.equal(peer.restarts, 2);
    assert.equal(h.peers.length, 1);
    peer.onState('failed');
    assert.equal(h.share.active(), false);
    assert.equal(peer.closed, true);
});

test('failed or cancelled asynchronous publishing never leaves capture running', async t => {
    const pending = Promise.withResolvers();
    const h = fixture(t, {peerStart: () => pending.promise});
    await h.share.start(); h.accept();
    h.share.stop();
    pending.resolve();
    await flush();
    assert.equal(h.share.active(), false);
    assert.equal(get(h.share.state).status, 'idle');
    assert.equal(h.peers[0].closed, true);
});

function relayHarness(t, {stream, load, respond = true, codecs, mediaCapabilities = null, failProduce} = {}) {
    const commands = [], produced = [], consumed = [], events = [];
    const connection = {requestId: 'capture', peerId: 'peer', itemId: 'desktop', transportOptions: {id: 'transport'},
        rtcConfig: {iceServers: [], iceTransportPolicy: 'all'}, routerRtpCapabilities: {}, producers: []};
    const client = {desktopMessages: writable(null), command(message) {
        commands.push(message);
        if (respond) queueMicrotask(() => {
            const data = message.action === 'produce' ? {id: message.kind + '-producer'} :
                message.action === 'consume' ? {id: 'consumer', kind: 'video', producerId: message.producerId, rtpParameters: {}} : {};
            events.push(message.action);
            client.desktopMessages.set({type: 'desktop:response', requestId: message.requestId, rpcId: message.rpcId, data});
        });
        return true;
    }};
    const transports = [];
    const makeTransport = () => {
        const transport = Object.assign(new EventEmitter(), {
            closed: false,
            close() { this.closed = true; },
            async produce(options) {
                produced.push(options);
                if (!this.connected) {
                    await new Promise((resolve, reject) => this.emit('connect', {dtlsParameters: {}}, resolve, reject));
                    this.connected = true;
                }
                await failProduce?.(options);
                const data = await new Promise((resolve, reject) => this.emit('produce', {kind: options.track.kind, rtpParameters: {}}, resolve, reject));
                return Object.assign(new EventEmitter(), {id: data.id, close() {}});
            },
            async consume(options) {
                const track = {kind: options.kind, stopped: false, stop() { this.stopped = true; }};
                const consumer = {...options, track, rtpReceiver: {jitterBufferTarget: 100},
                    close() { this.closed = true; track.stop(); }};
                consumed.push(consumer);
                events.push('installed');
                return consumer;
            },
        });
        transports.push(transport);
        return transport;
    };
    const device = {async load() {}, recvRtpCapabilities: {}, sendRtpCapabilities: {codecs},
        createSendTransport: makeTransport, createRecvTransport: makeTransport};
    let received;
    const peer = createDesktopPeer({client, connection, stream, Stream: FakeStream,
        loadDevice: load || (async () => device), mediaCapabilities, onStream: stream => { received = stream; }});
    t.after(() => peer.close());
    return {peer, client, connection, commands, produced, consumed, transports,
        get transport() { return transports.at(-1); }, events, received: () => received};
}

const videoCodecs = [{mimeType: 'video/VP8'}, {mimeType: 'video/H264'}];

test('a rejected preferred codec retries with fresh transport and publishes video before audio', async t => {
    const tracks = ['audio', 'video'].map(kind => ({kind, readyState: 'live'}));
    const h = relayHarness(t, {stream: {getTracks: () => tracks}, codecs: videoCodecs,
        failProduce(options) { if (options.codec?.mimeType === 'video/H264') throw new Error('Encoder unavailable'); }});
    await h.peer.start();
    assert.deepEqual(h.produced.map(options => options.codec?.mimeType), ['video/H264', 'video/VP8', undefined]);
    assert.deepEqual(h.commands.map(message => message.action), ['connect', 'retry-video', 'connect', 'produce', 'produce', 'ready']);
    assert.equal(h.transports.length, 2);
    assert.equal(h.transports[0].closed, true);
    assert.equal(h.transports[1].closed, false);
    assert.ok(h.produced.every(options => options.stopTracks === false));
    assert.ok(tracks.every(track => track.readyState === 'live'));
});

test('codec retries stop after all negotiated codecs fail', async t => {
    const h = relayHarness(t, {stream: {getTracks: () => [{kind: 'video', readyState: 'live'}]}, codecs: videoCodecs,
        failProduce() { throw new Error('Encoder unavailable'); }});
    await assert.rejects(h.peer.start(), /Encoder unavailable/);
    assert.equal(h.produced.length, 2);
    assert.equal(h.commands.filter(message => message.action === 'retry-video').length, 1);
    assert.equal(h.commands.some(message => message.action === 'ready'), false);
});

test('ending capture during a failed codec attempt prevents a retry', async t => {
    const track = {kind: 'video', readyState: 'live'};
    const h = relayHarness(t, {stream: {getTracks: () => [track]}, codecs: videoCodecs,
        failProduce() { track.readyState = 'ended'; throw new Error('Capture ended'); }});
    await assert.rejects(h.peer.start(), /Capture ended/);
    assert.equal(h.produced.length, 1);
    assert.equal(h.transports.length, 1);
});

test('closing during capability detection prevents publication', async t => {
    const pending = Promise.withResolvers();
    const h = relayHarness(t, {stream: {getTracks: () => [{kind: 'video', readyState: 'live'}]}, codecs: videoCodecs,
        mediaCapabilities: {encodingInfo: () => pending.promise}});
    const starting = h.peer.start();
    await flush();
    h.peer.close();
    pending.resolve({supported: true, powerEfficient: true});
    await assert.rejects(starting, /closed/);
    assert.equal(h.produced.length, 0);
    assert.equal(h.transport.closed, true);
});

test('signaling errors do not retry codecs or hide the server error', async t => {
    const h = relayHarness(t, {stream: {getTracks: () => [{kind: 'video', readyState: 'live'}]},
        codecs: videoCodecs, respond: false});
    const starting = h.peer.start();
    await flush();
    const request = h.commands[0];
    h.client.desktopMessages.set({type: 'desktop:error', requestId: request.requestId, rpcId: request.rpcId,
        message: 'Desktop connection is not authorized.'});
    await assert.rejects(starting, /not authorized/);
    assert.deepEqual(h.commands.map(message => message.action), ['connect']);
    assert.equal(h.transports.length, 1);
});

test('transport publishes one encoding per track with a fixed upload ceiling and never takes ownership of capture', async t => {
    const tracks = ['video', 'audio'].map(kind => ({kind, readyState: 'live'}));
    const h = relayHarness(t, {stream: {getTracks: () => tracks}});
    await h.peer.start();
    assert.deepEqual(h.produced.map(options => options.track), tracks);
    assert.ok(h.produced.every(options => options.stopTracks === false));
    assert.deepEqual(h.produced[0].encodings, [{maxBitrate: 6_000_000, maxFramerate: 30}]);
    assert.deepEqual(h.commands.map(message => message.action), ['connect', 'produce', 'produce', 'ready']);
    assert.ok(h.commands.every(message => message.itemId === 'desktop' && message.peerId === 'peer' && message.requestId === 'capture'));
});

test('late producer announcements install each consumer once before resuming; audio/video closure removes tracks', async t => {
    const h = relayHarness(t);
    await h.peer.start();
    const available = {type: 'desktop:available', requestId: 'capture', producers: [{id: 'video', kind: 'video'}]};
    h.client.desktopMessages.set(available);
    h.client.desktopMessages.set(available);
    await flush();
    assert.equal(h.consumed.length, 1);
    assert.deepEqual(h.events, ['consume', 'installed', 'resume']);
    assert.equal(h.received().getTracks().length, 1);
    h.client.desktopMessages.set({type: 'desktop:producer-closed', requestId: 'capture', producerId: 'video'});
    assert.equal(h.received().getTracks().length, 0);
    assert.equal(h.consumed[0].closed, true);
});

test('closing during device loading or an RPC rejects pending work and releases transport resources', async t => {
    const pending = Promise.withResolvers();
    const h = relayHarness(t, {load: () => pending.promise});
    const loading = h.peer.start();
    h.peer.close();
    pending.resolve({});
    await assert.rejects(loading, /closed/);
    const r = relayHarness(t, {respond: false, stream: {getTracks: () => [{kind: 'video', readyState: 'live'}]}});
    const starting = r.peer.start();
    await flush();
    r.peer.close();
    await assert.rejects(starting, /closed/);
    assert.equal(r.transport.closed, true);
});

test('insecure and unsupported browsers receive a useful explanation', () => {
    assert.match(desktopSupport({secure: false}), /HTTPS/);
    assert.match(desktopSupport({secure: true, devices: {}}), /Chrome or Edge/);
    assert.equal(desktopSupport({secure: true, devices: {getDisplayMedia() {}}, Peer: class {}}), '');
});
