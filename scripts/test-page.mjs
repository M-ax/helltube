import {createServer as createViteServer} from 'vite';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir, mkdtemp, rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {createApp} from '../server/app.js';
import {makeItem} from '../server/rooms.js';

// This separate launcher always uses disposable data and loopback listeners.
// The normal dev/start commands retain the ordinary account/session behavior.
const artifacts = path.resolve('test-artifacts');
await mkdir(artifacts, {recursive: true});
const dataDir = await mkdtemp(path.join(artifacts, '.test-page-'));
let instance;
let vite;
let stopping;
async function close() {
    if (stopping) return stopping;
    stopping = (async () => {
        await vite?.close();
        await instance?.close();
        const relative = path.relative(artifacts, dataDir);
        if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Invalid test-page data directory.');
        await rm(dataDir, {recursive: true, force: true, maxRetries: 5, retryDelay: 100});
    })();
    return stopping;
}

try {
    instance = await createApp({dataDir, host: '127.0.0.1', port: 0, desktopPort: 0,
        bareMetalOrigin: '', edgeProxySecret: '', secureCookies: false, trustProxy: false,
        spotifyDesktopKey: '', desktopIceServers: '[]', desktopTurnSecret: '',
        origins: ['http://localhost:5173', 'http://127.0.0.1:5173']});
    await instance.accounts.create({username: 'test_guest', displayName: 'Test guest',
        password: randomUUID(), role: 'user'});
    const guest = instance.accounts.users.find(user => user.username === 'test_guest');
    let session = instance.accounts.createSession(guest);
    function guestSession(req) {
        if (!instance.accounts.authenticate('session=' + session.token)) session = instance.accounts.createSession(guest);
        req.headers.cookie = 'session=' + session.token;
    }
    // Both HTTP and WebSockets use a real, non-admin guest in this test database.
    instance.server.prependListener('request', guestSession);
    instance.server.prependListener('upgrade', guestSession);
    const backend = await instance.listen(0);
    const room = instance.rooms.get('lobby');
    room.name = 'Reaction test room';

    if (instance.capabilities.ffmpeg) {
        const sample = path.join(dataDir, 'sample.mp4');
        await promisify(execFile)(instance.media.config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y',
            '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=24',
            '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=48000',
            '-t', '120', '-c:v', 'libvpx-vp9', '-deadline', 'realtime', '-cpu-used', '8', '-b:v', '900k', '-g', '48',
            '-pix_fmt', 'yuv420p', '-c:a', 'libopus', '-af', 'volume=0.25',
            '-movflags', 'frag_keyframe+empty_moov', sample]);
        // Keep the original VP9/Opus rendition for embedded browsers that
        // cannot decode the application's standard H.264/AAC upload rendition.
        const sampleURL = backend + '/test-sample.mp4';
        instance.app.get('/test-sample.mp4', (_req, res) => res.sendFile(sample, {dotfiles: 'allow'}));
        const resolveTwitch = instance.twitch.resolve.bind(instance.twitch);
        instance.twitch.resolve = url => url === sampleURL ? Promise.resolve({
            duration: 120, copyQuality: {label: 'Original (test video)', container: 'fmp4'},
            inputs: [{url: sampleURL, headers: {}}],
        }) : resolveTwitch(url);
        instance.rooms.add(room, [makeItem({kind: 'twitch', url: sampleURL},
            {title: 'Reaction test video', duration: 120, addedBy: 'Test guest'})]);
        const deadline = Date.now() + 30000;
        while (!room.current?.media?.qualities?.some(quality => quality.id === 'original' && quality.complete) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        instance.rooms.control(room, {action: 'pause', revision: room.playback.revision});
        instance.rooms.control(room, {action: 'seek', position: 0, revision: room.playback.revision});
    }

    vite = await createViteServer({mode: 'test-page', server: {
        host: '127.0.0.1', port: 5173, strictPort: true,
        proxy: {'/api': backend, '/media': backend, '/direct': backend,
            '/ws': {target: backend.replace('http:', 'ws:'), ws: true}},
    }});
    await vite.listen();
    console.log('Test page ready at http://localhost:5173/ — no login required.');
    console.log('Press Play to start the sample video, or upload your own.');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => {
        void close().then(() => process.exit(0), error => { console.error(error); process.exit(1); });
    });
} catch (error) {
    await close();
    throw error;
}
