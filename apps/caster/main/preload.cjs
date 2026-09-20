const {contextBridge, ipcRenderer} = require('electron');
const invoke = (name, value) => ipcRenderer.invoke(`caster:${name}`, value).catch(error => {
    throw new Error(error.message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ''));
});
contextBridge.exposeInMainWorld('caster', Object.freeze({
    platform: process.platform,
    login: credentials => invoke('login', credentials),
    logout: () => invoke('logout'),
    command: message => invoke('command', message),
    sources: (kind, backend) => invoke('sources', {kind, backend}),
    armCapture: id => invoke('arm', id),
    audioSources: () => invoke('audio-list'),
    startAudio: id => invoke('audio-start', id),
    stopAudio: id => invoke('audio-stop', id),
    stopCapture: () => invoke('capture-stop'),
    startVideo: options => invoke('video-start', options),
    stopVideo: id => invoke('video-stop', id),
    onVideoFrame(callback) {
        const listener = async (_event, frame) => {
            try { await callback(frame); }
            finally { ipcRenderer.send('caster:video-ack', {id: frame.id, sequence: frame.sequence}); }
        };
        ipcRenderer.on('caster:video-frame', listener);
        return () => ipcRenderer.removeListener('caster:video-frame', listener);
    },
    onEvent(callback) {
        const listener = (_event, message) => {
            callback(message);
            if (message.type === 'audio-data') ipcRenderer.send('caster:audio-ack', {id: message.id, sequence: message.sequence});
        };
        ipcRenderer.on('caster:event', listener);
        return () => ipcRenderer.removeListener('caster:event', listener);
    },
}));
