import { createApp } from './app.js';

const instance = await createApp();
const url = await instance.listen();
console.log(`Helltube listening at ${url}`);
console.log(`FFmpeg: ${instance.capabilities.ffmpeg ? 'ready' : 'MISSING'}; yt-dlp: ${instance.capabilities.youtube ? 'ready' : 'MISSING'}`);
if (instance.accounts.users.some(u => u.defaultPassword)) console.warn('Change the seeded admin password before exposing this server.');
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await instance.close();
    process.exit(0);
  });
}