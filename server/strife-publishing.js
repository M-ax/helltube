// A desktop capability contract, not a bitrate restriction on standalone OBS.
// H.264 level 5.2 accommodates 3840x2160 at 60 fps.
export const strifePublishing = Object.freeze({
  version: 1, width: 3840, height: 2160, fps: 60, bitrateKbps: 40000,
  audioBitrateKbps: 192, codec: 'h264', profile: 'baseline', level: '5.2',
});
