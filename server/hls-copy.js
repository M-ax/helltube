// Only extractor-validated, muxed HLS with browser-compatible codecs can bypass encoding.
// Missing codec metadata is deliberately treated as unsuitable.
export function hlsCopyQuality(formats) {
  if (formats.length !== 1) return null;
  const format = formats[0];
  const hls = /^m3u8(?:_native)?$/.test(format.protocol || '');
  const video = /^(?:h264|avc1\.(?:42|4d|58|64)[0-9a-f]{4})$/i.test(format.vcodec || '');
  const audio = /^(?:aac|mp4a\.40\.2|none)$/i.test(format.acodec || '');
  if (!hls || !video || !audio || format.has_drm ||
      (format.pix_fmt && format.pix_fmt !== 'yuv420p')) return null;
  const height = Number(format.height);
  return {label: Number.isSafeInteger(height) && height > 0 ? `Original (${height}p)` : 'Original'};
}
