import test from 'node:test';
import assert from 'node:assert/strict';
import {get} from 'svelte/store';
import {createRealtime} from '../src/lib/realtime.js';

const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t, {constructorFailures = 0, ticketResponse = {mode: 'same-origin'}, ticketHandler} = {}) {
    t.mock.timers.enable({apis: ['setTimeout', 'setInterval', 'Date'], now: 1700000000000});
    t.mock.method(Math, 'random', () => 0);
    let monotonicTime = 0;
    let sessionEnded = 0;
    const sockets = [];
    const requests = [];
    const ticketRequests = [];
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
        constructor(url) {
            if (constructorFailures-- > 0) throw new Error('Cannot create WebSocket');
            this.url = url; sockets.push(this);
        }
        send(data) {
            if (this.sendError) throw new Error('Transport failed');
            assert.equal(this.readyState, FakeWebSocket.OPEN);
            this.sent.push(JSON.parse(data));
        }
        // A broken transport does not have to finish the close handshake.
        close() { this.closes++; this.readyState = FakeWebSocket.CLOSING; }
        open() { this.readyState = FakeWebSocket.OPEN; this.onopen?.(); }
        receive(message) { this.onmessage?.({data: JSON.stringify(message)}); }
        end(code = 1006, reason = '', wasClean = false) {
            this.readyState = FakeWebSocket.CLOSED; this.onclose?.({code, reason, wasClean});
        }
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
            if (url === '/api/realtime-ticket') {
                ticketRequests.push(options);
                return ticketHandler ? ticketHandler(options) : Promise.resolve(ticketResponse);
            }
            const deferred = Promise.withResolvers();
            requests.push({url, ...options, ...deferred});
            options.signal.addEventListener('abort', () => deferred.reject(options.signal.reason), {once: true});
            return deferred.promise;
        },
    });
    t.after(() => client.disconnect());
    client.connect('viewer');
    await flush();
    return {
        client, sockets, requests, ticketRequests, notices, windowTarget, documentTarget,
        state: () => get(client.state), sessionEnded: () => sessionEnded,
        async advance(ms) {
            // Deliver regular callbacks while both clocks advance.
            while (ms > 0) {
                const step = Math.min(ms, 250);
                monotonicTime += step;
                t.mock.timers.tick(step);
                await flush();
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

test('brief response delays survive and healthy long-lived sessions retain their socket', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    assert.equal(ws.url, 'wss://watch.example/ws');
    ws.open();
    ws.room();
    await h.advance(7500);
    assert.equal(ws.closes, 0, 'A delay longer than the old five-second timeout is tolerated.');
    ws.pong();
    for (let i = 0; i < 360; i++) {
        await h.advance(10000);
        ws.pong();
    }
    assert.equal(h.sockets.length, 1);
    assert.equal(ws.closes, 0);
    assert.equal(h.state().joined, true);
});

test('finger snapshots preserve the local socket identity, ignore other rooms and reset on reconnect', async t => {
    const h = await fixture(t);
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

test('file snapshots require current membership and clear across room switches and disconnects', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    const snapshot = {type: 'files:state', roomId: 'lobby', files: [{id: 'one'}]};
    ws.open(); ws.receive(snapshot);
    assert.equal(get(h.client.sharedFiles), null);
    ws.room(); ws.receive(snapshot);
    assert.deepEqual(get(h.client.sharedFiles), snapshot);
    ws.receive({...snapshot, roomId: 'other', files: []});
    assert.deepEqual(get(h.client.sharedFiles), snapshot);
    ws.fail();
    assert.equal(get(h.client.sharedFiles), null);
    await h.advance(750);
    const next = h.sockets.at(-1);
    next.open(); next.room(); next.receive(snapshot);
    h.client.join('other');
    assert.equal(get(h.client.sharedFiles), null);
    next.receive(snapshot);
    assert.equal(get(h.client.sharedFiles), null);
});

test('whiteboard snapshots and deltas stay in their room and reset across clear and reconnect', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    const snapshot = {type: 'whiteboard:state', roomId: 'lobby', epoch: 'first', revision: 0, shapes: []};
    ws.open();
    ws.receive(snapshot);
    assert.equal(get(h.client.whiteboard).roomId, null, 'Wait for room membership.');
    ws.room(); ws.receive(snapshot);
    const event = {type: 'whiteboard:event', roomId: 'lobby', epoch: 'first', revision: 1, action: 'begin',
        shape: {id: 'one', tool: 'pen', points: [[.1, .2]], complete: false}};
    ws.receive(event); ws.receive(event);
    assert.equal(get(h.client.whiteboard).shapes.length, 1);
    ws.receive({...event, roomId: 'elsewhere', revision: 2, action: 'erase', removed: ['one']});
    assert.equal(get(h.client.whiteboard).shapes.length, 1);
    ws.receive({...snapshot, epoch: 'second'});
    ws.receive({...event, revision: 3});
    assert.equal(get(h.client.whiteboard).shapes.length, 0, 'Clearing rejects stale epoch events.');
    ws.fail();
    assert.equal(get(h.client.whiteboard).epoch, null);
    assert.equal(get(h.client.whiteboard).roomId, null);
});

test('hidden tabs and suspended callbacks probe before applying a fresh visible deadline', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    ws.open();
    h.documentTarget.visibilityState = 'hidden';
    await h.advance(60000);
    h.suspend(10 * 60 * 1000);
    assert.equal(ws.closes, 0);
    h.documentTarget.visibilityState = 'visible';
    await h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await h.advance(14000);
    assert.equal(ws.closes, 0);
    await h.advance(1000);
    assert.equal(ws.closes, 1, 'A resumed tab still detects a genuinely unresponsive connection.');
    assert.equal(h.state().status, 'reconnecting');
});

test('a healthy socket survives a delayed timer and probes on focus and pageshow', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    ws.open();
    ws.room();
    h.suspend(30 * 60 * 1000);
    assert.equal(ws.closes, 0);
    ws.pong();
    for (const name of ['focus', 'pageshow', 'online']) {
        const before = ws.sent.length;
        await h.windowTarget.dispatchEvent(new Event(name));
        assert.equal(ws.sent.length, before + 1);
        assert.equal(ws.sent.at(-1).type, 'ping');
        ws.pong();
    }
    assert.equal(h.sockets.length, 1);
    assert.equal(h.state().joined, true);
});

