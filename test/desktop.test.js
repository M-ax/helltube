import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID, createHmac} from 'node:crypto';
import {DesktopShares} from '../server/desktop.js';
import {DesktopRelay, desktopRelayOptions} from '../server/desktop-relay.js';
import {Rooms, makeItem} from '../server/rooms.js';
import {desktopRtcConfig} from '../server/desktop-config.js';
import {start, until} from './helpers.js';

const request = {requestId: 'capture-1', transport: 'mediasoup', audio: true};

function fixture(t, relay) {
    let now = 1000;
    const rooms = new Rooms({now: () => now});
    const messages = [];
    const desktop = new DesktopShares(rooms, (ws, message) => messages.push({ws, ...message}),
        {now: () => now, config: {desktopPort: 0}, relay});
    const ws = {id: 'sender'}, user = {id: 'user', displayName: 'Viewer'}, room = rooms.get('lobby');
    t.after(() => desktop.close());
    const rpc = async (socket, connection, action, extra = {}) => {
        const rpcId = randomUUID();
        await desktop.request(room, socket, {itemId: room.current.id, requestId: connection.requestId,
            peerId: connection.peerId, rpcId, action, ...extra});
        return messages.find(message => message.rpcId === rpcId).data;
    };
    return {rooms, room, desktop, ws, user, messages, rpc, advance: ms => now += ms};
}
function rtp(session) {
    const codec = session.router.rtpCapabilities.codecs.find(codec => codec.mimeType === 'video/VP8');
    return {codecs: [{mimeType: codec.mimeType, payloadType: codec.preferredPayloadType, clockRate: codec.clockRate,
        parameters: codec.parameters, rtcpFeedback: codec.rtcpFeedback}], encodings: [{ssrc: 12345678}], rtcp: {cname: 'desktop'}};
}
async function publish(h) {
    await h.desktop.start(h.room, h.ws, h.user, request);
    const connection = h.messages.find(message => message.type === 'desktop:started');
    const session = h.desktop.sessions.get(h.ws.id);
    const producer = await h.rpc(h.ws, connection, 'produce', {kind: 'video', rtpParameters: rtp(session)});
    await h.rpc(h.ws, connection, 'ready');
    return {session, connection, producer};
}

test('metal sharing interrupts and resumes video, never enters history, and disallows seek/pause/replay', async t => {
    const h = fixture(t);
    const video = makeItem({kind: 'http', url: 'https://example.com/video.mp4'}, {duration: 100});
    h.rooms.add(h.room, [video]);
    h.rooms.stamp(h.room, 25, true);
    const {session} = await publish(h);
    assert.equal(h.room.current.transport, 'mediasoup');
    assert.equal(h.room.queue[0].id, video.id);
    for (const action of ['pause', 'play', 'seek', 'previous']) {
        assert.throws(() => h.rooms.control(h.room, {action, revision: h.room.playback.revision, position: 0}), /live/);
    }
    assert.throws(() => h.rooms.replay(h.room, video.id), /Stop desktop/);
    h.advance(90000); h.desktop.tick(); h.rooms.tick();
    assert.equal(h.room.playback.paused, false);
    assert.equal(h.rooms.position(h.room), 90);
    assert.equal(h.room.current.media, null);
    h.desktop.stop(h.ws);
    assert.equal(h.room.current.id, video.id);
    assert.equal(h.room.playback.position, 25);
    assert.equal(h.room.history.length, 0);
    assert.equal(session.router.closed, true);
    assert.equal(session.publisher.transport.closed, true);
});

test('only one share can start per room and legacy direct sharing is rejected', async t => {
    const h = fixture(t);
    await assert.rejects(h.desktop.start(h.room, h.ws, h.user, {...request, transport: 'webrtc'}), /Reload/);
    const starting = h.desktop.start(h.room, h.ws, h.user, request);
    await assert.rejects(h.desktop.start(h.room, {id: 'another'}, h.user, request), /already/);
    await starting;
    h.desktop.stop({id: 'another'});
    assert.equal(h.desktop.sessions.size, 1);
});

