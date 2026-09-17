import test from 'node:test';
import assert from 'node:assert/strict';
import { watchDeployment } from '../src/lib/deployment-updates.js';

const current = '11111111-1111-4111-8111-111111111111';
const newer = '22222222-2222-4222-8222-222222222222';
const flush = () => new Promise(resolve => setImmediate(resolve));

test('backend commits refresh on unchanged frontend builds and retain the last hash through outages', async t => {
    const commits = [];
    const first = 'a'.repeat(40);
    const next = 'b'.repeat(40);
    const responses = [Response.json({ commit: first }), new Response('offline', { status: 503 }),
        Response.json({ commit: next.toUpperCase() }), Response.json({ commit: null })];
    const state = fixture(t, async () => Response.json({ buildId: current }), {
        onBackendCommit: value => commits.push(value), fetchBackend: async (url, options) => {
            assert.equal(url, '/api/version');
            assert.equal(options.cache, 'no-store');
            return responses.shift();
        },
    });
    await flush();
    assert.deepEqual(commits, [first]);
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.deepEqual(commits, [first]);
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.deepEqual(commits, [first, next]);
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.deepEqual(commits, [first, next, null]);
    assert.equal(state.reloads(), 0);
});

test('backend refresh runs independently of frontend failure and ignores responses after disposal', async t => {
    const commits = [];
    const response = Promise.withResolvers();
    const state = fixture(t, async () => { throw new Error('frontend offline'); }, {
        onBackendCommit: value => commits.push(value), fetchBackend: () => response.promise,
    });
    await flush();
    state.stop();
    response.resolve(Response.json({ commit: 'a'.repeat(40) }));
    await flush();
    assert.deepEqual(commits, []);
});

function fixture(t, fetchVersion, options = {}) {
    const windowTarget = new EventTarget();
    const documentTarget = new EventTarget();
    documentTarget.visibilityState = 'visible';
    let reloads = 0;
    const stop = watchDeployment({ buildId: current, fetchVersion, windowTarget, documentTarget,
        reload: () => reloads++, ...options });
    t.after(stop);
    return { windowTarget, documentTarget, stop, reloads: () => reloads };
}

test('deployment watcher bypasses cache, stays on the same build and reloads once on a newer build', async t => {
    let buildId = current;
    const state = fixture(t, async (url, options) => {
        assert.match(url, /^\/version.json\?check=/);
        assert.equal(options.cache, 'no-store');
        return Response.json({ buildId });
    });
    await flush();
    assert.equal(state.reloads(), 0);
    buildId = newer;
    state.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await flush();
    assert.equal(state.reloads(), 1);
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(state.reloads(), 1);
});

test('deployment interruptions, SPA fallback and malformed versions do not reload, and recovery retries', async t => {
    const responses = [() => { throw new Error('offline'); },
        () => new Response('Unavailable', { status: 503 }),
        () => new Response('<html>fallback</html>', { headers: { 'Content-Type': 'text/html' } }),
        () => Response.json({ buildId: null }), () => Response.json({ buildId: newer })];
    const state = fixture(t, async () => responses.shift()());
    await flush();
    for (let i = 0; i < 3; i++) {
        state.windowTarget.dispatchEvent(new Event('online'));
        await flush();
        assert.equal(state.reloads(), 0);
    }
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(state.reloads(), 1);
});

test('deployment checks do not overlap and disposal ignores an in-flight response', async t => {
    let resolve;
    let calls = 0;
    let signal;
    const state = fixture(t, (_url, options) => {
        calls++;
        signal = options.signal;
        return new Promise(done => { resolve = done; });
    });
    state.windowTarget.dispatchEvent(new Event('online'));
    assert.equal(calls, 1);
    state.stop();
    assert.equal(signal.aborted, true);
    resolve(Response.json({ buildId: newer }));
    await flush();
    state.windowTarget.dispatchEvent(new Event('online'));
    assert.equal(calls, 1);
    assert.equal(state.reloads(), 0);
});

test('connected tabs check every thirty seconds without needing focus or reconnect events', async t => {
    t.mock.timers.enable({ apis: ['setInterval'] });
    let calls = 0;
    const state = fixture(t, async () => { calls++; return Response.json({ buildId: calls === 1 ? current : newer }); });
    await flush();
    t.mock.timers.tick(29999);
    assert.equal(calls, 1);
    t.mock.timers.tick(1);
    await flush();
    assert.equal(calls, 2);
    assert.equal(state.reloads(), 1);
});

test('new deployments wait for retained upload files before automatically reloading', async t => {
    let pendingFiles = true;
    const state = fixture(t, async () => Response.json({ buildId: newer }), { canReload: () => !pendingFiles });
    await flush();
    for (const event of ['online', 'online']) {
        state.windowTarget.dispatchEvent(new Event(event));
        await flush();
    }
    assert.equal(state.reloads(), 0, 'A deployment must not discard the tab’s File objects.');
    pendingFiles = false;
    state.documentTarget.dispatchEvent(new Event('visibilitychange'));
    await flush();
    assert.equal(state.reloads(), 1);
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(state.reloads(), 1);
});

test('upload protection is checked after a pending version request finishes', async t => {
    let pendingFiles = false;
    const response = Promise.withResolvers();
    const state = fixture(t, () => response.promise, { canReload: () => !pendingFiles });
    pendingFiles = true;
    response.resolve(Response.json({ buildId: newer }));
    await flush();
    assert.equal(state.reloads(), 0);
});
