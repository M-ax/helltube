import {app, BrowserWindow, desktopCapturer, ipcMain, nativeImage, net, protocol, powerSaveBlocker, session} from 'electron';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {CasterConnection} from './connection.js';
import {NativeAudio} from './audio.js';
import {NativeVideo} from './video.js';

const here = path.dirname(fileURLToPath(import.meta.url));
protocol.registerSchemesAsPrivileged([{scheme: 'caster', privileges: {standard: true, secure: true, supportFetchAPI: true, stream: true}}]);
app.setName('Helltube Caster');
if (!app.requestSingleInstanceLock()) app.quit();
else {
    let window, armed, wakeLock, captureEpoch = 0;
    let sources = new Map();
    const wayland = process.platform === 'linux' && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);
    const connection = new CasterConnection();
    const emit = message => {
        if (message.type === 'video-ended') stopCapture();
        if (window && !window.isDestroyed()) window.webContents.send(
            message.type === 'video-frame' ? 'caster:video-frame' : 'caster:event', message);
    };
    const helper = path.join(app.isPackaged ? process.resourcesPath : path.join(here, '..'), 'native',
        ...(app.isPackaged ? [] : ['bin']), 'helltube-audio.exe');
    const audio = new NativeAudio({helper, emit});
    const video = new NativeVideo({helper: path.join(path.dirname(helper), 'helltube-video.exe'), emit});
    const stopCapture = () => {
        captureEpoch++; armed = null; audio.stopAll(); video.stop();
        if (wakeLock !== undefined && powerSaveBlocker.isStarted(wakeLock)) powerSaveBlocker.stop(wakeLock);
        wakeLock = undefined;
    };
    connection.on('event', message => {
        if ((message.type === 'connection' && message.status !== 'connected') || message.type === 'session-ended') stopCapture();
        emit(message);
    });
    app.on('second-instance', () => { window?.restore(); window?.focus(); });
    void app.whenReady().then(async () => {
    const rendererRoot = path.resolve(here, '../dist');
    session.fromPartition('caster').protocol.handle('caster', request => {
        const url = new URL(request.url);
        if (url.host !== 'app') return new Response('', {status: 404});
        let file;
        try { file = path.resolve(rendererRoot, '.' + decodeURIComponent(url.pathname)); }
        catch { return new Response('', {status: 400}); }
        if (!file.startsWith(rendererRoot + path.sep)) return new Response('', {status: 403});
        return net.fetch(pathToFileURL(file).href);
    });
    window = new BrowserWindow({title: 'Helltube Caster', width: 1380, height: 940, minWidth: 960, minHeight: 680,
        icon: path.join(here, '../assets/icon.png'),
        backgroundColor: '#101115', autoHideMenuBar: true,
        webPreferences: {preload: path.join(here, 'preload.cjs'), nodeIntegration: false, contextIsolation: true,
            sandbox: true, webSecurity: true, backgroundThrottling: false, partition: 'caster'}});
    const contents = window.webContents;
    const trusted = event => event.sender === contents && event.senderFrame === contents.mainFrame && event.senderFrame.url === 'caster://app/index.html';
    const handle = (name, callback) => ipcMain.handle(`caster:${name}`, (event, value) => {
        if (!trusted(event)) throw new Error('Untrusted caster frame.');
        return callback(value);
    });
    contents.setWindowOpenHandler(() => ({action: 'deny'}));
    contents.on('will-navigate', event => event.preventDefault());
    contents.on('will-attach-webview', event => event.preventDefault());
    contents.session.setPermissionCheckHandler((webContents, permission, _origin, details) =>
        webContents === contents && details.requestingUrl?.startsWith('caster://app/') && ['media', 'display-capture'].includes(permission));
    contents.session.setPermissionRequestHandler((webContents, permission, callback) =>
        callback(webContents === contents && contents.getURL() === 'caster://app/index.html' && ['media', 'display-capture'].includes(permission)));
    contents.session.setDisplayMediaRequestHandler(async (request, callback) => {
        const selection = armed; armed = null;
        const epoch = captureEpoch;
        if (request.frame !== contents.mainFrame || !selection || selection.expires < Date.now()) { callback({}); return; }
        try {
            const available = wayland ? await desktopCapturer.getSources({types: ['screen', 'window']}) : [...sources.values()];
            if (epoch !== captureEpoch || contents.isDestroyed()) { callback({}); return; }
            const source = wayland ? available[0] : available.find(item => item.id === selection.id);
            if (!source) { callback({}); return; }
            wakeLock = powerSaveBlocker.start('prevent-app-suspension');
            callback({video: source});
        } catch { callback({}); }
    });
    handle('login', value => connection.login(value));
    handle('logout', () => { stopCapture(); return connection.logout(); });
    handle('command', value => {
        if (!value || !['join', 'desktop:start', 'desktop:stop', 'desktop:request', 'desktop:unwatch'].includes(value.type)) return false;
        return connection.send(value);
    });
    handle('sources', async value => {
        const kind = typeof value === 'string' ? value : value?.kind;
        if (process.platform === 'win32' && value?.backend === 'native') {
            const available = await video.list(kind);
            return {portal: false, sources: available.map(source => ({id: source.id, name: source.name,
                width: source.width, height: source.height,
                thumbnail: source.image ? nativeImage.createFromBitmap(Buffer.from(source.image.data, 'base64'),
                    {width: source.image.width, height: source.image.height}).toDataURL() : ''}))};
        }
        if (wayland) return {portal: true, sources: [{id: 'portal', name: 'Choose a screen or window', thumbnail: ''}]};
        const available = await desktopCapturer.getSources({types: [kind === 'window' ? 'window' : 'screen'],
            thumbnailSize: {width: 400, height: 225}, fetchWindowIcons: true});
        sources = new Map(available.map(source => [source.id, source]));
        return {portal: false, sources: available.map(source => ({id: source.id, name: source.name,
            thumbnail: source.thumbnail.toDataURL(), icon: source.appIcon?.toDataURL()}))};
    });
    handle('arm', id => {
        if (video.capture) throw new Error('Stop native capture before using Chromium capture.');
        if ((wayland && id !== 'portal') || (!wayland && !sources.has(id))) throw new Error('Refresh and select an available capture source.');
        armed = {id, expires: Date.now() + 30000};
    });
    handle('audio-list', () => audio.list());
    handle('audio-start', id => audio.start(id));
    handle('audio-stop', id => audio.stop(id));
    handle('capture-stop', stopCapture);
    handle('video-start', async value => {
        if (process.platform !== 'win32') throw new Error('Native video capture is only available on Windows.');
        const epoch = captureEpoch;
        const result = await video.start(value);
        if (epoch !== captureEpoch) throw new Error('Native capture was cancelled.');
        if (wakeLock === undefined) wakeLock = powerSaveBlocker.start('prevent-app-suspension');
        return result;
    });
    handle('video-stop', id => { if (video.capture?.id === id) stopCapture(); });
    ipcMain.on('caster:video-ack', (event, value) => { if (trusted(event)) video.acknowledge(value?.id, value?.sequence); });
    ipcMain.on('caster:audio-ack', (event, value) => { if (trusted(event)) audio.acknowledge(value?.id, value?.sequence); });
    contents.on('render-process-gone', () => { stopCapture(); connection.disconnect(); });
    window.on('closed', () => { stopCapture(); connection.disconnect(); window = null; });
    app.on('before-quit', () => { stopCapture(); connection.disconnect(); });
    app.on('window-all-closed', () => app.quit());
    await window.loadURL('caster://app/index.html');
    }).catch(error => { console.error('Caster could not start:', error.message); app.quit(); });
}