test('timeout, skip, deletion and source failure release all native resources', async t => {
    for (const cause of ['timeout', 'skip', 'delete', 'error']) {
        const h = fixture(t);
        const {session} = await publish(h);
        await h.desktop.watch(h.room, {id: 'viewer'}, {requestId: 'watch-1', itemId: session.item.id});
        const viewer = [...session.viewers.values()][0];
        if (cause === 'timeout') { h.advance(4 * 60 * 60 * 1000 + 1); h.desktop.tick(); }
        if (cause === 'skip') h.rooms.advance(h.room);
        if (cause === 'delete') h.rooms.remove(h.room.id, {role: 'admin'});
        if (cause === 'error') { h.room.current.status = 'error'; h.room.current.error = 'Capture failed'; h.rooms.emit('state', h.room); }
        assert.equal(h.desktop.sessions.size, 0, cause);
        assert.equal(viewer.transport.closed, true, cause);
        assert.equal(session.router.closed, true, cause);
        assert.ok(h.messages.some(message => message.type === 'desktop:stopped' && message.requestId === 'watch-1'), cause);
    }
});

test('capture persists only the interrupted video and unready publishers time out', async t => {
    const h = fixture(t);
    const item = makeItem({kind: 'upload', complete: true}, {duration: 100});
    h.rooms.add(h.room, [item]);
    h.rooms.stamp(h.room, 37, true);
    let saved;
    h.rooms.store = {save: (_type, _id, value) => saved = value};
    await h.desktop.start(h.room, h.ws, h.user, request);
    assert.equal(saved.current.id, item.id);
    assert.equal(saved.playback.position, 37);
    assert.deepEqual(saved.queue, []);
    h.advance(31000); h.desktop.tick();
    assert.equal(h.desktop.sessions.size, 0);
    assert.equal(h.room.current.id, item.id);
});

test('one producer feeds multiple metal consumers; viewers cannot publish or access another connection', async t => {
    const h = fixture(t);
    const {session, connection, producer} = await publish(h);
    const itemId = h.room.current.id;
    const viewers = [{id: 'viewer-1'}, {id: 'viewer-2'}];
    for (const viewer of viewers) {
        await h.desktop.watch(h.room, viewer, {itemId, requestId: viewer.id});
        const viewing = h.messages.find(message => message.type === 'desktop:watching' && message.ws === viewer);
        await assert.rejects(h.rpc(viewer, viewing, 'produce', {kind: 'video', rtpParameters: rtp(session)}), /Only the sharer/);
        const consumer = await h.rpc(viewer, viewing, 'consume', {producerId: producer.id, rtpCapabilities: session.router.rtpCapabilities});
        const nativeConsumer = session.viewers.get(viewing.peerId).consumers.get(consumer.id);
        assert.equal(nativeConsumer.paused, true);
        await h.rpc(viewer, viewing, 'resume', {consumerId: consumer.id});
        assert.equal(nativeConsumer.paused, false);
        await assert.rejects(h.rpc(viewer, viewing, 'consume', {producerId: 'foreign', rtpCapabilities: session.router.rtpCapabilities}), /cannot be played/);
        await assert.rejects(h.rpc({id: 'intruder'}, viewing, 'resume', {consumerId: consumer.id}), /not authorized/);
        await assert.rejects(h.rpc(viewer, {...viewing, requestId: 'old'}, 'restart-ice'), /not authorized/);
        const transport = session.viewers.get(viewing.peerId).transport;
        h.desktop.unwatch(viewer, 'stale');
        assert.equal(transport.closed, false);
    }
    assert.equal(session.producers.size, 1);
    assert.equal((await session.router.dump()).transportIds.length, 3);
    await assert.rejects(h.rpc(h.ws, connection, 'produce', {kind: 'video', rtpParameters: rtp(session)}), /one video/);
    const otherRoom = h.rooms.create('Other');
    await assert.rejects(h.desktop.request(otherRoom, h.ws, {itemId, rpcId: 'rpc-1'}), /ended/);
    const firstConnection = h.messages.find(message => message.type === 'desktop:watching');
    const firstTransport = session.viewers.get(firstConnection.peerId).transport;
    h.desktop.leave(viewers[0]);
    assert.equal(firstTransport.closed, true);
    assert.equal(session.publisher.transport.closed, false);
    assert.equal(session.viewers.size, 1);
    await assert.rejects(h.rpc(viewers[0], firstConnection, 'restart-ice'), /not authorized/);
});

