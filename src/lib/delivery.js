import {api} from './api.js';

export class DeliveryError extends Error {
    constructor(message) {
        super(message);
        this.name = 'DeliveryError';
    }
}

function deliveryOrigin(config) {
    const value = config?.bareMetalOrigin;
    if (value === '') return '';
    try {
        const url = new URL(value);
        const loopback = url.hostname === 'localhost' || url.hostname === '[::1]' || /^127(?:\.\d{1,3}){3}$/.test(url.hostname);
        if (typeof value === 'string' && value === url.origin &&
            (url.protocol === 'https:' || (url.protocol === 'http:' && loopback))) return value;
    } catch { /* Only a canonical HTTP(S) origin is accepted. */ }
    throw new DeliveryError('The server supplied an invalid delivery configuration. Please retry.');
}

function directUrl(value, origin, path) {
    if (!origin || typeof value !== 'string') return null;
    try {
        const url = new URL(value);
        if (url.origin === origin && url.pathname === path && !url.username && !url.password && !url.hash &&
            value === `${origin}${path}${url.search}` && /^\?grant=[^&#\s]+$/.test(url.search) &&
            url.searchParams.size === 1 && url.searchParams.get('grant')?.trim()) return value;
    } catch { /* Invalid destinations must never fall back to the proxy. */ }
    return null;
}

export function isSameOriginUrl(value, origin = window.location.origin) {
    try {
        const url = new URL(value, origin);
        return url.origin === origin && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function uploadTransferUrl(id, transferUrl, config) {
    const origin = deliveryOrigin(config);
    if (typeof id === 'string' && /^[a-z0-9-]+$/i.test(id)) {
        if (!origin && transferUrl == null) return `/api/uploads/${encodeURIComponent(id)}`;
        const url = directUrl(transferUrl, origin, `/direct/uploads/${encodeURIComponent(id)}`);
        if (url) return url;
    }
    throw new DeliveryError('The server supplied an invalid direct upload URL. Pause and try resuming the file.');
}

export function createDeliveryClient({request = api, origin = () => window.location.origin} = {}) {
    let configPromise;

    function getConfig() {
        if (!configPromise) {
            configPromise = Promise.resolve().then(() => request('/api/config')).then(config =>
                Object.freeze({bareMetalOrigin: deliveryOrigin(config)})).catch(error => {
                configPromise = null;
                throw error;
            });
        }
        return configPromise;
    }

    async function resolveMediaAccess(value, {signal} = {}) {
        signal?.throwIfAborted();
        const currentOrigin = origin();
        let jobId;
        try {
            const url = new URL(value, currentOrigin);
            const match = /^\/media\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/index\.m3u8$/i.exec(url.pathname);
            if (match && url.origin === currentOrigin &&
                (value === url.pathname || value === `${currentOrigin}${url.pathname}`)) jobId = match[1];
        } catch { /* State must identify a same-origin media job, never a direct URL. */ }
        if (!jobId) {
            throw new DeliveryError('The server supplied an invalid media URL. Media must be served from this Helltube instance.');
        }
        const config = await getConfig();
        signal?.throwIfAborted();
        const access = await request(`/api/media/${jobId}/access`, {signal});
        signal?.throwIfAborted();
        const path = `/media/${jobId}/index.m3u8`;
        const fallbackUrl = access?.fallbackUrl == null ? null
            : directUrl(access.fallbackUrl, config.bareMetalOrigin, `/direct${path}`);
        if (access?.fallbackUrl != null && !fallbackUrl) {
            throw new DeliveryError('The server supplied an invalid fallback media URL. Please retry playback.');
        }
        if (access?.url === path) return {url: `${currentOrigin}${path}`, fallbackUrl,
            route: config.bareMetalOrigin && currentOrigin !== config.bareMetalOrigin ? 'cloudflare' : 'local'};
        const url = directUrl(access?.url, config.bareMetalOrigin, `/direct${path}`);
        if (url) return {url, fallbackUrl: null, route: 'metal'};
        throw new DeliveryError('The server supplied an invalid media access URL. Please retry playback.');
    }

    async function resolveMediaUrl(value, options) {
        return (await resolveMediaAccess(value, options)).url;
    }

    return {getConfig, resolveMediaUrl, resolveMediaAccess};
}

export const delivery = createDeliveryClient();