test('response timeouts reconnect without a close event, rejoin and reject stale commands', async t => {
    const h = await fixture(t);
    const old = h.sockets[0];
    old.open();
    old.room(50);
    old.pong(700);
    assert.equal(h.state().clockReady, true);
    await h.advance(15000);
    assert.equal(old.closes, 1);
    assert.equal(h.state().joined, false);
    assert.equal(h.client.command({type: 'control', action: 'pause'}), false);
    await h.advance(750);
    const replacement = h.sockets[1];
    replacement.open();
    assert.deepEqual(replacement.sent.map(message => message.type), ['ping', 'client:disconnect', 'join']);
    assert.equal(replacement.sent[2].roomId, 'lobby');
    assert.equal(replacement.sent[1].report.cause, 'response-timeout');
    assert.equal(replacement.sent[1].report.lastResponseAgeMs, 15000);
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

test('stalled handshakes have a deadline and repeated failures back off', async t => {
    const h = await fixture(t);
    await h.advance(15000);
    assert.equal(h.sockets[0].closes, 1);
    assert.equal(h.state().status, 'reconnecting');
    await h.advance(749);
    assert.equal(h.sockets.length, 1);
    await h.advance(1);
    assert.equal(h.sockets.length, 2);
    await h.advance(15000);
    await h.advance(1499);
    assert.equal(h.sockets.length, 2);
    await h.advance(1);
    assert.equal(h.sockets.length, 3);
});

test('transport errors and send failures recover even if close never fires', async t => {
    for (const failure of ['error', 'send']) await t.test(failure, async t => {
        const h = await fixture(t);
        const ws = h.sockets[0];
        ws.open();
        ws.room();
        if (failure === 'error') ws.fail();
        else {
            ws.sendError = true;
            assert.equal(h.client.command({type: 'control', action: 'pause'}), false);
        }
        assert.equal(h.state().status, 'reconnecting');
        await h.advance(750);
        assert.equal(h.sockets.length, 2);
        ws.end();
        assert.equal(h.sockets.length, 2);
    });
});

test('wall clock adjustments do not trigger a transport timeout', async t => {
    const h = await fixture(t);
    const ws = h.sockets[0];
    ws.open();
    const wallNow = Date.now;
    let adjustment = 60 * 60 * 1000;
    t.mock.method(Date, 'now', () => wallNow() + adjustment);
    await h.advance(1500);
    assert.equal(ws.closes, 0);
    ws.pong();
    adjustment = -60 * 60 * 1000;
    await h.advance(15000);
    assert.equal(ws.closes, 1, 'A backward wall clock jump must not delay timeout detection.');
});

test('online and wake events recover once and cleanup removes every lifecycle listener', async t => {
    const h = await fixture(t);
    h.sockets[0].open();
    h.windowTarget.navigator.onLine = false;
    await h.windowTarget.dispatchEvent(new Event('offline'));
    await h.advance(60000);
    assert.equal(h.state().status, 'offline');
    assert.equal(h.sockets.length, 1);
    h.windowTarget.navigator.onLine = true;
    for (const name of ['online', 'online', 'focus', 'pageshow']) await h.windowTarget.dispatchEvent(new Event(name));
    assert.equal(h.sockets.length, 2);
    h.sockets[1].open();
    h.sockets[1].end();
    await h.windowTarget.dispatchEvent(new Event('pageshow'));
    assert.equal(h.sockets.length, 3, 'Returning to the page wakes a pending retry.');
    h.sockets[2].open();
    await h.advance(750);
    assert.equal(h.sockets.length, 3, 'The old retry was cancelled.');
    h.client.disconnect();
    for (const name of ['online', 'focus', 'pageshow', 'offline']) await h.windowTarget.dispatchEvent(new Event(name));
    await h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await h.advance(60000);
    assert.equal(h.sockets.length, 3);
    assert.equal(h.state().status, 'offline');
});

test('session checks are bounded, deduplicated during outages and cancelled on recovery', async t => {
    const h = await fixture(t);
    h.sockets[0].fail();
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].url, '/api/me');
    await h.advance(750);
    h.sockets[1].fail();
    assert.equal(h.requests.length, 1);
    await h.advance(9250);
    assert.equal(h.requests[0].signal.aborted, true);
    await flush();
    h.sockets.at(-1).fail();
    assert.equal(h.requests.length, 2);
    await h.client.retry();
    h.sockets.at(-1).open();
    assert.equal(h.requests[1].signal.aborted, true);
    await flush();
    assert.equal(h.sessionEnded(), 0);
});

