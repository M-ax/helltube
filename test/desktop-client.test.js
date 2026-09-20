import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {get, writable} from 'svelte/store';
import {createDesktopShare, desktopCaptureOptions, desktopSupport} from '../src/lib/desktop-share.js';
import {createDesktopPeer} from '../src/lib/desktop-peer.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const playback = (share, id = 'desktop') => get(share.playback)[id] || {stream: null, stats: null, connectionState: 'new'};
class FakeStream {
    tracks = [];
    getTracks() { return this.tracks; }
    addTrack(track) { this.tracks.push(track); }
    removeTrack(track) { this.tracks = this.tracks.filter(value => value !== track); }
}
function fixture(t, {audio = true, capture, connectTimeout, peerStart, quality, watchRemote} = {}) {
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
            async setVideoEnabled(enabled) { this.videoEnabled = enabled; },
            close() { this.closed = true; }};
        peers.push(peer);
        return peer;
    };
    const devices = {getDisplayMedia: options => { assert.equal(options, desktopCaptureOptions); return capture ? capture() : Promise.resolve(stream); }};
    const share = createDesktopShare(client, {devices, Peer: class {}, Stream: FakeStream, makePeer, secure: true, connectTimeout, quality, watchRemote});
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
    assert.equal(playback(h.share).stream, h.stream);
    assert.equal(playback(h.share).local, true);
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
        assert.equal(playback(h.share).stream, null);
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
    assert.equal(playback(h.share).stream, h.stream);
    h.current('desktop');
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 1);
    h.share.retryView('desktop');
    assert.equal(peer.closed, true);
    assert.notEqual(h.commands.at(-1).requestId, requestId);
    peer.onStream(h.stream);
    assert.equal(playback(h.share).stream, null, 'A closed receiver cannot reattach stale media');
    h.client.state.update(value => ({...value, joined: false}));
    assert.equal(playback(h.share).stream, null);
});

test('failed viewer connections retry a bounded number of times with a metal connectivity hint', async t => {
    const h = fixture(t, {connectTimeout: 10});
    h.current('desktop');
    await new Promise(resolve => setTimeout(resolve, 90));
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 3);
    assert.match(playback(h.share).error, /media port or TURN/);
    h.current('desktop');
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 3);
});

test('multiple views isolate streams, retries, stale replies and cleanup', t => {
    const h = fixture(t);
    const setItems = ids => h.client.state.update(value => ({...value, room: {id: 'lobby',
        current: {id: ids[0], kind: 'desktop'}, desktops: ids.map(id => ({id, kind: 'desktop'}))}}));
    setItems(['first', 'second']);
    const watches = h.commands.filter(command => command.type === 'desktop:watch');
    assert.deepEqual(watches.map(command => command.itemId), ['first', 'second']);
    for (const command of watches) h.client.desktopMessages.set({...command, type: 'desktop:watching', peerId: command.itemId});
    const [first, second] = h.peers;
    first.onStream(h.stream);
    const otherStream = new FakeStream();
    second.onStream(otherStream);
    second.onStats({bitrate: 2000});
    h.share.retryView('first');
    assert.equal(first.closed, true);
    assert.equal(second.closed, false);
    assert.equal(playback(h.share, 'second').stream, otherStream);
    assert.deepEqual(playback(h.share, 'second').stats, {bitrate: 2000});
    first.onStream(h.stream);
    h.client.desktopMessages.set({type: 'desktop:stopped', requestId: watches[0].requestId});
    assert.equal(playback(h.share, 'first').stream, null);
    assert.ok(get(h.share.playback).first, 'A stale stop cannot remove the new connection');
    setItems(['second']);
    assert.deepEqual(Object.keys(get(h.share.playback)), ['second']);
    assert.equal(second.closed, false);
    h.client.state.update(value => ({...value, room: {id: 'other'}}));
    assert.equal(second.closed, true);
    assert.deepEqual(get(h.share.playback), {});
});