test('subscriptions are bounded and reconnecting closes the old transport without changing the uplink', async t => {
    const h = fixture(t);
    h.desktop.maxViewers = 1;
    const {session} = await publish(h);
    const itemId = session.item.id, viewer = {id: 'viewer'};
    await h.desktop.watch(h.room, viewer, {itemId, requestId: 'first'});
    const first = [...session.viewers.values()][0];
    await assert.rejects(h.desktop.watch(h.room, {id: 'extra'}, {itemId, requestId: 'extra'}), /viewer limit/);
    const publisherId = session.publisher.transport.id;
    await h.desktop.watch(h.room, viewer, {itemId, requestId: 'second'});
    assert.equal(first.transport.closed, true);
    assert.notEqual(first.id, [...session.viewers.keys()][0]);
    assert.equal(session.publisher.transport.id, publisherId);
    assert.equal(session.viewers.size, 1);
});

test('cancelled startup closes late resources without stopping a newer share', async t => {
    const waiting = Promise.withResolvers();
    const native = new DesktopRelay(desktopRelayOptions({desktopPort: 0}));
    let calls = 0;
    const relay = {createRouter: async () => {
        const router = await native.createRouter();
        if (++calls === 1) { await waiting.promise; }
        return router;
    }, createTransport: router => native.createTransport(router), close: () => native.close()};
    const h = fixture(t, relay);
    const first = h.desktop.start(h.room, h.ws, h.user, request);
    const rejection = assert.rejects(first, /ended/);
    await until(() => calls === 1);
    h.desktop.stop(h.ws);
    await h.desktop.start(h.room, h.ws, h.user, {...request, requestId: 'new-capture'});
    waiting.resolve();
    await rejection;
    assert.equal(h.desktop.sessions.get(h.ws.id).requestId, 'new-capture');
    assert.equal(h.room.current.kind, 'desktop');
    assert.equal((await native.worker.dump()).routerIds.length, 1);
});

test('a failed native worker ends its shares and the next share starts a fresh worker', async t => {
    const h = fixture(t);
    await publish(h);
    const worker = h.desktop.relay.worker;
    worker.close();
    worker.emit('died', new Error('test failure'));
    assert.equal(h.desktop.sessions.size, 0);
    assert.equal(h.room.current, null);
    await h.desktop.start(h.room, h.ws, h.user, {...request, requestId: 'restart'});
    assert.notEqual(h.desktop.relay.worker, worker);
});

test('relay validates public listen settings and exposes only the configured metal address', async t => {
    for (const config of [{desktopListenIp: 'bad'}, {desktopListenIp: '0.0.0.0'}, {desktopPort: -1},
        {desktopPort: 65536}, {desktopAnnouncedAddress: 'https://metal.example:44444'}]) {
        assert.throws(() => desktopRelayOptions(config));
    }
    const relay = new DesktopRelay(desktopRelayOptions({desktopListenIp: '127.0.0.1', desktopAnnouncedAddress: 'metal.example', desktopPort: 0}));
    t.after(() => relay.close());
    const router = await relay.createRouter();
    const transport = await relay.createTransport(router);
    assert.equal(transport.iceCandidates.length, 2);
    assert.ok(transport.iceCandidates.every(candidate => candidate.address === 'metal.example'));
    assert.deepEqual(transport.iceCandidates.map(candidate => candidate.protocol), ['udp', 'tcp']);
});