test('authentication failures end the session once and cancel future retries', async t => {
    for (const cause of ['message', 1008, 4001, 4401, '401']) await t.test(String(cause), async t => {
        const h = await fixture(t);
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
        await h.advance(60000);
        assert.equal(h.sessionEnded(), 1);
        assert.equal(h.sockets.length, 1);
        assert.equal(h.state().status, 'offline');
    });
});

test('late authentication responses cannot end a recovered or newly signed-in session', async t => {
    for (const action of ['recover', 'signin']) await t.test(action, async t => {
        const h = await fixture(t);
        h.sockets[0].fail();
        if (action === 'recover') { await h.advance(750); h.sockets[1].open(); }
        else await h.client.connect('another-viewer');
        h.requests[0].reject(Object.assign(new Error('Old session expired'), {status: 401}));
        await flush();
        assert.equal(h.sessionEnded(), 0);
        assert.equal(h.requests[0].signal.aborted, true);
    });
});

const direct = (ticket = 'a'.repeat(64)) => ({mode: 'direct', realtimeOrigin: 'https://metal.example',
    recipientOrigin: 'https://watch.example', ticket});

test('direct connections acquire a new ticket on every attempt and preserve room recovery', async t => {
    let sequence = 0;
    const h = await fixture(t, {ticketHandler: async () => direct(String(++sequence).padStart(64, '0'))});
    const first = h.sockets[0];
    assert.equal(first.url, 'wss://metal.example/ws?ticket=' + '1'.padStart(64, '0'));
    assert.equal(h.ticketRequests[0].method, 'POST');
    assert.deepEqual(h.ticketRequests[0].body, {origin: 'https://watch.example'});
    first.open(); first.room(); first.end();
    await h.advance(750);
    const next = h.sockets[1];
    assert.equal(next.url, 'wss://metal.example/ws?ticket=' + '2'.padStart(64, '0'));
    next.open(); next.room();
    assert.equal(next.sent.at(-1).roomId, 'lobby');
    assert.equal(h.state().joined, true);
    assert.equal(h.ticketRequests.length, 2);
});

