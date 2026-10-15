export class ApiError extends Error {
    constructor(message, status) {
        super(message);
        this.name = 'ApiError';
        this.status = status;
    }
}

export async function api(path, {body, headers, ...options} = {}) {
    const binary = body instanceof Blob || body instanceof ArrayBuffer;
    const response = await fetch(path, {
        ...options,
        credentials: 'same-origin',
        headers: {
            ...(body !== undefined ? {'Content-Type': binary ? 'application/octet-stream' : 'application/json'} : {}),
            ...headers,
        },
        ...(body !== undefined ? {body: binary ? body : JSON.stringify(body)} : {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        // Startup and realtime own their generation/cancellation checks. A late
        // 401 from an old connection attempt must not sign out a newer login.
        if (response.status === 401 && !['/api/login', '/api/me', '/api/realtime-ticket'].includes(path)) {
            window.dispatchEvent(new Event('helltube:session-ended'));
        }
        throw new ApiError(data.error || `Request failed (${response.status}). Please try again.`, response.status);
    }
    return data;
}
