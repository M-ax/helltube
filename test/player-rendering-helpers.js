// Install before navigating so startup, seeks and context restoration are covered.
export function observeVideoRendering() {
  window.videoTextureUploads = 0;
  window.videoFrameRequests = 0;
  const upload = WebGLRenderingContext.prototype.texImage2D;
  WebGLRenderingContext.prototype.texImage2D = function (...args) {
    if (args.at(-1) instanceof HTMLVideoElement) window.videoTextureUploads++;
    return upload.apply(this, args);
  };
  const request = HTMLVideoElement.prototype.requestVideoFrameCallback;
  if (request) HTMLVideoElement.prototype.requestVideoFrameCallback = function (...args) {
    if (this.matches('.video-viewport > video')) window.videoFrameRequests++;
    return request.apply(this, args);
  };
}

// Read immediately after drawing because the compositor discards WebGL buffers.
export function hasWebglOverlay(canvas) {
  window.dispatchEvent(new Event('resize'));
  const gl = canvas.getContext('webgl');
  const pixels = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
  return pixels.some((value, index) => index % 4 === 3 && value > 100);
}