test('pending ticket requests have a deadline, deduplicate wake events and discard stale replies', async t => {
    const pending = [];
    const h = await fixture(t, {ticketHandler: () => {
        const request = Promise.withResolvers(); pending.push(request); return request.promise;
    }});
    for (const event of ['focus', 'pageshow', 'online']) h.windowTarget.dispatchEvent(new Event(event));
    assert.equal(h.ticketRequests.length, 1);
    assert.equal(h.sockets.length, 0);
    await h.advance(15000);
    assert.equal(h.ticketRequests[0].signal.aborted, true);
    await h.advance(750);
    assert.equal(pending.length, 2);
    pending[0].resolve(direct());
    await flush();
    assert.equal(h.sockets.length, 0);
    pending[1].resolve(direct('b'.repeat(64)));
    await flush();
    assert.equal(h.sockets.length, 1);
    assert.match(h.sockets[0].url, /ticket=b{64}$/);
});

test('signout, offline events and a new signin cancel ticket acquisition', async t => {
    for (const action of ['signout', 'offline', 'signin']) await t.test(action, async t => {
        const pending = [];
        const h = await fixture(t, {ticketHandler: () => {
            const request = Promise.withResolvers(); pending.push(request); return request.promise;
        }});
        if (action === 'signout') h.client.disconnect();
        if (action === 'offline') {
            h.windowTarget.navigator.onLine = false;
            h.windowTarget.dispatchEvent(new Event('offline'));
        }
        if (action === 'signin') h.client.connect('another-viewer');
        assert.equal(h.ticketRequests[0].signal.aborted, true);
        pending[0].resolve(direct());
        await flush();
        assert.equal(h.sockets.length, 0);
    });
});

test('ticket failures retry directly without falling back to the Worker and 401 ends the session', async t => {
    for (const status of [401, 429, 502]) await t.test(String(status), async t => {
        const h = await fixture(t, {ticketHandler: async () => { throw Object.assign(new Error('Ticket request failed'), {status}); }});
        assert.equal(h.sockets.length, 0);
        assert.equal(h.sessionEnded(), status === 401 ? 1 : 0);
        await h.advance(750);
        assert.equal(h.ticketRequests.length, status === 401 ? 1 : 2);
    });
});

test('invalid connection settings never leak a ticket to an arbitrary destination', async t => {
    for (const response of [{}, direct('invalid'), {...direct(), realtimeOrigin: 'https://metal.example/ws'},
        {...direct(), realtimeOrigin: 'https://user:secret@metal.example'}, {...direct(), realtimeOrigin: 'http://metal.example'},
        {...direct(), recipientOrigin: 'https://other.example'}, {...direct(), realtimeOrigin: 'javascript:alert(1)'}]) {
        await t.test(JSON.stringify(response), async t => {
            const h = await fixture(t, {ticketResponse: response});
            assert.equal(h.sockets.length, 0);
            assert.equal(h.state().status, 'reconnecting');
        });
    }
});

const reports = ws => ws.sent.filter(message => message.type === 'client:disconnect').map(message => message.report);

test('disconnect reports correlate the old connection and preserve close details after an error', async t => {
    const h = await fixture(t);
    const old = h.sockets[0];
    old.open(); old.room();
    old.receive({type: 'rooms', rooms: [{id: 'lobby'}], clientId: 'old-connection'});
    assert.deepEqual(reports(old), [], 'Initial connections do not claim a disconnect.');
    await h.advance(3000);
    old.fail();
    old.end(1013, 'Client too slow; reconnect.', true);
    await h.advance(750);
    const next = h.sockets[1];
    next.open();
    const [report] = reports(next);
    assert.equal(reports(next).length, 1, 'Error and subsequent close are one failure.');
    assert.equal(report.connectionId, 'old-connection');
    assert.equal(report.roomId, 'lobby');
    assert.equal(report.cause, 'socket-error');
    assert.match(report.error, /browser did not expose further details/);
    assert.equal(report.code, 1013);
    assert.equal(report.reason, 'Client too slow; reconnect.');
    assert.equal(report.wasClean, true);
    assert.equal(report.connectionAgeMs, 3000);
    assert.equal(report.lastResponseAgeMs, 3000);
    assert.equal(report.online, true);
    assert.equal(report.visibility, 'visible');
    assert.equal(report.at, 1700000003000);
});

