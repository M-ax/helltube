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

// FetchLoader uses this for manifests, keys, initialization data and segments.
// Refuse redirects before following them; XHR cannot enforce this policy.
export function directMediaRequest(source, context, init) {
    const root = new URL(source);
    const target = new URL(context.url);
    if (target.origin !== root.origin || target.username || target.password || target.hash ||
        target.pathname.slice(0, target.pathname.lastIndexOf('/') + 1) !== root.pathname.slice(0, root.pathname.lastIndexOf('/') + 1) ||
        !/^(index\.m3u8|key\.bin|init\.mp4|segment-\d{6,}\.(ts|m4s))$/.test(target.pathname.split('/').pop()) ||
        target.search !== root.search) throw new DeliveryError('Invalid direct media destination.');
    return new Request(target, {...init, credentials: 'omit', redirect: 'error', mode: 'cors'});
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

export function sharedFileUrl(id, value, config, download = false) {
    const origin = deliveryOrigin(config);
    if (typeof id === 'string' && /^[a-z0-9-]+$/i.test(id)) {
        const suffix = `/files/${encodeURIComponent(id)}${download ? '/download' : ''}`;
        if (!origin && (download ? value === `/api${suffix}` : value == null)) return `/api${suffix}`;
        const url = directUrl(value, origin, `/direct${suffix}`);
        if (url) return url;
    }
    throw new DeliveryError('The server supplied an invalid shared file URL.');
}

export function createDeliveryClient({request = api, origin = () => window.location.origin,
    now = () => performance.now()} = {}) {
    let configPromise;

    function getConfig() {
        if (!configPromise) {
            configPromise = Promise.resolve().then(() => request('/api/config')).then(config =>
                Object.freeze({bareMetalOrigin: deliveryOrigin(config),
                    ...(config.strifeDirectMedia === 1 ? {strifeDirectMedia: 1,
                        strifeDirectMediaOrigin: deliveryOrigin({bareMetalOrigin: config.strifeDirectMediaOrigin})} : {})})).catch(error => {
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
        const startedAt = now();
        const access = await request(`/api/media/${jobId}/access`, {signal});
        signal?.throwIfAborted();
        const path = `/media/${jobId}/index.m3u8`;
        const mediaOrigin = config.strifeDirectMedia === 1 ? config.strifeDirectMediaOrigin : config.bareMetalOrigin;
        const fallbackUrl = access?.fallbackUrl == null ? null
            : directUrl(access.fallbackUrl, mediaOrigin, `/direct${path}`);
        if (access?.fallbackUrl != null && !fallbackUrl) {
            throw new DeliveryError('The server supplied an invalid fallback media URL. Please retry playback.');
        }
        if (access?.url === path && config.strifeDirectMedia !== 1) return {url: `${currentOrigin}${path}`, fallbackUrl,
            route: config.bareMetalOrigin && currentOrigin !== config.bareMetalOrigin ? 'cloudflare' : 'local'};
        const url = directUrl(access?.url, mediaOrigin, `/direct${path}`);
        if (url) {
            if (config.strifeDirectMedia === 1) {
                try {
                    const grant = new URL(url).searchParams.get('grant');
                    if (!/^v2\.[a-f0-9]{64}\.[A-Za-z0-9_-]+\.[a-f0-9]{64}$/.test(grant)) throw new Error();
                    const policy = JSON.parse(atob(grant.split('.')[2].replace(/-/g, '+').replace(/_/g, '/')));
                    // Authenticated response metadata schedules renewal, not the client's wall clock.
                    // Subtract the entire request duration conservatively, including proxy latency.
                    // Decoding the grant is only a consistency check; metal verifies its signature.
                    const lifetime = access.expiresAt - access.issuedAt;
                    const renewDeadline = startedAt + lifetime;
                    if (policy.origin !== currentOrigin || policy.expires !== access.expiresAt ||
                        !Number.isSafeInteger(access.issuedAt) || !Number.isSafeInteger(access.expiresAt) ||
                        lifetime <= 0 || lifetime > 600000 || renewDeadline - now() <= 30000) throw new Error();
                    return {url, fallbackUrl: null, route: 'metal', secureDirect: true,
                        renewDeadline};
                } catch { throw new DeliveryError('Invalid or expired direct media grant. Retry playback.'); }
            }
            return {url, fallbackUrl: null, route: 'metal'};
        }
        throw new DeliveryError('The server supplied an invalid media access URL. Please retry playback.');
    }

    async function resolveMediaUrl(value, options) {
        return (await resolveMediaAccess(value, options)).url;
    }

    return {getConfig, resolveMediaUrl, resolveMediaAccess};
}

export const delivery = createDeliveryClient();
