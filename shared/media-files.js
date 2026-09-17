export const encryptedMediaFile = /^(?:init\.mp4|segment-\d{6,}\.(?:ts|m4s))$/;
export const publicMediaFile = /^(?:index\.m3u8|init\.mp4|segment-\d{6,}\.(?:ts|m4s))$/;

export function mediaContentType(file) {
  return file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl'
    : file.endsWith('.ts') ? 'video/mp2t' : 'video/mp4';
}
