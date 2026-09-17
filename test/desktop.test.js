import test from 'node:test';
import assert from 'node:assert/strict';
import {DesktopShares} from '../server/desktop.js';
import {Rooms, makeItem} from '../server/rooms.js';
import {start, until} from './helpers.js';

const request = {requestId: 'capture-1', mimeType: 'video/webm;codecs=vp8,opus', audio: true};

function fixture() {
    let now = 1000;
    const rooms = new Rooms({now: () => now});
    const media = {config: {maxTranscoders: 4}, jobs: new Map(), start(item, baseTime, input) {
        this.jobs.set(item.id, {item, input});
    }, dispose(job) { job.input.destroy(); this.jobs.delete(job.item.id); }};
    const messages = [];
    const desktop = new DesktopShares(rooms, media, (ws, message) => messages.push({ws, ...message}), () => now);
    const ws = {id: 'sender'}, user = {id: 'user', displayName: 'Viewer'}, room = rooms.get('lobby');
    return {rooms, room, media, desktop, ws, user, messages, advance: ms => now += ms};
}

test('live share interrupts and resumes a video, never enters history, and disallows seek/pause/replay', () => {
    const h = fixture();
    const video = makeItem({kind: 'http', url: 'https://example.com/video.mp4'}, {duration: 100});
    h.rooms.add(h.room, [video]);
    h.rooms.stamp(h.room, 25, true);
    h.desktop.start(h.room, h.ws, h.user, request);
    assert.equal(h.room.current.kind, 'desktop');
    assert.equal(h.room.queue[0].id, video.id);
    for (const action of ['pause', 'play', 'seek', 'previous']) {
        assert.throws(() => h.rooms.control(h.room, {action, revision: h.room.playback.revision, position: 0}), /live/);
    }
    assert.throws(() => h.rooms.replay(h.room, video.id), /Stop desktop/);
    h.desktop.stop(h.ws);
    assert.equal(h.room.current.id, video.id);
    assert.equal(h.room.playback.position, 25);
    assert.equal(h.room.history.length, 0);
    assert.equal(h.media.jobs.size, 0);
});

test('shares require audio, one sender per room, and an available transcoder', () => {
    const h = fixture();
    assert.throws(() => h.desktop.start(h.room, h.ws, h.user, {...request, audio: false}), /shared audio/);
    h.media.config.maxTranscoders = 0;
    assert.throws(() => h.desktop.start(h.room, h.ws, h.user, request), /busy/);
    h.media.config.maxTranscoders = 4;
    h.desktop.start(h.room, h.ws, h.user, request);
    assert.throws(() => h.desktop.start(h.room, {id: 'another'}, h.user, request), /already/);
    h.desktop.stop({id: 'another'});
    assert.equal(h.desktop.sessions.size, 1);
    h.desktop.stop(h.ws);
});

test('backpressure, timeout, skip, deletion and conversion failure dispose the capture', () => {
    for (const cause of ['backpressure', 'timeout', 'skip', 'delete', 'conversion']) {
        const h = fixture();
        h.desktop.start(h.room, h.ws, h.user, request);
        const input = h.desktop.sessions.get(h.ws.id).input;
        if (cause === 'backpressure') h.desktop.write(h.ws, Buffer.alloc(4 * 1024 * 1024 + 1));
        if (cause === 'timeout') { h.advance(21000); h.desktop.tick(); }
        if (cause === 'skip') h.rooms.advance(h.room);
        if (cause === 'delete') h.rooms.remove(h.room.id, {role: 'admin'});
        if (cause === 'conversion') { h.room.current.status = 'error'; h.room.current.error = 'Missing audio'; h.rooms.emit('state', h.room); }
        assert.equal(h.desktop.sessions.size, 0, cause);
        assert.equal(h.media.jobs.size, 0, cause);
        assert.equal(input.destroyed, true, cause);
    }
});

test('live capture persists only the resumable video, never the live source', () => {
    const h = fixture();
    const item = makeItem({kind: 'upload', complete: true}, {duration: 100});
    h.rooms.add(h.room, [item]);
    h.rooms.stamp(h.room, 37, true);
    let saved;
    h.rooms.store = {save: (_type, _id, value) => saved = value};
    h.desktop.start(h.room, h.ws, h.user, request);
    assert.equal(saved.current.id, item.id);
    assert.equal(saved.playback.position, 37);
    assert.deepEqual(saved.queue, []);
    assert.equal(saved.resumeWhenReady, true);
    h.desktop.stop(h.ws);
});

test('WebSocket capture is tied to its authenticated room connection', async t => {
    const h = await start(t);
    h.instance.media.listening = false;
    t.mock.method(h.instance.media, 'start', () => {});
    h.instance.capabilities.ffmpeg = true;
    const sender = await h.connect(), other = await h.connect();
    sender.send(JSON.stringify({type: 'desktop:start', ...request}));
    await until(() => sender.messages.some(m => m.type === 'desktop:error'));
    assert.equal(h.instance.desktop.sessions.size, 0);
    sender.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    other.send(JSON.stringify({type: 'join', roomId: 'lobby'}));
    await until(() => h.instance.rooms.get('lobby').members.size === 2);
    sender.send(JSON.stringify({type: 'desktop:start', ...request}));
    await until(() => sender.messages.some(m => m.type === 'desktop:started'));
    other.send(JSON.stringify({type: 'desktop:stop', requestId: request.requestId}));
    other.send(Buffer.from('not the sender'));
    await until(() => other.messages.some(m => m.type === 'error'));
    assert.equal(h.instance.desktop.sessions.size, 1);
    sender.close();
    await until(() => h.instance.desktop.sessions.size === 0);
    assert.equal(h.instance.rooms.get('lobby').current, null);
});
