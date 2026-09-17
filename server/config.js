import path from 'node:path';

export const config = {
  port: Number(process.env.PORT || 3000),
  host: process.env.HOST || '127.0.0.1',
  dataDir: path.resolve(process.env.DATA_DIR || 'data'),
  ffmpeg: process.env.FFMPEG_PATH || 'ffmpeg',
  ffprobe: process.env.FFPROBE_PATH || '',
  ytdlp: process.env.YTDLP_PATH || 'yt-dlp',
  ytdlpCookiesFile: process.env.YTDLP_COOKIES_FILE || '',
  youtubeProxy: process.env.YOUTUBE_PROXY || '',
  secureCookies: process.env.SECURE_COOKIES === 'true',
  trustProxy: process.env.TRUST_PROXY === 'true',
  origins: (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(value => value.trim()),
  bareMetalOrigin: process.env.BARE_METAL_ORIGIN || '',
  edgeProxySecret: process.env.EDGE_PROXY_SECRET || '',
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES || 10 * 1024 ** 3),
  maxStorageBytes: Number(process.env.MAX_STORAGE_BYTES || 30 * 1024 ** 3),
  maxUserStorageBytes: Number(process.env.MAX_USER_STORAGE_BYTES || Math.max(1, Math.floor(Number(process.env.MAX_STORAGE_BYTES || 30 * 1024 ** 3) / 2))),
  maxUploads: Number(process.env.MAX_UPLOADS || 200),
  maxUserUploads: Number(process.env.MAX_USER_UPLOADS || 100),
  uploadIdleTimeoutMs: Number(process.env.UPLOAD_IDLE_TIMEOUT_MS || 24 * 60 * 60 * 1000),
  maxTranscoders: Number(process.env.MAX_TRANSCODERS || 4),
  cleanupIntervalMs: Number(process.env.CLEANUP_INTERVAL_MS || 60000),
  maxQueue: 500,
  maxRooms: 30,
};

export function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

export function text(value, label, max = 80) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max) {
    throw httpError(400, `${label} must be between 1 and ${max} characters.`);
  }
  return value.trim();
}
