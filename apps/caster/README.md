# Helltube Caster

A Windows/Linux desktop broadcaster for Helltube. Choose a monitor, application window, or rectangular monitor region; preview locally; select your audio sources; then publish to a room. It uses the **same authenticated WebSocket, mediasoup publisher, WebRTC relay, room membership, late joining, stop/skip behavior, and four-hour limit** as browser desktop sharing. No new ingest service or server configuration is needed.

## Run from this checkout

Install the root dependencies first (`npm ci`, Node.js 22.13+). Then, from the repository root:

```sh
npm run caster:install
npm run caster:build-native
npm run caster
```

The Windows helper build requires **CMake, Visual Studio C++ build tools with C++20 support, and a Windows 11 SDK**. Both helpers link the C++ runtime statically. On Linux the native build command just prepares the packaging directory; install `pulseaudio-utils` (provides `pactl` and `parec`) and run PulseAudio or PipeWire with its PulseAudio compatibility service (`pipewire-pulse`). For Debian/Ubuntu, `sudo apt install pulseaudio-utils` installs the client utilities.

`npm run caster:pack` creates an unpacked application; `npm run caster:dist` builds Windows NSIS/portable executables or Linux AppImage/deb packages under `apps/caster/release`. Build on the target OS. Windows builds currently target x64. The Windows helper is included in the package; end users do not need a compiler or Node.js. Linux AppImage users must install the audio utilities separately. Debian packaging declares them as dependencies. Installers are unsigned unless you configure electron-builder signing credentials in your own build environment.

## Use

1. Enter the **frontend origin** (for example `https://helltube.example`), username, and password. Use `http://127.0.0.1:5173` for local development. Remote connections require HTTPS. Frontend URLs with paths, query strings, or embedded credentials are rejected.
2. Pick a room. Automatic channels such as The Ben Zone reject manual shares, just as they do in the browser.
3. Pick Monitor, Application, or Region. Windows defaults to **Native Windows**: monitors/regions use DXGI Desktop Duplication; applications use direct WGC with OS cursor embedding disabled. **Show cursor in broadcast** draws the cursor separately. **Chromium compatibility** explicitly selects the old backend if needed; native failures never silently fall back. Region mode provides a draggable rectangle on the monitor thumbnail and precise percentage fields. On Wayland, the system portal opens when preview starts; use the percentage fields to crop its chosen source.
4. Select audio applications and/or microphones. Desktop audio is an alternative to individually selected applications, so the app will not double-count a whole desktop and its constituent apps. No audio is included by default. Use **Enable microphone access** to discover microphone labels.
5. Choose an encoding preset or adjust advanced settings. **Start preview** opens the capture and meters without publishing. The local video is muted to avoid feedback. **Hide preview** stops rendering the local preview while capture, meters, and any live broadcast continue; **Show preview** restores it without restarting capture.
6. **Go live** publishes to everyone in the selected room. **Stop sharing**, room skip, sign-out, source loss, session expiration, connection loss, or closing the app releases capture and publishing resources. Reconnection rejoins the room, but never silently restarts a broadcast.

Source inclusion, region, microphone processing, and encoding settings are fixed for a preview session. Stop the preview to change them. Per-channel gain, mute, solo, stereo pan, delay (0–500 ms), master gain, and peak compression remain adjustable while live. Meters measure the actual outgoing mix. A disappearing audio source is reported on its channel without stopping the video or other audio sources; stop and refresh to reconnect it. At most 16 native audio captures run at once. Multiple soloed channels are mixed together.

## Capture and encoding

| Preset | Maximum resolution | FPS | Video ceiling | Opus ceiling |
| --- | --- | --- | --- | --- |
| Balanced (default) | 1280 × 720 | 30 | 2.5 Mbps | 96 kbps |
| Fine detail | 1920 × 1080 | 30 | 4.5 Mbps | 128 kbps |
| Fast motion | 1920 × 1080 | 60 | 6 Mbps | 128 kbps |
| Low bandwidth | 854 × 480 | 24 | 1 Mbps | 64 kbps |

Every path clamps settings to **1080p, 60 fps, 6 Mbps video, and 128 kbps audio**. Smaller inputs retain their aspect ratio and are not enlarged. The app produces one video encoding and one mixed 48 kHz Opus track, with stereo/mono preference, optional discontinuous transmission (DTX), and forward error correction. Transport overhead is additional. All viewers receive the same encoding; this is not a simulcast ladder or recording application.

Automatic codec selection uses Helltube's hardware-efficiency probing and bounded codec fallback. H.264 and VP8 can also be selected explicitly. Hardware acceleration depends on the OS, driver, and negotiated codec/profile; it cannot be forced by this interface. Content hints and bandwidth degradation preference let users favor text/detail or motion. Frame rate and bitrate are targets/ceilings rather than guarantees. Native Windows capture crops, scales and rotates on the GPU, then transfers only bounded output frames to a generated video track without a canvas. This implementation uses CPU readback/IPC so the capture GPU and Electron GPU can differ; it is not a zero-copy pipeline. Static sources refresh periodically so new viewers receive a picture. Chromium compatibility and Linux pass uncropped tracks through directly and use a canvas only for regions. Stream health shows actual outgoing video bitrate, frame rate, relay RTT, negotiated codec, and encoder time when WebRTC exposes them.

