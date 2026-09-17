import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'svelte/store';
import {createRealtime} from '../src/lib/realtime.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture(t) {
    t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: 1700000000000});
    t.mock.method(Math, 'random', () => 0);
    let monotonicTime = 0;
    let sessionEnded = 0;
    const sockets = [];
    const requests = [];
    const notices = [];
    const stored = new Map([['helltube:room:viewer', 'lobby']]);
    const windowTarget = Object.assign(new EventTarget(), {
        navigator: {onLine: true}, location: {protocol: 'https:', host: 'watch.example'},
        localStorage: {getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value)},
    });
    const documentTarget = Object.assign(new EventTarget(), {visibilityState: 'visible'});
    class FakeWebSocket {
        static CONNECTING = 0;
        static OPEN = 1;
        static CLOSING = 2;
        static CLOSED = 3;
        readyState = FakeWebSocket.CONNECTING;
        sent = [];
        closes = 0;
        constructor(url) { this.url = url; sockets.push(this); }
        send(data) {
            if (this.sendError) throw new Error('Transport failed');
            assert.equal(this.readyState, FakeWebSocket.OPEN);
            this.sent.push(JSON.parse(data));
        }
        // A broken transport does not have to finish the close handshake.
        close() { this.closes++; this.readyState = FakeWebSocket.CLOSING; }
        open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
        receive(message) { this.onmessage?.({data: JSON.stringify(message)}); }
        end(code = 1006) { this.readyState = FakeWebSocket.CLOSED; this.onclose?.({code}); }
        fail() { this.onerror?.(); }
        pong(offset = 0) { this.receive({type: 'pong', sentAt: Date.now(), serverTime: Date.now() + offset}); }
        room(version = 1) {
            this.receive({type: 'state', room: {id: 'lobby', version, playback: {revision: version}}, serverTime: Date.now()});
        }
    }
    const client = createRealtime({
        windowTarget, documentTarget, WebSocketImpl: FakeWebSocket, now: () => monotonicTime,
        onMessage: (...args) => notices.push(args), onSessionEnded: () => sessionEnded++,
        request: (url, options) => {
            const deferred = Promise.withResolvers();
            requests.push({url, ...options, ...deferred});
            options.signal.addEventListener('abort', () => deferred.reject(options.signal.reason), {once: true});
            return deferred.promise;
        },
    });
    t.after(() => client.disconnect());
    client.connect('viewer');
    return {
        client, sockets, requests, notices, windowTarget, documentTarget,
        state: () => get(client.state), sessionEnded: () => sessionEnded,
        advance(ms) {
            // Deliver regular callbacks while both clocks advance.
            while (ms > 0) {
                const step = Math.min(ms, 250);
                monotonicTime += step;
                t.mock.timers.tick(step);
                ms -= step;
            }
        },
        suspend(ms) {
            // Resume one delayed timer turn after the event loop was suspended.
            monotonicTime += ms;
            t.mock.timers.tick(ms);
        },
    };
}

test('brief response delays survive and healthy long-lived sessions retain their socket', t => {
    const h = fixture(t);
    const ws = h.sockets[0];
    assert.equal(ws.url, 'wss://watch.example/ws');
    ws.open();
    ws.room();
    h.advance(7500);
    assert.equal(ws.closes, 0, 'A delay longer than the old five-second timeout is tolerated.');
    ws.pong();
    for (let i = 0; i < 360; i++) {
        h.advance(10000);
        ws.pong();
    }
    assert.equal(h.sockets.length, 1);
    assert.equal(ws.closes, 0);
    assert.equal(h.state().joined, true);
});

