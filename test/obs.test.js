import test from 'node:test';
import assert from 'node:assert/strict';
import sdp from 'sdp-transform';
import {start, until} from './helpers.js';
import {obsOffer} from './fixtures/obs-offer.js';
import {makeItem} from '../server/rooms.js';
import {ObsStreams} from '../server/obs.js';
import {createWorker} from '../worker.js';

async function setup(t, options = {}) {
    const h = await start(t, {ffmpeg: 'missing-obs-test', ytdlp: 'missing-obs-test', ...options});
    const socket = await h.connect();
    socket.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => h.instance.rooms.get('lobby').members.size);
    const create = () => h.api('/api/rooms/lobby/obs-token', {method: 'POST'});
    const {data, status} = await create();
    assert.equal(status, 201);
    const request = (path = data.path, {token = data.token, method = 'POST', body = obsOffer(), headers = {}} = {}) =>
        fetch(h.url + path, {method, headers: {'Content-Type': 'application/sdp', Authorization: `Bearer ${token}`, ...headers},
            ...(method === 'POST' || method === 'PATCH' ? {body} : {})});
    return {...h, socket, create, credentials: data, request};
}

test('OBS tokens require room membership, are scoped, hashed, persisted and replaceable', async t => {
    const h = await start(t, {ffmpeg: 'missing-obs-test', ytdlp: 'missing-obs-test'});
    assert.equal((await h.api('/api/rooms/lobby/obs-token', {method: 'POST', auth: ''})).status, 401);
    assert.equal((await h.api('/api/rooms/lobby/obs-token', {method: 'POST'})).status, 403);
    const socket = await h.connect();
    socket.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => h.instance.rooms.get('lobby').members.size);
    const first = (await h.api('/api/rooms/lobby/obs-token', {method: 'POST'})).data;
    assert.equal(h.instance.store.load('obs-keys').length, 1);
    assert.ok(!JSON.stringify(h.instance.store.load('obs-keys')).includes(first.token));
    const restored = new ObsStreams({...h.instance, rtcConfig: () => ({iceServers: []})});
    assert.equal(restored.authenticate(`Bearer ${first.token}`, 'lobby').roomId, 'lobby');
    assert.throws(() => restored.authenticate(`Bearer ${first.token}`, 'the-ben-zone'), {status: 403});
    assert.throws(() => restored.authenticate(`Bearer ${h.cookie.slice(8)}`, 'lobby'), {status: 401});
    const second = (await h.api('/api/rooms/lobby/obs-token', {method: 'POST'})).data;
    assert.notEqual(second.token, first.token);
    assert.throws(() => h.instance.obs.authenticate(`Bearer ${first.token}`, 'lobby'), {status: 401});
    assert.equal((await h.api('/api/rooms/lobby/obs-token', {method: 'DELETE'})).status, 200);
    assert.throws(() => h.instance.obs.authenticate(`Bearer ${second.token}`, 'lobby'), {status: 401});
    assert.equal(h.instance.store.load('obs-keys').length, 0);
});

