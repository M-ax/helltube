export function watchDeployment({ buildId, fetchVersion = (...args) => fetch(...args),
    reload = () => window.location.reload(), windowTarget = window, documentTarget = document,
    intervalMs = 30000 } = {}) {
    let stopped = false;
    let reloading = false;
    let request;

    async function check() {
        if (stopped || reloading || request) return;
        const controller = new AbortController();
        request = controller;
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
            const response = await fetchVersion(`/version.json?check=${Date.now()}`, {
                cache: 'no-store', credentials: 'same-origin', signal: controller.signal,
            });
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return;
            const version = await response.json();
            if (stopped || controller.signal.aborted || typeof version?.buildId !== 'string' ||
                !/^[a-f0-9-]{36}$/.test(version.buildId) || version.buildId === buildId) return;
            reloading = true;
            reload();
        } catch { /* Retry after network errors and deployment interruptions. */ }
        finally {
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