test('TURN REST credentials are scoped and expire after the share limit; invalid configurations fail early', () => {
    const secret = 'test-secret';
    const factory = desktopRtcConfig({desktopIceServers: JSON.stringify([{urls: ['turn:relay.example:3478', 'turns:relay.example:5349']}]),
        desktopTurnSecret: secret, desktopIceTransportPolicy: 'relay'}, () => 1000000);
    const result = factory('connection-1');
    assert.equal(result.iceTransportPolicy, 'relay');
    const server = result.iceServers[0];
    assert.equal(server.username, '19000:connection-1');
    assert.equal(server.credential, createHmac('sha1', secret).update(server.username).digest('base64'));
    assert.notEqual(factory('connection-2').iceServers[0].credential, server.credential);
    assert.equal(JSON.stringify(result).includes(secret), false);
    for (const config of [{desktopIceServers: 'bad'}, {desktopIceServers: '{}'}, {desktopIceServers: '[{}]'},
        {desktopIceServers: '[{"urls":"https://relay.example"}]'}, {desktopIceServers: '[{"urls":"turn:relay.example"}]'},
        {desktopIceTransportPolicy: 'relay'}, {desktopIceTransportPolicy: 'invalid'}]) {
        assert.throws(() => desktopRtcConfig(config));
    }
});

test('real sockets authorize metal resources by room and revoke viewer transports on room changes', async t => {
    const h = await start(t, {ffmpeg: 'missing-ffmpeg-desktop-test'});
    const sender = await h.connect(), viewer = await h.connect(), outsider = await h.connect();
    sender.send(JSON.stringify({type: 'desktop:start', ...request}));
    await until(() => sender.messages.some(message => message.type === 'desktop:error'));
    const otherRoom = h.instance.rooms.create('Other');
    sender.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    viewer.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    outsider.send(JSON.stringify({type: 'join', roomId: otherRoom.id}));
    await until(() => h.instance.rooms.get('lobby').members.size === 2 && otherRoom.members.size === 1);
    sender.send(JSON.stringify({type: 'desktop:start', ...request}));
    const started = await until(() => sender.messages.find(message => message.type === 'desktop:started'));
    const watch = {type: 'desktop:watch', requestId: 'viewer-1', itemId: started.itemId};
    outsider.send(JSON.stringify(watch));
    await until(() => outsider.messages.some(message => message.type === 'desktop:error'));
    viewer.send(JSON.stringify(watch));
    const subscription = await until(() => viewer.messages.find(message => message.type === 'desktop:watching'));
    const session = [...h.instance.desktop.sessions.values()][0];
    const transport = session.viewers.get(subscription.peerId).transport;
    const rpc = {type: 'desktop:request', requestId: subscription.requestId, itemId: started.itemId,
        peerId: subscription.peerId, rpcId: 'restart-ice', action: 'restart-ice'};
    viewer.send(JSON.stringify(rpc));
    await until(() => viewer.messages.some(message => message.type === 'desktop:response'));
    assert.equal(outsider.messages.some(message => message.type === 'desktop:response'), false);
    viewer.send(JSON.stringify({type: 'join', roomId: otherRoom.id}));
    await until(() => transport.closed);
    viewer.send(JSON.stringify({...rpc, rpcId: 'old-request'}));
    await until(() => viewer.messages.some(message => message.rpcId === 'old-request' && message.type === 'desktop:error'));
    assert.equal(session.publisher.transport.closed, false);
    assert.equal(h.instance.media.jobs.size, 0);
    sender.close();
    await until(() => h.instance.desktop.sessions.size === 0);
    assert.equal(session.router.closed, true);
});