test('finger snapshots preserve the local socket identity, ignore other rooms and reset on reconnect', t => {
    const h = fixture(t);
    const ws = h.sockets[0];
    ws.open(); ws.room();
    ws.receive({type: 'reactions:state', roomId: 'lobby', clientId: 'self', ball: null, fingers: [], serverTime: Date.now()});
    const finger = {clientId: 'other', x: .4, y: .2, pivot: {x: -.1, y: .2}, pressed: true, taps: 1};
    ws.receive({type: 'reactions:state', roomId: 'lobby', ball: null, fingers: [finger], serverTime: Date.now()});
    assert.equal(get(h.client.reactions).clientId, 'self');
    assert.deepEqual(get(h.client.reactions).fingers, [finger]);
    ws.receive({type: 'reactions:state', roomId: 'elsewhere', fingers: [], serverTime: Date.now()});
    assert.deepEqual(get(h.client.reactions).fingers, [finger]);
    ws.fail();
    assert.deepEqual(get(h.client.reactions).fingers, []);
    assert.equal(get(h.client.reactions).clientId, null);
});

test('hidden tabs and suspended callbacks probe before applying a fresh visible deadline', t => {
    const h = fixture(t);
    const ws = h.sockets[0];
    ws.open();
    h.documentTarget.visibilityState = 'hidden';
    h.advance(60000);
    h.suspend(10 * 60 * 1000);
    assert.equal(ws.closes, 0);
    h.documentTarget.visibilityState = 'visible';
    h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    h.advance(14000);
    assert.equal(ws.closes, 0);
    h.advance(1000);
    assert.equal(ws.closes, 1, 'A resumed tab still detects a genuinely unresponsive connection.');
    assert.equal(h.state().status, 'reconnecting');
});

test('a healthy socket survives a delayed timer and probes on focus and pageshow', t => {
    const h = fixture(t);
    const ws = h.sockets[0];
    ws.open();
    ws.room();
    h.suspend(30 * 60 * 1000);
    assert.equal(ws.closes, 0);
    ws.pong();
    for (const name of ['focus', 'pageshow', 'online']) {
        const before = ws.sent.length;
        h.windowTarget.dispatchEvent(new Event(name));
        assert.equal(ws.sent.length, before + 1);
        assert.equal(ws.sent.at(-1).type, 'ping');
        ws.pong();
    }
    assert.equal(h.sockets.length, 1);
    assert.equal(h.state().joined, true);
});

test('response timeouts reconnect without a close event, rejoin and reject stale commands', t => {
    const h = fixture(t);
    const old = h.sockets[0];
    old.open();
    old.room(50);
    old.pong(700);
    assert.equal(h.state().clockReady, true);
    h.advance(15000);
    assert.equal(old.closes, 1);
    assert.equal(h.state().joined, false);
    assert.equal(h.client.command({type: 'control', action: 'pause'}), false);
    h.advance(750);
    const replacement = h.sockets[1];
    replacement.open();
    assert.deepEqual(replacement.sent.map(message => message.type), ['ping', 'join']);
    assert.equal(replacement.sent[1].roomId, 'lobby');
    assert.equal(h.state().clockReady, false);
    assert.equal(h.client.command({type: 'control', action: 'play'}), false);
    replacement.pong(100);
    replacement.room(1);
    assert.equal(h.state().clockOffset, 100);
    assert.equal(h.state().room.version, 1, 'A restarted backend may have an older version.');
    assert.equal(h.client.command({type: 'control', action: 'pause'}), true);
    assert.deepEqual(replacement.sent.at(-1), {type: 'control', action: 'pause', revision: 1});
    old.receive({type: 'session-ended'});
    old.open();
    old.fail();
    old.end(1008);
    assert.equal(h.sessionEnded(), 0);
    assert.equal(h.sockets.length, 2);
    assert.equal(h.state().joined, true);
});

test('stalled handshakes have a deadline and repeated failures back off', t => {
    const h = fixture(t);
    h.advance(15000);
    assert.equal(h.sockets[0].closes, 1);
    assert.equal(h.state().status, 'reconnecting');
    h.advance(749);
    assert.equal(h.sockets.length, 1);
    h.advance(1);
    assert.equal(h.sockets.length, 2);
    h.advance(15000);
    h.advance(1499);
    assert.equal(h.sockets.length, 2);
    h.advance(1);
    assert.equal(h.sockets.length, 3);
});