test('unacknowledged reports survive another failed connection and acknowledged reports stop replaying', async t => {
    const h = await fixture(t);
    h.sockets[0].open();
    h.sockets[0].end(1006, 'Lost transport');
    await h.advance(750);
    h.sockets[1].open();
    const [original] = reports(h.sockets[1]);
    h.sockets[1].fail();
    await h.client.retry();
    const recovered = h.sockets[2];
    recovered.open();
    assert.equal(reports(recovered).length, 2);
    assert.deepEqual(reports(recovered)[0], original);
    for (const report of reports(recovered)) recovered.receive({type: 'client:disconnect:ack', id: report.id});
    recovered.end(1000, 'Server restart', true);
    await h.client.retry();
    h.sockets[3].open();
    assert.equal(reports(h.sockets[3]).length, 1);
    assert.equal(reports(h.sockets[3])[0].reason, 'Server restart');
});

test('reports survive a failed send of the diagnostics themselves', async t => {
    const h = await fixture(t);
    h.sockets[0].fail();
    await h.advance(750);
    const broken = h.sockets[1];
    const send = broken.send.bind(broken);
    broken.send = data => {
        if (JSON.parse(data).type === 'client:disconnect') throw new Error('Report transport failed');
        send(data);
    };
    broken.open();
    await h.client.retry();
    h.sockets[2].open();
    assert.deepEqual(reports(h.sockets[2]).map(report => report.cause), ['socket-error', 'send-error']);
    assert.equal(reports(h.sockets[2])[1].error, 'Report transport failed');
});

test('unacknowledged diagnostics retry on a healthy socket without interrupting playback', async t => {
    const h = await fixture(t);
    h.sockets[0].fail();
    await h.client.retry();
    const ws = h.sockets.at(-1);
    ws.open(); ws.room();
    ws.receive({type: 'client:disconnect:error', message: 'Too many requests.'});
    assert.deepEqual(h.notices, [], 'Background diagnostics do not show room command errors.');
    for (let i = 0; i < 6; i++) { await h.advance(10000); ws.pong(); }
    assert.equal(reports(ws).length, 2);
    assert.deepEqual(reports(ws)[0], reports(ws)[1]);
    ws.receive({type: 'client:disconnect:ack', id: reports(ws)[0].id});
    for (let i = 0; i < 6; i++) { await h.advance(10000); ws.pong(); }
    assert.equal(reports(ws).length, 2);
    assert.equal(h.state().joined, true);
});

test('offline events, connection deadlines, constructor exceptions and retries report their causes', async t => {
    for (const cause of ['browser-offline', 'connection-timeout', 'connection-error', 'manual-retry']) {
        await t.test(cause, async t => {
            const h = await fixture(t, {constructorFailures: cause === 'connection-error' ? 1 : 0});
            if (cause === 'browser-offline') {
                h.sockets[0].open();
                h.windowTarget.navigator.onLine = false;
                h.documentTarget.visibilityState = 'hidden';
                await h.windowTarget.dispatchEvent(new Event('offline'));
                h.windowTarget.navigator.onLine = true;
            } else if (cause === 'connection-timeout') await h.advance(15000);
            await h.client.retry();
            const next = h.sockets.at(-1);
            next.open();
            const [report] = reports(next);
            assert.equal(report.cause, cause);
            if (cause === 'browser-offline') {
                assert.equal(report.online, false);
                assert.equal(report.visibility, 'hidden');
            }
            if (cause === 'connection-error') assert.equal(report.error, 'Cannot create WebSocket');
        });
    }
});

test('outage history is bounded, accounts for omitted failures, and cannot cross sign-ins', async t => {
    const h = await fixture(t);
    for (let i = 0; i < 30; i++) {
        h.sockets.at(-1).fail();
        await h.client.retry();
    }
    h.sockets.at(-1).open();
    const queued = reports(h.sockets.at(-1));
    assert.equal(queued.length, 20);
    assert.equal(queued.reduce((sum, report) => sum + report.droppedReports, 0), 10);
    assert.match(queued[0].id, /-1$/);
    await h.client.connect('another-viewer');
    h.sockets.at(-1).open();
    assert.deepEqual(reports(h.sockets.at(-1)), []);
});
