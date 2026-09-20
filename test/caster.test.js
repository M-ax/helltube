import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {frontendOrigin, CasterConnection} from '../apps/caster/main/connection.js';
import {pulseSources} from '../apps/caster/main/audio.js';
import {PcmQueue} from '../apps/caster/renderer/pcm-worklet.js';
import {normalizeDesktopQuality, cropRectangle, casterPresets} from '../shared/desktop-quality.js';
import {start, until} from './helpers.js';

test('caster clamps invalid and excessive quality settings to the desktop relay budget', () => {
    const quality = normalizeDesktopQuality({width: 8000, height: 4000, frameRate: 240, videoBitrate: 90_000_000,
        audioBitrate: 900_000, codec: 'av1', degradationPreference: 'invalid', contentHint: 'invalid'});
    assert.deepEqual([quality.width, quality.height, quality.frameRate, quality.videoBitrate, quality.audioBitrate], [1920, 1080, 60, 6_000_000, 128_000]);
    assert.equal(quality.codec, 'auto');
    assert.equal(quality.degradationPreference, 'balanced');
    assert.equal(quality.contentHint, 'motion');
    const low = normalizeDesktopQuality({width: -2, height: 0, frameRate: -1, videoBitrate: -1, audioBitrate: -1});
    assert.deepEqual([low.width, low.height, low.frameRate, low.videoBitrate, low.audioBitrate], [320, 180, 10, 300_000, 32_000]);
    assert.equal(normalizeDesktopQuality({videoBitrate: NaN}).videoBitrate, 6_000_000);
    for (const preset of Object.values(casterPresets)) for (const [key, value] of Object.entries(preset)) assert.equal(normalizeDesktopQuality(preset)[key], value);
});

test('region crop stays inside resized and portrait sources without DPI assumptions', () => {
    assert.deepEqual(cropRectangle({x: .25, y: .25, width: .5, height: .5}, 1920, 1080), {x: 480, y: 270, width: 960, height: 540});
    const rect = cropRectangle({x: .9, y: .8, width: .7, height: 2}, 1080, 1920);
    assert.equal(rect.x + rect.width, 1080); assert.equal(rect.y + rect.height, 1920);
    assert.deepEqual(cropRectangle(null, 640, 360), {x: 0, y: 0, width: 640, height: 360});
});

test('frontend authentication rejects insecure remote origins, embedded credentials and URL paths', () => {
    for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'https://me:secret@example.com', 'https://example.com/api',
        'https://example.com?next=evil', 'https://example.com#fragment', 'http://example.com', 'localhost']) {
        assert.throws(() => frontendOrigin(url));
    }
    assert.equal(frontendOrigin('https://example.com/'), 'https://example.com');
    assert.equal(frontendOrigin('http://localhost:5173'), 'http://localhost:5173');
    assert.equal(frontendOrigin('http://[::1]:3000/'), 'http://[::1]:3000');
});

test('PulseAudio application selections bind a sink input to its own monitor, without changing routing', () => {
    const sources = pulseSources([
        {index: 7, sink: 3, properties: {'application.name': 'Music', 'media.name': 'Song', 'application.process.id': '321'}},
        {index: 8, sink: 9, properties: {'application.name': 'Disconnected'}},
    ], [{index: 3, name: 'headphones', description: 'Headphones', monitor_source: 'headphones.monitor'}]);
    assert.equal(sources.length, 2);
    assert.deepEqual(sources[0], {id: 'pulse:7', index: 7, pid: '321', kind: 'application', label: 'Music', detail: 'Song', device: 'headphones.monitor'});
    assert.equal(sources[1].kind, 'system');
});

test('native PCM preserves stereo, bounds latency, handles partial packets and re-primes after silence', () => {
    const queue = new PcmQueue(2048);
    const bytes = new Uint8Array(2000 * 4 + 1), data = new DataView(bytes.buffer);
    for (let frame = 0; frame < 2000; frame++) { data.setInt16(frame * 4, 16384, true); data.setInt16(frame * 4 + 2, -16384, true); }
    queue.push(bytes);
    const left = new Float32Array(128), right = new Float32Array(128);
    queue.pull(left, right);
    assert.ok(left.every(value => value === .5)); assert.ok(right.every(value => value === -.5));
    for (let i = 0; i < 20; i++) queue.pull(left, right);
    assert.ok(left.every(value => value === 0)); assert.equal(queue.primed, false);
    for (let i = 0; i < 50; i++) queue.push(bytes);
    assert.equal(queue.size, 2048);
    queue.pull(left, right); assert.equal(left[0], .5);
});

test('native login, authenticated room signaling, share reservation and logout use the existing protocol', {timeout: 30000}, async t => {
    const {instance, url} = await start(t, {ffmpeg: 'missing-caster-test', desktopIceServers: '[]'});
    const connection = new CasterConnection(), events = [];
    t.after(() => connection.disconnect());
    connection.on('event', event => events.push(event));
    await assert.rejects(connection.login({url, username: 'admin', password: 'incorrect'}), /Invalid username/);
    const login = await connection.login({url, username: 'admin', password: 'garbageTime_'});
    assert.equal(login.user.username, 'admin');
    assert.equal(Object.hasOwn(login, 'cookie'), false);
    await until(() => events.some(event => event.type === 'rooms'));
    assert.equal(connection.send({type: 'join', roomId: 'lobby'}), true);
    await until(() => events.some(event => event.type === 'state' && event.room.id === 'lobby'));
    connection.send({type: 'desktop:start', transport: 'mediasoup', requestId: 'caster-share', audio: true});
    const started = await until(() => events.find(event => event.type === 'desktop:started'));
    assert.equal(started.requestId, 'caster-share');
    assert.ok(started.routerRtpCapabilities.codecs.some(codec => codec.mimeType === 'audio/opus'));
    const cookie = connection.cookie;
    assert.ok(instance.accounts.authenticate(cookie));
    await connection.logout();
    assert.equal(instance.accounts.authenticate(cookie), null);
    assert.equal(connection.send({type: 'join', roomId: 'lobby'}), false);
    await until(() => instance.rooms.get('lobby').desktops.length === 0);
});

test('cancelled login revokes its late session instead of reopening a socket', async () => {
    let resolve;
    const pending = new Promise(done => resolve = done), requests = [];
    class Socket extends EventEmitter { constructor() { super(); assert.fail('A cancelled login must not open a socket.'); } }
    const connection = new CasterConnection({Socket, fetcher: async (url, options) => {
        requests.push({url, options});
        if (url.endsWith('/api/login')) return pending;
        return new Response('{}', {status: 200});
    }});
    const login = connection.login({url: 'https://example.com', username: 'admin', password: 'secret'});
    await new Promise(done => setImmediate(done));
    connection.disconnect();
    resolve(new Response(JSON.stringify({user: {username: 'admin'}}), {headers: {'Set-Cookie': `session=${'a'.repeat(64)}; HttpOnly; Path=/`}}));
    await assert.rejects(login, /cancelled/);
    assert.equal(requests.at(-1).url, 'https://example.com/api/logout');
    assert.equal(requests.at(-1).options.redirect, 'error');
});