test('transport errors and send failures recover even if close never fires', async t => {
    for (const failure of ['error', 'send']) await t.test(failure, t => {
        const h = fixture(t);
        const ws = h.sockets[0];
        ws.open();
        ws.room();
        if (failure === 'error') ws.fail();
        else {
            ws.sendError = true;
            assert.equal(h.client.command({type: 'control', action: 'pause'}), false);
        }
        assert.equal(h.state().status, 'reconnecting');
        h.advance(750);
        assert.equal(h.sockets.length, 2);
        ws.end();
        assert.equal(h.sockets.length, 2);
    });
});

test('wall clock adjustments do not trigger a transport timeout', t => {
    const h = fixture(t);
    const ws = h.sockets[0];
    ws.open();
    const wallNow = Date.now;
    let adjustment = 60 * 60 * 1000;
    t.mock.method(Date, 'now', () => wallNow() + adjustment);
    h.advance(1500);
    assert.equal(ws.closes, 0);
    ws.pong();
    adjustment = -60 * 60 * 1000;
    h.advance(15000);
    assert.equal(ws.closes, 1, 'A backward wall clock jump must not delay timeout detection.');
});

test('online and wake events recover once and cleanup removes every lifecycle listener', t => {
    const h = fixture(t);
    h.sockets[0].open();
    h.windowTarget.navigator.onLine = false;
    h.windowTarget.dispatchEvent(new Event('offline'));
    h.advance(60000);
    assert.equal(h.state().status, 'offline');
    assert.equal(h.sockets.length, 1);
    h.windowTarget.navigator.onLine = true;
    for (const name of ['online', 'online', 'focus', 'pageshow']) h.windowTarget.dispatchEvent(new Event(name));
    assert.equal(h.sockets.length, 2);
    h.sockets[1].open();
    h.sockets[1].end();
    h.windowTarget.dispatchEvent(new Event('pageshow'));
    assert.equal(h.sockets.length, 3, 'Returning to the page wakes a pending retry.');
    h.sockets[2].open();
    h.advance(750);
    assert.equal(h.sockets.length, 3, 'The old retry was cancelled.');
    h.client.disconnect();
    for (const name of ['online', 'focus', 'pageshow', 'offline']) h.windowTarget.dispatchEvent(new Event(name));
    h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    h.advance(60000);
    assert.equal(h.sockets.length, 3);
    assert.equal(h.state().status, 'offline');
});

test('session checks are bounded, deduplicated during outages and cancelled on recovery', async t => {
    const h = fixture(t);
    h.sockets[0].fail();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/me');
    h.advance(750);
    h.sockets[1].fail();
    assert.equal(h.requests.length, 1);
    h.advance(9250);
    assert.equal(h.requests[0].signal.aborted, true);
    await flush();
    h.sockets.at(-1).fail();
    assert.equal(h.requests.length, 2);
    h.client.retry();
    h.sockets.at(-1).open();
    assert.equal(h.requests[1].signal.aborted, true);
    await flush();
    assert.equal(h.sessionEnded(), 0);
});

test('authentication failures end the session once and cancel future retries', async t => {
    for (const cause of ['message', 1008, 4001, 4401, '401']) await t.test(String(cause), async t => {
        const h = fixture(t);
        const ws = h.sockets[0];
        ws.open();
        if (cause === 'message') ws.receive({type: 'session-ended'});
        else if (cause === '401') {
            ws.fail();
            h.requests[0].reject(Object.assign(new Error('Expired'), {status: 401}));
            await flush();
        } else ws.end(cause);
        assert.equal(h.sessionEnded(), 1);
        ws.end(1008);
        h.advance(60000);
        assert.equal(h.sessionEnded(), 1);
        assert.equal(h.sockets.length, 1);
        assert.equal(h.state().status, 'offline');
    });
});

test('late authentication responses cannot end a recovered or newly signed-in session', async t => {
    for (const action of ['recover', 'signin']) await t.test(action, async t => {
        const h = fixture(t);
        h.sockets[0].fail();
        h.requests[0].reject(Object.assign(new Error('Old session expired'), {status: 401}));
        if (action === 'recover') { h.advance(750); h.sockets[1].open(); }
        else h.client.connect('another-viewer');
        await flush();
        assert.equal(h.sessionEnded(), 0);
        assert.equal(h.requests[0].signal.aborted, true);
    });
});