test('WHIP negotiates H264/Opus through the native relay and DELETE resumes the queue', async t => {
    const h = await setup(t);
    const room = h.instance.rooms.get('lobby');
    const video = makeItem({kind: 'http', url: 'https://example.com/movie.mp4'});
    h.instance.rooms.add(room, [video]);
    h.instance.rooms.stamp(room, 27, true);
    const response = await h.request();
    assert.equal(response.status, 201, await response.clone().text());
    const answer = sdp.parse(await response.text());
    assert.equal(answer.icelite, 'ice-lite');
    assert.equal(answer.media.length, 2);
    assert.ok(answer.media.every(m => m.direction === 'recvonly' && m.setup === 'passive' && m.candidates.length));
    assert.ok(answer.media[1].fmtp[0].config.includes('profile-level-id=42e02a'));
    const session = [...h.instance.desktop.sessions.values()][0];
    assert.equal((await session.publisher.transport.getStats())[0].maxIncomingBitrate, 12_200_000);
    assert.equal(session.producers.size, 2);
    assert.equal(session.ready, undefined, 'Wait for the DTLS connection before declaring the stream ready');
    assert.equal(room.current.id, session.item.id);
    assert.equal(room.queue[0].id, video.id);
    assert.match(room.current.title, /OBS stream/);
    assert.equal((await h.request()).status, 409);
    const location = response.headers.get('location');
    assert.match(location, /^\/api\/whip\/lobby\//);
    assert.equal((await h.request(location, {method: 'GET'})).status, 204);
    const options = await h.request(undefined, {method: 'OPTIONS'});
    assert.equal(options.status, 200);
    assert.equal(options.headers.get('accept-post'), 'application/sdp');
    assert.equal((await h.request(location, {method: 'PATCH'})).status, 405);
    assert.equal((await h.request(location, {method: 'DELETE', token: '0'.repeat(64)})).status, 401);
    assert.equal((await h.request(location, {method: 'DELETE'})).status, 200);
    assert.equal(session.router.closed, true);
    assert.equal(session.publisher.transport.closed, true);
    assert.equal(room.current.id, video.id);
    assert.equal(room.playback.position, 27);
    assert.equal((await h.request(location, {method: 'DELETE'})).status, 404);
});

test('bad offers fail without interrupting room playback or leaking native resources', async t => {
    const h = await setup(t);
    const room = h.instance.rooms.get('lobby');
    const video = makeItem({kind: 'http', url: 'https://example.com/movie.mp4'});
    h.instance.rooms.add(room, [video]);
    for (const [body, status] of [['garbage', 400], [obsOffer({videoCodec: 'AV1'}), 406],
        [obsOffer().replace('a=rtcp-mux', ''), 400],
        [obsOffer().replace('a=group:BUNDLE audio video', 'a=group:BUNDLE audio'), 400],
        [obsOffer() + 'a=simulcast:send 1;2\r\n', 400],
        [obsOffer() + 'a=ssrc:9999 cname:other\r\n', 400]]) {
        const response = await h.request(undefined, {body});
        assert.equal(response.status, status, await response.text());
        assert.equal(h.instance.desktop.sessions.size, 0);
        assert.equal(h.instance.obs.resources.size, 0);
        assert.equal(room.current.id, video.id);
        assert.equal(room.queue.length, 0);
    }
    assert.equal((await h.request(undefined, {headers: {'Content-Type': 'text/plain'}})).status, 415);
    assert.equal((await h.request(undefined, {body: 'x'.repeat(65537)})).status, 413);
});

test('independent OBS publishers cannot stop each other and can restart after a room skip', async t => {
    const h = await setup(t);
    const {user, token} = await h.instance.accounts.login('admin', 'garbageTime_');
    const otherUser = await h.instance.accounts.create({username: 'obs_other', password: 'other-password-123'});
    const otherAuth = h.instance.accounts.createSession(otherUser);
    const otherKey = h.instance.obs.issue(otherAuth, h.instance.rooms.get('lobby'));
    const first = await h.request();
    const second = await h.request(undefined, {token: otherKey.token});
    assert.equal(first.status, 201);
    assert.equal(second.status, 201);
    assert.equal(h.instance.rooms.get('lobby').desktops.length, 2);
    assert.equal((await h.request(first.headers.get('location'), {method: 'DELETE', token: otherKey.token})).status, 404);
    h.instance.obs.revoke(user.id, 'lobby');
    assert.equal(h.instance.rooms.get('lobby').desktops.length, 1);
    assert.equal(h.instance.desktop.sessions.size, 1);
    h.instance.rooms.advance(h.instance.rooms.get('lobby'));
    assert.equal((await h.request(undefined, {token: otherKey.token})).status, 201);
    h.instance.accounts.logout(token);
});

test('token revocation during native transport creation cannot publish a late stream', async t => {
    const h = await setup(t);
    const relay = h.instance.desktop.relay;
    const original = relay.createTransport.bind(relay);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    let reached = false;
    relay.createTransport = async router => { reached = true; await gate; return original(router); };
    const key = h.instance.obs.authenticate(`Bearer ${h.credentials.token}`, 'lobby');
    const publishing = h.instance.obs.publish(key, obsOffer());
    const failed = assert.rejects(publishing);
    await until(() => reached);
    h.instance.obs.revoke(key.userId, 'lobby');
    release();
    await failed;
    assert.equal(h.instance.desktop.sessions.size, 0);
    assert.equal(h.instance.obs.resources.size, 0);
    assert.equal(h.instance.rooms.get('lobby').desktops.length, 0);
    await assert.rejects(h.instance.obs.publish(key, obsOffer()), {status: 401});
});

test('a cancelled startup cannot stop a replacement publisher using the same token', async t => {
    const h = await setup(t);
    const relay = h.instance.desktop.relay;
    const original = relay.createRouter.bind(relay);
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    relay.createRouter = async options => { await gate; return original(options); };
    const key = h.instance.obs.authenticate(`Bearer ${h.credentials.token}`, 'lobby');
    const failed = assert.rejects(h.instance.obs.publish(key, obsOffer()));
    const old = [...h.instance.desktop.sessions.values()][0];
    h.instance.desktop.stop(old.ws);
    relay.createRouter = original;
    const replacement = await h.instance.obs.publish(key, obsOffer());
    const session = [...h.instance.desktop.sessions.values()][0];
    release();
    await failed;
    assert.equal(h.instance.desktop.sessions.get(session.ws.id), session);
    assert.equal(session.router.closed, false);
    assert.equal(h.instance.obs.resources.has(replacement.id), true);
});

test('OBS video-only streams clean up on revocation, logout, timeout, skip and room deletion', async t => {
    for (const reason of ['replace', 'revoke', 'logout', 'timeout', 'skip', 'delete']) {
        await t.test(reason, async t => {
            const h = await setup(t);
            const response = await h.request(undefined, {body: obsOffer({audio: false})});
            assert.equal(response.status, 201, await response.text());
            const session = [...h.instance.desktop.sessions.values()][0];
            assert.equal(session.producers.size, 1);
            if (reason === 'replace') await h.create();
            if (reason === 'revoke') await h.api('/api/rooms/lobby/obs-token', {method: 'DELETE'});
            if (reason === 'logout') await h.api('/api/logout', {method: 'POST'});
            if (reason === 'timeout') { session.started -= 31000; h.instance.desktop.tick(); }
            if (reason === 'skip') h.instance.rooms.advance(session.room);
            if (reason === 'delete') h.instance.rooms.remove(session.room.id, {role: 'admin'});
            h.instance.obs.tick();
            assert.equal(h.instance.desktop.sessions.size, 0);
            assert.equal(h.instance.obs.resources.size, 0);
            assert.equal(session.router.closed, true);
        });
    }
});

test('Worker forwards WHIP authorization, SDP, Location and TURN links without caching', async t => {
    const secret = 'w'.repeat(32);
    const h = await setup(t, {edgeProxySecret: secret,
        desktopIceServers: JSON.stringify([{urls: 'turn:relay.example.test:3478'}]), desktopTurnSecret: 'test-turn-secret'});
    const worker = createWorker({fetch: request => fetch(request)});
    const env = {BARE_METAL_ORIGIN: h.url, EDGE_PROXY_SECRET: secret};
    const response = await worker.fetch(new Request(`https://watch.example.test${h.credentials.path}`, {
        method: 'POST', headers: {Authorization: `Bearer ${h.credentials.token}`, 'Content-Type': 'application/sdp'}, body: obsOffer()}), env);
    assert.equal(response.status, 201, await response.clone().text());
    assert.match(response.headers.get('cache-control'), /no-store/);
    assert.match(response.headers.get('link'), /turn:relay.example.test/);
    assert.ok(!response.headers.get('link').includes('test-turn-secret'));
    const stopped = await worker.fetch(new Request(`https://watch.example.test${response.headers.get('location')}`, {
        method: 'DELETE', headers: {Authorization: `Bearer ${h.credentials.token}`}}), env);
    assert.equal(stopped.status, 200);
});
