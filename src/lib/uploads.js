import {get, writable} from 'svelte/store';
import {api} from './api.js';
import {delivery, DeliveryError, uploadTransferUrl} from './delivery.js';

export const videoFileAccept = 'video/*,.mkv,.mov,.mp4,.webm,.avi,.m4v,.ts,.mts,.m2ts,.m2t,.mpg,.mpeg,.mpe,.m1v,.m2v,.ogv,.ogm,.3gp,.3g2,.flv,.f4v,.wmv,.asf,.vob,.divx,.qt,.mxf,.rm,.rmvb';

export function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const abort = () => {
            clearTimeout(timer);
            reject(new DOMException('Aborted', 'AbortError'));
        };
        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', abort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', abort, {once: true});
    });
}

export function readVideoMetadata(file, signal) {
    return new Promise((resolve, reject) => {
        signal?.throwIfAborted();
        const video = document.createElement('video');
        const url = URL.createObjectURL(file);
        let timer;
        let settled = false;
        const finish = (aborted = false) => {
            if (settled) return;
            settled = true;
            const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : undefined;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            video.onloadedmetadata = null;
            video.onerror = null;
            video.removeAttribute('src');
            video.load();
            URL.revokeObjectURL(url);
            if (aborted) reject(new DOMException('Aborted', 'AbortError'));
            else resolve(duration);
        };
        const abort = () => finish(true);
        video.preload = 'metadata';
        video.muted = true;
        video.onloadedmetadata = () => finish();
        video.onerror = () => finish();
        signal?.addEventListener('abort', abort, {once: true});
        timer = setTimeout(() => finish(), 10000);
        video.src = url;
    });
}

