import { api } from './api.js';

export function createSessionStartup({ onAuthenticated, onState, request = api,
    windowTarget = window, documentTarget = document } = {}) {
    let stopped = false;
    let settled = false;
    let attempt = 0;
    let controller;
    let retryTimer;
    let timeout;

    async function check() {
        if (stopped || controller) return;
        clearTimeout(retryTimer);
        settled = false;
        onState({ checking: true, retrying: attempt > 0, error: '' });
        controller = new AbortController();
        const active = controller;
        timeout = setTimeout(() => active.abort(), 10000);
        try {
            const result = await request('/api/me', { cache: 'no-store', signal: active.signal });
            if (stopped) return;
            active.signal.throwIfAborted();
            settled = true;
            attempt = 0;
            onState({ checking: false, retrying: false, error: '' });
            onAuthenticated(result);
        } catch (cause) {
            if (stopped) return;
            if (cause.status === undefined || cause.status === 408 || cause.status >= 500) {
                // Only retry this read: replaying writes could duplicate user actions.
                const delay = Math.min(15000, 1000 * 2 ** Math.min(attempt++, 4));
                onState({ checking: true, retrying: true, error: '' });
                retryTimer = setTimeout(check, delay);
            } else {
                settled = true;
                attempt = 0;
                onState({ checking: false, retrying: false, error: cause.status === 401 ? '' : cause.message });
            }
        } finally {
            clearTimeout(timeout);
            controller = null;
        }
    }

    function wake() {
        if (!settled && documentTarget.visibilityState !== 'hidden' && windowTarget.navigator?.onLine !== false) {
            void check();
        }
    }

    windowTarget.addEventListener('online', wake);
    documentTarget.addEventListener('visibilitychange', wake);
    return {
        check,
        dispose() {
            stopped = true;
            clearTimeout(retryTimer);
            clearTimeout(timeout);
            controller?.abort();
            windowTarget.removeEventListener('online', wake);
            documentTarget.removeEventListener('visibilitychange', wake);
        },
    };
}
