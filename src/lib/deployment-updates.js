import { normalizeCommit } from '../../shared/deployment.js';

export function watchDeployment({ buildId, fetchVersion = (...args) => fetch(...args),
    reload = () => window.location.reload(), windowTarget = window, documentTarget = document,
    intervalMs = 30000, canReload = () => true, onBackendCommit,
    fetchBackend = (...args) => fetch(...args) } = {}) {
    let stopped = false;
    let reloading = false;
    let request;

    async function check() {
        if (stopped || reloading || request) return;
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        const options = { cache: 'no-store', credentials: 'same-origin', signal: controller.signal };
        const backend = buildId || onBackendCommit ? (async () => {
            try {
                const response = await fetchBackend('/api/version', options);
                if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
                const version = await response.json();
                if (!version || !Object.hasOwn(version, 'commit')) return;
                const commit = normalizeCommit(version.commit);
                if (!stopped && !controller.signal.aborted) onBackendCommit?.(commit);
                return { commit };
            } catch { /* Keep the last known backend commit through deployment outages. */ }
        })() : Promise.resolve();
        try {
            if (!buildId) return;
            const response = await fetchVersion(`/version.json?check=${Date.now()}`, options);
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
            const version = await response.json();
            if (stopped || controller.signal.aborted || typeof version?.buildId !== 'string' ||
                !/^[a-f0-9-]{36}$/.test(version.buildId) || version.buildId === buildId) return;
            // The Worker publishes before metal builds and restarts. Preserve the
            // running page until this check sees metal ready for the new frontend.
            const running = await backend;
            const commit = normalizeCommit(version.commit);
            if (stopped || controller.signal.aborted || !running ||
                (commit && running.commit && commit !== running.commit) || !canReload()) return;
            reloading = true;
            reload();
        } catch { /* Retry after network errors and deployment interruptions. */ }
        finally {
            await backend;
            clearTimeout(timeout);
            request = null;
        }
    }

    const visible = () => { if (documentTarget.visibilityState === 'visible') void check(); };
    const timer = setInterval(check, intervalMs);
    windowTarget.addEventListener('online', check);
    documentTarget.addEventListener('visibilitychange', visible);
    void check();
    return () => {
        stopped = true;
        clearInterval(timer);
        request?.abort();
        windowTarget.removeEventListener('online', check);
        documentTarget.removeEventListener('visibilitychange', visible);
    };
}