export function createUploadManager(userId, {
    request = api,
    getDeliveryConfig = delivery.getConfig,
    wait = sleep,
    now = () => performance.now(),
    metadata = readVideoMetadata,
    statusTimeoutMs = 15000,
    chunkTimeoutMs = 120000,
    windowTarget = typeof window === 'undefined' ? null : window,
    onError = () => {}
} = {}) {
    const transfers = writable([]);
    const workers = new Map();
    const retryWaiters = new Map();
    const pending = new Set();
    let disposed = false;
    const restoreController = new AbortController();
    const ready = request('/api/uploads', {signal: restoreController.signal}).then(({uploads}) => {
        if (disposed) return;
        transfers.update(items => [...items, ...uploads.filter(saved => !items.some(item => item.id === saved.id)).map(item => ({
            ...item, state: 'needs-file', file: null, rate: 0, error: '',
        }))]);
        try { if (typeof window !== 'undefined') window.localStorage.removeItem(`helltube:uploads:${userId}`); } catch { /* Browser storage is optional. */ }
    }).catch(error => {
        if (!disposed) onError(`Could not restore uploads: ${error.message}`);
    });

    const patch = (id, values) => {
        if (!disposed) transfers.update((items) => items.map((item) => item.id === id ? {...item, ...values} : item));
    };
    const find = (id) => get(transfers).find((item) => item.id === id);

    function checkStatus(status, size) {
        if (!Number.isSafeInteger(status?.received) || status.received < 0 || status.received > size ||
            (status.complete && status.received !== size)) {
            throw new DeliveryError('The server returned an invalid upload offset. Pause and try resuming the file.');
        }
        return status;
    }

    function showStatus(id, status) {
        patch(id, {
            received: status.received, complete: status.complete, delayMs: status.delayMs,
            bufferSeconds: status.bufferSeconds, slow: status.slow, active: status.active, error: '',
        });
    }

    async function timedRequest(url, options, timeoutMs) {
        const timeout = new AbortController();
        const signal = AbortSignal.any([options.signal, timeout.signal]);
        const timer = setTimeout(() => timeout.abort(new DOMException('The upload request timed out.', 'TimeoutError')), timeoutMs);
        try {
            const result = await request(url, {...options, signal});
            signal.throwIfAborted();
            return result;
        } catch (error) {
            if (timeout.signal.aborted && !options.signal.aborted) throw timeout.signal.reason;
            throw error;
        } finally { clearTimeout(timer); }
    }

    async function waitToRetry(id, delay, signal) {
        const wake = new AbortController();
        retryWaiters.set(id, wake);
        try {
            await wait(delay, AbortSignal.any([signal, wake.signal]));
        } catch (error) {
            if (signal.aborted || !wake.signal.aborted) throw error;
        } finally {
            if (retryWaiters.get(id) === wake) retryWaiters.delete(id);
        }
    }

    function reconnect() {
        // Wake only recovery waits; paused transfers and in-flight chunks stay untouched.
        for (const wake of retryWaiters.values()) wake.abort();
    }
    windowTarget?.addEventListener('online', reconnect);

    function hasPendingFiles() {
        return !disposed && (pending.size > 0 || get(transfers).some(item => item.file && item.state !== 'complete'));
    }

    async function run(id) {
        const item = find(id);
        if (!item?.file || disposed || workers.has(id)) return;
        const controller = new AbortController();
        const {signal} = controller;
        workers.set(id, controller);
        patch(id, {state: 'checking', error: '', rate: 0});
        let status = null;
        let config;
        let retries = 0;
        try {
            while (!signal.aborted) {
                try {
                    if (!status) status = checkStatus(await timedRequest(`/api/uploads/${encodeURIComponent(id)}`, {signal}, statusTimeoutMs), item.size);
                    signal.throwIfAborted();
                    showStatus(id, status);
                    if (status.complete) {
                        patch(id, {state: 'complete', file: null, rate: 0, error: ''});
                        break;
                    }
                    const delay = Number.isFinite(status.delayMs) ? Math.max(0, status.delayMs) : 0;
                    if (status.active === false || status.received === item.size) {
                        patch(id, {state: 'waiting', rate: 0});
                        await wait(Math.max(1000, delay), signal);
                        status = null;
                        continue;
                    }
                    patch(id, {state: delay ? 'pacing' : 'uploading', error: ''});
                    if (delay) await wait(delay, signal);
                    signal.throwIfAborted();
                    config ??= await getDeliveryConfig();
                    signal.throwIfAborted();
                    const destination = uploadTransferUrl(id, status.transferUrl, config);
                    const offset = status.received;
                    const chunk = item.file.slice(offset, Math.min(offset + item.chunkSize, item.size));
                    patch(id, {state: 'uploading'});
                    // Only the PUT round trip is measured. Server-imposed waits never reduce the measured transfer rate.
                    const started = now();
                    status = checkStatus(await timedRequest(`${destination}${destination.includes('?') ? '&' : '?'}offset=${offset}`, {
                        method: 'PUT', body: chunk, signal,
                    }, chunkTimeoutMs), item.size);
                    const elapsed = Math.max(1, now() - started);
                    signal.throwIfAborted();
                    if (status.received <= offset && !status.complete) {
                        throw new Error('The server did not acknowledge the chunk. Checking its saved offset before retrying.');
                    }
                    const rate = Math.max(0, status.received - offset) * 1000 / elapsed;
                    const previousRate = find(id)?.rate || 0;
                    patch(id, {rate: previousRate ? previousRate * 0.7 + rate * 0.3 : rate});
                    retries = 0;
                } catch (error) {
                    if (signal.aborted) throw error;
                    if (error instanceof DeliveryError) throw error;
                    if (error.status && error.status < 500 && ![408, 409, 429].includes(error.status)) throw error;
                    // Deployments and network outages can last minutes. Keep the File and
                    // retry until the backend returns; never replay a chunk before checking its offset.
                    const interrupted = error instanceof TypeError || error.name === 'TimeoutError' ||
                        [408, 429].includes(error.status) || (error.status >= 500 && error.status !== 507);
                    retries = Math.min(retries + 1, 6);
                    if (!interrupted && retries > 5) throw error;
                    patch(id, {state: 'retrying', error: error.message, rate: 0});
                    status = null;
                    await waitToRetry(id, Math.min(15000, 1000 * 2 ** (retries - 1)), signal);
                }
            }
        } catch (error) {
            if (!signal.aborted) patch(id, {state: 'error', error: error.message, rate: 0});
        } finally {
            if (workers.get(id) === controller) workers.delete(id);
        }
    }

    async function add(file, room, insertAt) {
        return addMany([file], room, insertAt);
    }

    async function addMany(files, room, insertAt) {
        if (disposed) throw new DOMException('Aborted', 'AbortError');
        const selected = Array.from(files || []);
        if (!selected.length || selected.length > 100) throw new Error('Choose between 1 and 100 videos at a time.');
        for (const file of selected) {
            if (!file?.size) throw new Error(`“${file?.name || 'This file'}” is empty. Choose a video with content; no files were added.`);
            if (!/^video\//i.test(file.type) && !videoFileAccept.split(',').slice(1).some(extension => file.name.toLowerCase().endsWith(extension))) {
                throw new Error(`“${file.name}” is not a supported video file. Choose only videos; no files were added.`);
            }
        }
        const roomId = room.id;
        const roomName = room.name;
        const controller = new AbortController();
        pending.add(controller);
        try {
            const descriptions = new Array(selected.length);
            let next = 0;
            await Promise.all(Array.from({length: Math.min(4, selected.length)}, async () => {
                while (next < selected.length) {
                    controller.signal.throwIfAborted();
                    const index = next++;
                    const file = selected[index];
                    const duration = await metadata(file, controller.signal);
                    controller.signal.throwIfAborted();
                    descriptions[index] = {
                        name: file.name, size: file.size, lastModified: file.lastModified, mime: file.type,
                        ...(Number.isFinite(duration) && duration > 0 ? {duration} : {}),
                    };
                }
            }));
            controller.signal.throwIfAborted();
            const batch = selected.length > 1;
            const result = await request(`/api/rooms/${encodeURIComponent(roomId)}/uploads${batch ? '/batch' : ''}`, {
                method: 'POST', signal: controller.signal,
                body: batch ? {files: descriptions, insertAt} : {...descriptions[0], insertAt},
            });
            controller.signal.throwIfAborted();
            const uploads = batch ? result?.uploads : [result];
            if (!Array.isArray(uploads) || uploads.length !== selected.length ||
                uploads.some(upload => typeof upload?.uploadId !== 'string' || !upload.uploadId) ||
                new Set(uploads.map(upload => upload.uploadId)).size !== selected.length) {
                throw new Error('The server returned an invalid upload response. Reload to restore any saved uploads.');
            }
            const additions = selected.map((file, index) => ({
                id: uploads[index].uploadId, roomId, roomName,
                name: file.name, size: file.size, lastModified: file.lastModified, file,
                chunkSize: Number.isSafeInteger(uploads[index].chunkSize) && uploads[index].chunkSize > 0 ? uploads[index].chunkSize : 524288,
                received: 0, state: 'checking', rate: 0, error: '', duration: descriptions[index].duration,
            }));
            transfers.update((items) => [...items, ...additions]);
            for (const item of additions) void run(item.id);
            return result;
        } finally {
            controller.abort();
            pending.delete(controller);
        }
    }

    function pause(id) {
        workers.get(id)?.abort();
        workers.delete(id);
        patch(id, {state: 'paused', rate: 0});
    }

    function resume(id, file) {
        const item = find(id);
        if (!item) return;
        if (file && (file.name !== item.name || file.size !== item.size || (item.lastModified != null && file.lastModified !== item.lastModified))) {
            throw new Error('Choose the original, unchanged file (same name, size, and modification time) to resume.');
        }
        if (file) patch(id, {file});
        if (!find(id).file) throw new Error('Reselect the original file to resume its upload.');
        void run(id);
    }

    async function cancel(id) {
        pause(id);
        patch(id, {state: 'cancelling', error: ''});
        try {
            await request(`/api/uploads/${encodeURIComponent(id)}`, {method: 'DELETE'});
            transfers.update((items) => items.filter((item) => item.id !== id));
        } catch (error) {
            if (error.status === 404) transfers.update((items) => items.filter((item) => item.id !== id));
            else patch(id, {state: 'error', error: `Could not cancel: ${error.message}`});
        }
    }

    function dismiss(id) {
        if (find(id)?.state === 'complete') transfers.update((items) => items.filter((item) => item.id !== id));
    }

    function dispose() {
        disposed = true;
        windowTarget?.removeEventListener('online', reconnect);
        restoreController.abort();
        for (const controller of [...workers.values(), ...pending]) controller.abort();
        workers.clear();
        pending.clear();
    }

    return {transfers, add, addMany, pause, resume, cancel, dismiss, dispose, ready, reconnect, hasPendingFiles};
}
