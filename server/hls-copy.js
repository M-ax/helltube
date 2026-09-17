// Inputs have already passed the provider's URL validation. Unknown codecs retain
// the standard encoder; browser support for VP9/AV1 is checked during playback.
export function hlsCopyQuality(formats, {allowFiles = false} = {}) {
  if (!formats.length || formats.length > 2) return null;
  const format = formats[0];
  if (formats.some(input => input.has_drm || !(/^m3u8(?:_native)?$/.test(input.protocol || '') ||
    (allowFiles && /^https?$/.test(input.protocol || ''))))) return null;
  const h264 = /^(?:h264|avc1\.(?:42|4d|58|64)[0-9a-f]{4})$/i.test(format.vcodec || '');
  const modern = /^(?:vp9|vp09|av1|av01)(?:\.|$)/i.test(format.vcodec || '');
  if ((!h264 && !modern) || (h264 && format.pix_fmt && format.pix_fmt !== 'yuv420p')) return null;
  const audio = formats.at(-1);
  if (formats.length === 2 && (audio.vcodec !== 'none' || audio.acodec === 'none')) return null;
  if (!/^(?:aac|mp4a\.40\.2|opus|none)$/i.test(audio.acodec || '')) return null;
  const height = Number(format.height);
  return {label: Number.isSafeInteger(height) && height > 0 ? `Original (${height}p)` : 'Original',
    ...(/^(?:aac|mp4a\.40\.2)$/i.test(audio.acodec) ? {aacAudio: true} : {}),
    ...(modern || /^opus$/i.test(audio.acodec) ? {container: 'fmp4'} : {})};
}
