import test from 'node:test';
import assert from 'node:assert/strict';
import {createStrifeEmbed, embedConfiguration} from '../src/lib/strife-embed.js';
import {start, until} from './helpers.js';

test('desktop embed validates parent and isolates room credentials from stale requests', async () => {
    for (const parent of ['https://evil.test', 'http://127.0.0.1:1234/path', 'http://user@localhost:1234'])
        assert.equal(embedConfiguration({hash: '#parent=' + encodeURIComponent(parent) + '&session=test'}), null);
    const events = [], calls = []; let receive, finish;
    const parent = {postMessage: (data, origin) => events.push({data, origin})};
    const win = {parent, location: {hash: '#parent=http%3A%2F%2F127.0.0.1%3A1234&session=test'},
        addEventListener: (type, callback) => { if (type === 'message') receive = callback; }, removeEventListener() {}};
    const host = createStrifeEmbed({enabled: true, windowTarget: win, join: id => calls.push(id), playback() {},
        request: (path, options) => { calls.push([path, options]); return options.method === 'POST' ? new Promise(resolve => finish = resolve) : Promise.resolve({ok: true}); }});
    const send = (data, origin = 'http://127.0.0.1:1234', source = parent) => receive({origin, source,
        data: {channel: 'helltube.strife', version: 1, session: 'test', connection: 'connection', ...data}});
    host.setContext({userId: 'user', room: {id: 'lobby', name: 'Lobby'}, rooms: [{id: 'lobby', name: 'Lobby'}], connected: true});
    await send({type: 'hello', nativeShare: true}, 'http://evil.test');
    host.start(); assert.equal(events.length, 0);
    await send({type: 'hello', nativeShare: true}, undefined, {});
    host.start(); assert.equal(events.length, 0);
    await send({type: 'hello', nativeShare: true}); host.start();
    const share = events.at(-1).data.share;
    assert.ok(share.id);
    const pending = send({type: 'command', id: 'issue', action: 'credential', shareId: share.id});
    await send({type: 'command', id: 'issue', action: 'credential', shareId: share.id});
    assert.equal(calls.length, 1, 'replayed command cannot mint another credential');
    host.setContext({userId: 'user', room: null, rooms: [], connected: false});
    finish({token: 'a'.repeat(64), path: '/api/whip/lobby', expires: Date.now() + 60000});
    await pending;
    assert.ok(calls.some(c => Array.isArray(c) && c[1].method === 'DELETE'), 'stale credential revoked');
    assert.equal(events.some(e => e.data.credential), false, 'stale credential never reaches parent');
    await send({type: 'command', connection: 'old', id: 'old', action: 'selectRoom', roomId: 'lobby'});
    assert.equal(calls.includes('lobby'), false);
    host.dispose();
});

test('Strife publishing tokens coexist with OBS and conditional revocation cannot stop a replacement', async t => {
    const h = await start(t, {ffmpeg: 'missing-test-ffmpeg', ytdlp: 'missing-test-ytdlp'});
    assert.equal((await h.api('/api/rooms/lobby/strife-token', {method: 'POST'})).status, 403);
    const ws = await h.connect(); ws.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => h.instance.rooms.get('lobby').members.size);
    const obs = (await h.api('/api/rooms/lobby/obs-token', {method: 'POST'})).data;
    const first = (await h.api('/api/rooms/lobby/strife-token', {method: 'POST'})).data;
    const second = (await h.api('/api/rooms/lobby/strife-token', {method: 'POST'})).data;
    const status = async token => (await fetch(h.url + '/api/whip/lobby', {headers: {Authorization: 'Bearer ' + token}})).status;
    assert.equal(await status(obs.token), 204);
    assert.equal(await status(first.token), 401);
    await h.api('/api/rooms/lobby/strife-token', {method: 'DELETE', body: {token: first.token}});
    assert.equal(await status(second.token), 204);
    await h.api('/api/rooms/lobby/obs-token', {method: 'DELETE'});
    assert.equal(await status(second.token), 204);
    await h.api('/api/rooms/lobby/strife-token', {method: 'DELETE', body: {token: second.token}});
    assert.equal(await status(second.token), 401);
});