If the Windows cursor becomes sluggish during **preview only**, the outgoing encoder and network are not running yet. Select **Native Windows** and start with **Balanced (720p, 30 fps)**. Monitor/region capture bypasses WGC completely; application capture disables WGC's cursor embedding even when the independently drawn broadcast cursor is enabled. **Hide preview** reduces local rendering work while capture continues. Stop preview to release capture completely. Lowering stream bitrate cannot reduce preview-only work. Actual cursor responsiveness still depends on Windows and the graphics driver; native capture is a separate implementation, not a guaranteed driver fix.

## Platform details

**Windows video:** the bundled `helltube-video.exe` enumerates monitors/windows directly. Screen thumbnails use a one-time GDI snapshot, which does not start WGC. DXGI runs on the GPU owning the selected monitor and handles display rotation before cropping. Application capture uses `CreateForWindow` and requires Windows 10 version 2004 or newer; it never substitutes a desktop crop for a selected window. Window handles are checked against their selected process ID. Closing a window stops capture; minimizing can freeze its picture. Display/desktop switches or graphics-device loss require restarting preview. Native output is 8-bit SDR; HDR color fidelity is not guaranteed. If a driver already embeds the cursor in a DXGI frame, the cursor checkbox cannot remove those embedded pixels.

**Windows audio:** WASAPI process loopback includes the selected process's descendants, independently of which window is captured. This requires Windows build **20348 or newer** (Windows 11 recommended); older Windows versions retain video and microphone capture. Desktop audio excludes the caster's own process tree. Applications must have created an audio session before they appear. Separate sessions/PIDs can appear for one application, so select each required source. Protected audio/windows, hardware drivers, and privilege boundaries can prevent capture.

**Linux X11:** Electron enumerates screens and windows. **Linux Wayland:** screen/window selection is delegated to the desktop's XDG screen-cast portal and PipeWire, so a fully configured `xdg-desktop-portal` and desktop-specific portal backend are required. The portal controls what surfaces it offers. Audio enumerates active PulseAudio sink inputs and records the selected stream from its own sink monitor using `parec --monitor-stream`; it does not move applications between output devices or load virtual sinks. PipeWire is supported through `pipewire-pulse`. Applications that recreate or move their audio stream need refreshing and reselecting. Pure ALSA/JACK without a PulseAudio-compatible service does not provide application capture here.

The system sound mix and screen selection are independent. Capturing one application window does not implicitly include that application's audio. Audio source discovery/capture failures are explicit; there is no fallback that silently shares the whole desktop's sound.

## Credentials and process boundaries

The renderer loads only bundled local resources from a secure custom origin. It is sandboxed, has context isolation and no Node integration, cannot navigate to remote pages, and communicates over a narrow validated preload bridge. The main process owns HTTPS requests, session cookies, and the authenticated WebSocket. Network redirects are rejected during authentication; WebSockets send the supplied frontend's Origin and session cookie, including with Worker deployments. Passwords are cleared from the form when submitted. Cookies/passwords are never persisted; only frontend URL, username, quality, capture-engine and cursor preferences are saved locally. Sign-out revokes the server session.

Native helpers have no network access. Audio travels as bounded PCM packets through IPC to AudioWorklet queues; stalled consumers drop stale audio rather than accumulating delay/memory. Native capture exits when its parent closes it. Audio is never written to disk by the caster.

Native video sends one frame per renderer acknowledgement, with dimensions and packet sizes checked before allocation. Stale acknowledgements cannot resume another capture session. The WGC pool is bounded and consumes its newest frame after a pause. Video frames remain in memory; closing the parent pipe, cancelling preview, signing out, losing the connection, or a renderer crash releases the helper and capture resources.

## Verification

```sh
npm run test:caster
npm run test:caster:native
npm run test:caster:browser
```

Unit/integration checks cover quality limits, region geometry, origin validation, PCM buffering, Linux stream selection, backend authentication/signaling, session revocation, cancelled login, native frame parsing, backpressure and cancellation. Windows native checks exercise the actual GPU shader's crop/scale/rotation, every attached DXGI monitor, and helper exit on parent EOF. The Electron suite requires an interactive desktop, built helpers, and Chrome. It captures its own test window, verifies a remote viewer can join a static scene, updates video with the preview hidden, checks source-close/room-skip cleanup, and captures an exact monitor region. It also plays a quiet tone in a separate Chrome instance, selects its actual WASAPI session, and measures received audio and live mute/unmute. Set `CASTER_TEST_BACKEND=chromium` to verify the compatibility path. Linux portal tests require human selection and are not suitable for unattended headless CI.

Implementation references: [DXGI Desktop Duplication](https://learn.microsoft.com/en-us/windows/win32/direct3ddxgi/desktop-dup-api), [WGC cursor control](https://learn.microsoft.com/en-us/uwp/api/windows.graphics.capture.graphicscapturesession.iscursorcaptureenabled), [Electron desktop capture](https://www.electronjs.org/docs/latest/api/desktop-capturer), [Microsoft process loopback](https://learn.microsoft.com/en-us/samples/microsoft/windows-classic-samples/applicationloopbackaudio-sample/), and [PulseAudio per-stream monitoring](https://www.freedesktop.org/wiki/Software/PulseAudio/Documentation/Developer/Clients/WritingVolumeControlUIs/).
