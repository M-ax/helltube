import {spawn} from 'node:child_process';
import {randomUUID} from 'node:crypto';

// The guest key is restricted to its bridge command. Neither room input nor
// Spotify URLs are ever interpolated into an SSH command or a shell.
export class SpotifyDesktopBridge {
  constructor(config, {launch = spawn} = {}) {
    this.config = config;
    this.launch = launch;
    this.pending = new Map();
  }

  connect() {
    if (this.process) return;
    const {spotifyDesktopKey, spotifyDesktopKnownHosts, spotifyDesktopPort = 22022} = this.config;
    if (!spotifyDesktopKey || !spotifyDesktopKnownHosts || !Number.isInteger(spotifyDesktopPort) ||
        spotifyDesktopPort < 1 || spotifyDesktopPort > 65535) throw new Error('Invalid Spotify VM SSH configuration.');
    const process = this.launch('ssh', ['-T', '-p', String(spotifyDesktopPort), '-i', spotifyDesktopKey,
      '-o', `UserKnownHostsFile=${spotifyDesktopKnownHosts}`, '-o', 'StrictHostKeyChecking=yes',
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=5',
      '-o', 'ServerAliveInterval=5', '-o', 'ServerAliveCountMax=2', 'spotify@127.0.0.1'],
    {stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true});
    this.process = process;
    let buffer = '';
    const fail = () => {
      if (this.process !== process) return;
      this.process = null;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('The Spotify desktop is offline.'));
      }
      this.pending.clear();
      process.kill();
    };
    process.on('error', fail);
    process.on('exit', fail);
    process.stdin.on('error', fail);
    process.stderr.resume(); // SSH details and remote diagnostics are never sent to viewers.
    process.stdout.on('data', chunk => {
      buffer += chunk.toString();
      if (buffer.length > 65536) { fail(); return; }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        let response;
        try { response = JSON.parse(line); } catch { fail(); return; }
        const pending = this.pending.get(response.id);
        if (!pending) continue;
        this.pending.delete(response.id);
        clearTimeout(pending.timer);
        if (response.error) pending.reject(new Error(response.error));
        else pending.resolve(response.data);
      }
    });
  }

  request(action, data = {}) {
    if (this.closed) return Promise.reject(new Error('The Spotify desktop connection is closed.'));
    this.connect();
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('The Spotify desktop did not respond.'));
        this.process?.kill();
      }, 10000);
      this.pending.set(id, {resolve, reject, timer});
      this.process.stdin.write(JSON.stringify({...data, action, id}) + '\n');
    });
  }

  close() {
    this.closed = true;
    this.process?.stdin.end();
    this.process?.kill();
  }
}
