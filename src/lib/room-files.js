import {api} from './api.js';
import {delivery, DeliveryError, sharedFileUrl} from './delivery.js';

function wait(ms, signal) {
    return new Promise((resolve, reject) => {
        signal.throwIfAborted();
        const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
        const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason); };
        const timer = setTimeout(done, ms);
        signal.addEventListener('abort', abort, {once: true});
    });
}

export async function transferRoomFile(file, saved, {signal, onProgress = () => {}, request = api,
    getConfig = () => delivery.getConfig(), retryWait = wait} = {}) {
    if (file.name !== saved.name || file.size !== saved.size ||
        (saved.lastModified != null && file.lastModified !== saved.lastModified)) {
        throw new Error('Choose the original file with the same name, size and modification time.');
    }
    const statusUrl = `/api/files/${encodeURIComponent(saved.id)}`;
    let status = null;
    let retries = 0;
    let config;
    while (true) {
        signal.throwIfAborted();
        try {
            const timeout = AbortSignal.timeout(status ? 120000 : 15000);
            const requestSignal = AbortSignal.any([signal, timeout]);
            if (!status) status = await request(statusUrl, {signal: requestSignal});
            if (!Number.isSafeInteger(status?.received) || status.received < 0 || status.received > file.size ||
                typeof status.complete !== 'boolean' || status.complete !== (status.received === file.size) ||
                !Number.isSafeInteger(status.chunkSize) || status.chunkSize <= 0 || status.chunkSize > 524288) {
                throw new DeliveryError('The server returned an invalid file upload status.');
            }
            signal.throwIfAborted();
            onProgress({...status, retrying: false});
            if (status.complete) return status;
            config ??= await getConfig();
            signal.throwIfAborted();
            const destination = sharedFileUrl(saved.id, status.transferUrl, config);
            const offset = status.received;
            const chunk = file.slice(offset, Math.min(offset + status.chunkSize, file.size));
            status = await request(`${destination}${destination.includes('?') ? '&' : '?'}offset=${offset}`, {
                method: 'PUT', body: chunk, signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]),
            });
            if (status.received <= offset) throw new Error('The server did not acknowledge the file chunk.');
            retries = 0;
        } catch (error) {
            signal.throwIfAborted();
            if (error instanceof DeliveryError || (error.status && error.status < 500 && ![408, 409, 429].includes(error.status)) ||
                error.status === 507) throw error;
            if (error.status === 409 && retries >= 5) throw error;
            retries = Math.min(retries + 1, 6);
            onProgress({retrying: true});
            status = null; // Always recover the committed offset before resending.
            await retryWait(Math.min(15000, 1000 * 2 ** (retries - 1)), signal);
        }
    }
}