test('a sharer previews locally while watching another desktop and survives its departure', async t => {
    const h = fixture(t);
    h.current('other');
    const watching = h.commands.at(-1);
    h.client.desktopMessages.set({...watching, type: 'desktop:watching', peerId: 'other-peer'});
    await h.share.start();
    const requestId = h.commands.find(command => command.type === 'desktop:start').requestId;
    h.client.desktopMessages.set({type: 'desktop:started', requestId, itemId: 'desktop', peerId: 'metal', roomId: 'lobby'});
    h.client.state.update(value => ({...value, room: {...value.room, desktops: [value.room.current, {id: 'desktop', kind: 'desktop'}]}}));
    await flush();
    assert.equal(h.share.active(), true);
    assert.equal(playback(h.share).local, true);
    assert.equal(playback(h.share).stream, h.stream);
    assert.equal(h.commands.filter(command => command.type === 'desktop:watch').length, 1);
    h.current('desktop');
    assert.equal(h.peers[0].closed, true);
    assert.equal(h.peers[1].closed, false);
    assert.equal(h.share.active(), true);
    assert.equal(playback(h.share).stream, h.stream);
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

function relayHarness(t, {stream, load, respond = true, codecs, mediaCapabilities = null, failProduce, getStats, quality,
    videoEnabled = true, rpcError, beforeConsume} = {}) {
    const commands = [], produced = [], consumed = [], events = [];
    const connection = {requestId: 'capture', peerId: 'peer', itemId: 'desktop', transportOptions: {id: 'transport'},
        rtcConfig: {iceServers: [], iceTransportPolicy: 'all'}, routerRtpCapabilities: {}, producers: []};
    const client = {desktopMessages: writable(null), command(message) {
        commands.push(message);
        if (respond) queueMicrotask(() => {
            const error = rpcError?.(message);
            if (error) {
                client.desktopMessages.set({type: 'desktop:error', requestId: message.requestId, rpcId: message.rpcId, message: error});
                return;
            }
            const data = message.action === 'produce' ? {id: message.kind + '-producer'} :
                message.action === 'consume' ? {id: `${message.producerId}-consumer`,
                    kind: message.producerId === 'audio' ? 'audio' : 'video', producerId: message.producerId, rtpParameters: {}} : {};
            events.push(message.action);
            client.desktopMessages.set({type: 'desktop:response', requestId: message.requestId, rpcId: message.rpcId, data});
        });
        return true;
    }};
    const transports = [];
    const makeTransport = () => {
        const transport = Object.assign(new EventEmitter(), {
            closed: false,
            getStats,
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
                await beforeConsume?.(options);
                const track = {kind: options.kind, stopped: false, stop() { this.stopped = true; }};
                const consumer = {...options, track, rtpReceiver: {jitterBufferTarget: 100},
                    pause() { this.paused = true; }, resume() { this.paused = false; },
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
    const stats = [], videoErrors = [];
    const peer = createDesktopPeer({client, connection, stream, Stream: FakeStream,
        loadDevice: load || (async () => device), mediaCapabilities, onStream: stream => { received = stream; },
        videoEnabled, quality, onVideoError: error => videoErrors.push(error),
        onStats: report => stats.push(report)});
    t.after(() => peer.close());
    return {peer, client, connection, commands, produced, consumed, transports, stats, videoErrors,
        get transport() { return transports.at(-1); }, events, received: () => received};
}

const videoCodecs = [{mimeType: 'video/VP8'}, {mimeType: 'video/H264'}];

test('statistics polling tolerates failure, avoids overlapping reads and ignores results after close', async t => {
    t.mock.timers.enable({apis: ['setTimeout']});
    const pending = Promise.withResolvers();
    let reads = 0;
    const h = relayHarness(t, {getStats: () => {
        reads++;
        if (reads === 1) throw new Error('Stats unavailable');
        return pending.promise;
    }});
    await h.peer.start();
    await flush();
    assert.deepEqual(h.stats, [null]);
    t.mock.timers.tick(1000);
    await flush();
    assert.equal(reads, 2);
    t.mock.timers.tick(10000);
    assert.equal(reads, 2, 'Only one stats request may be outstanding');
    h.peer.close();
    pending.resolve(new Map());
    await flush();
    t.mock.timers.tick(10000);
    assert.equal(reads, 2);
    assert.deepEqual(h.stats, [null], 'A closed peer cannot publish a pending result');
});

test('publisher statistics follow the local preview and cannot outlive a share', async t => {
    const h = fixture(t);
    await h.share.start(); h.accept(); await flush();
    const report = {bitrate: 3000000, encoderLoad: 15};
    h.peers[0].onStats(report);
    assert.equal(playback(h.share).stats, report);
    assert.equal(playback(h.share).connectionState, 'connected');
    h.share.stop();
    h.peers[0].onStats(report);
    assert.equal(playback(h.share).stats, null);
});

test('viewer statistics survive track updates and reset on retry or leaving', t => {
    const h = fixture(t);
    h.current('desktop');
    h.client.desktopMessages.set({type: 'desktop:watching', requestId: h.commands.at(-1).requestId,
        itemId: 'desktop', peerId: 'viewer'});
    const peer = h.peers[0];
    const report = {bitrate: 2000000};
    peer.onStats(report);
    peer.onStream(h.stream);
    assert.equal(playback(h.share).stats, report);
    h.share.retryView('desktop');
    peer.onStats(report);
    peer.onState('connected');
    assert.equal(playback(h.share).stats, null);
    assert.equal(playback(h.share).connectionState, 'new');
    h.client.state.update(value => ({...value, joined: false}));
    assert.equal(playback(h.share).stats, null);
});

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

test('both H264 profiles can fail before VP8 succeeds without losing capture or audio', async t => {
    const tracks = ['video', 'audio'].map(kind => ({kind, readyState: 'live'}));
    const codecs = [videoCodecs[0], ...['42001f', '42e01f'].map(profile =>
        ({mimeType: 'video/H264', parameters: {'profile-level-id': profile}}))];
    const h = relayHarness(t, {stream: {getTracks: () => tracks}, codecs,
        failProduce(options) { if (options.codec?.mimeType === 'video/H264') throw new Error('H264 unavailable'); }});
    await h.peer.start();
    assert.deepEqual(h.produced.map(options => options.codec?.parameters?.['profile-level-id'] || options.track.kind),
        ['42001f', '42e01f', 'video', 'audio']);
    assert.equal(h.commands.filter(message => message.action === 'retry-video').length, 2);
    assert.deepEqual(h.transports.map(transport => transport.closed), [true, true, false]);
    assert.equal(h.commands.at(-1).action, 'ready');
    assert.ok(h.produced.every(options => options.stopTracks === false));
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
    assert.deepEqual(h.produced[0].encodings, [{maxBitrate: 6_000_000, maxFramerate: 60}]);
    assert.deepEqual(h.commands.map(message => message.action), ['connect', 'produce', 'produce', 'ready']);
    assert.ok(h.commands.every(message => message.itemId === 'desktop' && message.peerId === 'peer' && message.requestId === 'capture'));
});

test('native publisher applies bounded quality, selected codecs and Opus mix settings', async t => {
    const tracks = ['video', 'audio'].map(kind => ({kind, readyState: 'live'}));
    const h = relayHarness(t, {stream: {getTracks: () => tracks}, codecs: videoCodecs,
        quality: {videoBitrate: 2_500_000, frameRate: 30, audioBitrate: 64000, codec: 'vp8', stereo: false, dtx: true}});
    await h.peer.start();
    assert.equal(h.produced[0].codec.mimeType, 'video/VP8');
    assert.deepEqual(h.produced[0].encodings, [{maxBitrate: 2_500_000, maxFramerate: 30}]);
    assert.equal(h.produced[1].codecOptions.opusMaxAverageBitrate, 64000);
    assert.equal(h.produced[1].codecOptions.opusStereo, false);
    assert.equal(h.produced[1].codecOptions.opusDtx, true);
});

test('native publisher-only mode retains local lifecycle without subscribing to other desktops', async t => {
    const quality = {contentHint: 'text', frameRate: 30};
    const h = fixture(t, {watchRemote: false, quality: () => quality});
    h.current('other-desktop');
    assert.equal(h.commands.length, 0);
    await h.share.start(); h.accept(); await flush();
    assert.equal(h.peers[0].quality, quality);
    assert.equal(h.tracks[0].contentHint, 'text');
    assert.equal(playback(h.share).local, true);
    assert.equal(h.commands.some(command => command.type === 'desktop:watch'), false);
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

test('receivers reserve audio jitter headroom and keep both tracks in the same synchronized stream', async t => {
    const h = relayHarness(t);
    h.connection.producers.push({id: 'video', kind: 'video'}, {id: 'audio', kind: 'audio'});
    await h.peer.start();
    h.client.desktopMessages.set({type: 'desktop:available', requestId: 'capture', producers: h.connection.producers});
    await flush();
    assert.deepEqual(h.consumed.map(value => [value.kind, value.rtpReceiver.jitterBufferTarget]),
        [['audio', 100], ['video', 0]]);
    assert.ok(h.consumed.every(value => value.streamId === h.connection.itemId));
    assert.deepEqual(h.received().getTracks().map(track => track.kind), ['audio', 'video']);
});

test('Spotify watches start audio only and retain a local video choice through retries and song changes', async t => {
    const h = fixture(t);
    const setSpotify = title => h.client.state.set({joined: true, status: 'connected', room: {id: 'lobby',
        current: {id: title, kind: 'spotify'}, desktops: [{id: 'desktop', provider: 'spotify', title}]}});
    const acceptWatch = () => h.client.desktopMessages.set({...h.commands.at(-1), type: 'desktop:watching', peerId: 'viewer'});
    setSpotify('first'); acceptWatch();
    assert.equal(h.peers[0].videoEnabled, false);
    h.share.setVideoEnabled('desktop', true);
    assert.equal(h.peers[0].videoEnabled, true);
    setSpotify('second');
    assert.equal(h.peers.length, 1);
    h.share.retryView('desktop'); acceptWatch();
    assert.equal(h.peers[1].videoEnabled, true);
    h.peers[1].onVideoError('Video unavailable');
    assert.equal(playback(h.share).error, '');
    assert.equal(playback(h.share).videoError, 'Video unavailable');
    h.share.retryVideo('desktop');
    assert.equal(h.peers[1].closed, false);
    assert.equal(h.peers.length, 2);
    h.share.setVideoEnabled('desktop', false);
    h.share.retryView('desktop'); acceptWatch();
    assert.equal(h.peers[2].videoEnabled, false);
    h.peers[1].onVideoError('Stale error');
    assert.equal(playback(h.share).videoError, '');
});

test('video is lazy, pauses at the relay and resumes without replacing any audio resource', async t => {
    const h = relayHarness(t, {videoEnabled: false});
    h.connection.producers.push({id: 'video', kind: 'video'}, {id: 'audio', kind: 'audio'});
    await h.peer.start();
    h.client.desktopMessages.set({type: 'desktop:available', requestId: 'capture', producers: h.connection.producers});
    await flush();
    const stream = h.received(), audio = h.consumed[0], transport = h.transport;
    assert.deepEqual(stream.getTracks().map(track => track.kind), ['audio']);
    assert.deepEqual(h.commands.map(command => command.producerId || command.consumerId), ['audio', 'audio-consumer']);
    await h.peer.setVideoEnabled(true);
    const video = h.consumed[1];
    await h.peer.setVideoEnabled(false);
    assert.equal(video.paused, true);
    assert.equal(h.commands.at(-1).action, 'pause-video');
    await h.peer.setVideoEnabled(true);
    assert.equal(video.paused, false);
    assert.equal(h.commands.at(-1).action, 'resume');
    assert.equal(h.consumed.length, 2);
    assert.equal(h.received(), stream);
    assert.equal(h.transport, transport);
    assert.equal(stream.getTracks()[0], audio.track);
    assert.equal(audio.track.stopped, false);
    assert.equal(h.commands.filter(command => command.consumerId === audio.id).length, 1, 'Audio is only resumed once');
});

test('rapid view changes during video negotiation settle on the latest choice without resuming hidden video', async t => {
    const pending = Promise.withResolvers();
    const h = relayHarness(t, {videoEnabled: false, beforeConsume: options => options.kind === 'video' ? pending.promise : undefined});
    h.connection.producers.push({id: 'audio', kind: 'audio'}, {id: 'video', kind: 'video'});
    h.client.desktopMessages.set({type: 'desktop:available', requestId: 'capture', producers: h.connection.producers});
    await h.peer.start();
    const first = h.peer.setVideoEnabled(true);
    await flush();
    const changes = [h.peer.setVideoEnabled(false), h.peer.setVideoEnabled(true), h.peer.setVideoEnabled(false)];
    pending.resolve();
    await Promise.all([first, ...changes]);
    assert.equal(h.consumed[1].paused, true);
    assert.equal(h.commands.some(command => command.action === 'resume' && command.consumerId === 'video-consumer'), false);
    assert.equal(h.consumed[0].track.stopped, false);
    await h.peer.setVideoEnabled(true);
    assert.equal(h.consumed[1].paused, false);
});

test('failed video requests can retry independently while audio and the transport stay alive', async t => {
    let failing = 'consume';
    const h = relayHarness(t, {videoEnabled: false, rpcError: message =>
        (message.producerId === 'video' || message.consumerId === 'video-consumer') && message.action === failing ? 'Video failed' : ''});
    h.connection.producers.push({id: 'video', kind: 'video'}, {id: 'audio', kind: 'audio'});
    h.client.desktopMessages.set({type: 'desktop:available', requestId: 'capture', producers: h.connection.producers});
    await h.peer.start();
    const audio = h.consumed[0];
    await h.peer.setVideoEnabled(true);
    assert.equal(h.videoErrors.at(-1), 'Video failed');
    failing = 'resume';
    await h.peer.setVideoEnabled(true);
    assert.equal(h.videoErrors.at(-1), 'Video failed');
    failing = '';
    await h.peer.setVideoEnabled(true);
    assert.equal(h.videoErrors.at(-1), '');
    failing = 'pause-video';
    await h.peer.setVideoEnabled(false);
    assert.equal(h.videoErrors.at(-1), 'Video failed');
    failing = '';
    await h.peer.setVideoEnabled(false);
    assert.equal(h.videoErrors.at(-1), '');
    assert.equal(h.consumed.length, 2);
    assert.equal(h.transport.closed, false);
    assert.equal(audio.track.stopped, false);
    assert.equal(h.commands.filter(command => command.consumerId === audio.id).length, 1);
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
