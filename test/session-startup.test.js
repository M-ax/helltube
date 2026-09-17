import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionStartup } from '../src/lib/session-startup.js';
import { ApiError } from '../src/lib/api.js';

const flush = () => new Promise(resolve => setImmediate(resolve));
const session = { user: { id: 'viewer' }, capabilities: {} };

function fixture(t, request) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const states = [], authenticated = [], requests = [];
    const windowTarget = Object.assign(new EventTarget(), { navigator: { onLine: true } });
    const documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
    const startup = createSessionStartup({
        windowTarget, documentTarget, onState: state => states.push(state),
        onAuthenticated: value => authenticated.push(value),
        request: (url, options) => {
            assert.equal(url, '/api/me');
            assert.equal(options.cache, 'no-store');
            requests.push(options);
            return request(options);
        },
    });
    t.after(() => startup.dispose());
    void startup.check();
    return { ...startup, states, authenticated, requests, windowTarget, documentTarget };
}

test('session startup retries deployment and network failures with capped backoff, then restores the session', async t => {
    const failures = [502, 503, 504, undefined, 408, 500, 502];
    const state = fixture(t, async () => {
        if (failures.length) {
            const status = failures.shift();
            throw status ? new ApiError('Unavailable', status) : new TypeError('Failed to fetch');
        }
        return session;
    });
    await flush();
    for (const delay of [1000, 2000, 4000, 8000, 15000, 15000, 15000]) {
        assert.deepEqual(state.states.at(-1), { checking: true, retrying: true, error: '' });
        const count = state.requests.length;
        t.mock.timers.tick(delay - 1);
        await flush();
        assert.equal(state.requests.length, count);
        t.mock.timers.tick(1);
        await flush();
        assert.equal(state.requests.length, count + 1);
    }
    assert.deepEqual(state.authenticated, [session]);
    assert.deepEqual(state.states.at(-1), { checking: false, retrying: false, error: '' });
    t.mock.timers.tick(60000);
    state.windowTarget.dispatchEvent(new Event('online'));
    state.documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(state.requests.length, 8, 'A restored session is not initialized twice.');
});

for (const status of [401, 403, 404, 429]) {
    test(`session startup does not retry HTTP ${status}`, async t => {
        const state = fixture(t, async () => { throw new ApiError('Request denied', status); });
        await flush();
        assert.deepEqual(state.states.at(-1), { checking: false, retrying: false, error: status === 401 ? '' : 'Request denied' });
        t.mock.timers.tick(60000);
        state.windowTarget.dispatchEvent(new Event('online'));
        assert.equal(state.requests.length, 1);
        assert.deepEqual(state.authenticated, []);
    });
}

test('a stalled session request times out and recovery retries', async t => {
    let calls = 0;
    const state = fixture(t, ({ signal }) => ++calls === 1
        ? new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
        : Promise.resolve(session));
    t.mock.timers.tick(10000);
    await flush();
    assert.equal(state.requests[0].signal.aborted, true);
    assert.equal(state.states.at(-1).retrying, true);
    t.mock.timers.tick(1000);
    await flush();
    assert.deepEqual(state.authenticated, [session]);
});

test('online and visible events wake pending retries without overlapping requests', async t => {
    const response = Promise.withResolvers();
    let calls = 0;
    const state = fixture(t, async () => {
        if (++calls <= 2) throw new ApiError('Unavailable', 502);
        return response.promise;
    });
    await flush();
    state.windowTarget.dispatchEvent(new Event('online'));
    await flush();
    assert.equal(calls, 2);
    state.documentTarget.visibilityState = 'hidden';
    state.documentTarget.dispatchEvent(new Event('visibilitychange'));
    assert.equal(calls, 2);
    state.documentTarget.visibilityState = 'visible';
    state.documentTarget.dispatchEvent(new Event('visibilitychange'));
    state.windowTarget.dispatchEvent(new Event('online'));
    void state.check();
    assert.equal(calls, 3);
    response.resolve(session);
    await flush();
    t.mock.timers.tick(15000);
    assert.equal(calls, 3, 'Waking clears the previously scheduled retry.');
    assert.deepEqual(state.authenticated, [session]);
});

test('disposal aborts startup and ignores a late successful response', async t => {
    const response = Promise.withResolvers();
    const state = fixture(t, () => response.promise);
    state.dispose();
    assert.equal(state.requests[0].signal.aborted, true);
    response.resolve(session);
    await flush();
    state.windowTarget.dispatchEvent(new Event('online'));
    t.mock.timers.tick(60000);
    assert.equal(state.requests.length, 1);
    assert.equal(state.states.length, 1);
    assert.deepEqual(state.authenticated, []);
});

test('disposal clears retries after an outage', async t => {
    const state = fixture(t, async () => { throw new ApiError('Unavailable', 503); });
    await flush();
    state.dispose();
    t.mock.timers.tick(60000);
    assert.equal(state.requests.length, 1);
});
