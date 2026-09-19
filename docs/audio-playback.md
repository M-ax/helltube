# Audio links and visualizations

Paste links into **Media link**, then add them to the shared queue.

- **SoundCloud:** public tracks, playlists (up to 200 tracks), and SoundCloud short links. Requires FFmpeg and an up-to-date yt-dlp on the server. SoundCloud uses the normal synchronized playback, seeking, encrypted media delivery, and queue advancement. Private, removed, region-restricted, and subscription-only tracks may not play.
- **Spotify:** track, album, playlist, artist, episode, and show links from `open.spotify.com`, including localized and embed URLs. By default, the official Spotify player handles playback on each device; availability, previews, and sign-in depend on Spotify. Playback and volume are local. **Skip** and **Previous** manage the shared queue. Embed mode does not auto-advance the room or claim a synchronized playhead. Shortened `spotify.link` links must first be opened to obtain the full Spotify URL. The optional [Spotify desktop VM](../tools/spotify-vm/README.md) provides shared video/audio playback through the desktop relay instead.
- **Hosted audio:** existing HTTP/HTTPS audio files automatically show the visualization library when the browser detects audio without video.

The library contains all six classic Winamp analyzer/oscilloscope styles and **395 unique MilkDrop presets** from Butterchurn's base, Extra, Extra 2, and MilkDrop 1 packs. Search by preset or artist, choose a random preset, or enable a 30-second shuffle. The selection is saved on the current device. Native AVS and third-party Winamp plug-in binaries are not supported; this is not every visualization ever released for Winamp.

SoundCloud and hosted audio drive the effects through a Web Audio analyzer. The built-in effects render in the existing player's WebGL canvas. MilkDrop renders into an offscreen WebGL 2 canvas that is composited into the same player underneath its reactions and controls. Effects stop animating while playback is paused, the tab is hidden, or reduced motion is requested. Turning visualizations off does not turn audio off. Unsupported graphics do not prevent audio playback.

Spotify's cross-origin embedded player does not expose its audio samples. MilkDrop can animate ambient visuals; spectrum and oscilloscope modes have no audio signal. The library explains this limitation rather than showing invented beat analysis. Spotify embeds are removed on disconnection, item changes, and local desktop capture to stop their playback.

Preset packs are loaded on demand. The Vite plug-in in `scripts/milkdrop-presets.mjs` converts the pinned preset equations into regular functions during the build, preserving `script-src 'self'` without `unsafe-eval`. The content policy permits Spotify frames and SoundCloud artwork. Embed mode needs no Spotify credentials or new server secrets; the optional VM uses a private Spotify session and a restricted SSH bridge.

## Validation

```sh
npm run build
node --test test/audio-sources.test.js test/audio-visualizations.test.js test/audio.browser.integration.js
npm test
```

The browser integration test uses real audio-only HLS and WebGL, with local SoundCloud media and Spotify frame fixtures. It checks classic modes, the MilkDrop library, source reuse, playback controls, context recovery, and mobile layout. It does not require a Spotify account or depend on live SoundCloud extraction.

## Sources and licenses

- [Spotify embeds](https://developer.spotify.com/documentation/embeds) and [iframe API](https://developer.spotify.com/documentation/embeds/references/iframe-api).
- [yt-dlp SoundCloud extractor](https://github.com/yt-dlp/yt-dlp/blob/master/yt_dlp/extractor/soundcloud.py).
- [Butterchurn](https://github.com/jberg/butterchurn), MIT, and [Butterchurn presets](https://github.com/jberg/butterchurn-presets), MIT. Original preset author credits remain in the library names and package data. These are community browser ports, not an official Winamp integration.
