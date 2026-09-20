# OBS Studio for Helltube

This replaces the experimental caster apps with [OBS Studio](https://github.com/obsproject/obs-studio). The source lives in `apps/obs-studio`, with upstream Git history and submodules. Helltube adds a **Helltube** destination in **Settings → Stream**, using OBS's native WHIP output and the existing Helltube WebRTC relay.

## Stream to a room

1. Sign in to Helltube and join the room you want to stream to.
2. Select **Share desktop → Stream with OBS Studio → Create OBS token**.
3. In OBS, select **Settings → Stream → Helltube**. Copy the room's **Server URL** and **Bearer token** into the corresponding fields.
4. Add capture sources and mix audio in OBS, then select **Start Streaming**. Select **Stop Streaming** when finished.

The Helltube service selects H.264 Baseline and Opus, disables B-frames and simulcast, and recommends up to 1920×1080 at 60 fps, 12,000 Kbps video and 192 Kbps audio, with a two-second keyframe interval. Keep **Ignore streaming service setting recommendations** off. Use SDR video and stereo audio. Standard OBS's **WHIP** service can use the same URL/token; configure these encoder settings yourself when using that service.

Streams use the same player, viewer limit, four-hour duration limit, and queue interruption/resumption behavior as browser desktop shares. Multiple people can stream to the same room. Each user has one OBS token per room and one active stream per token. Closing the browser does not stop OBS. Skipping the room's live shares, deleting the room, revoking/replacing the token, or signing out ends the stream. A failed connection is released automatically.

Tokens expire with the browser sign-in session (at most seven days) and survive backend restarts. The database stores the token's SHA-256 digest, room, owner, and issuing session; the raw token is returned only when created. Password changes and account deletion revoke the associated session and stream. Tokens authorize publishing only, and cannot sign in or read account APIs. OBS saves its bearer token with the local OBS profile, so protect that profile as a credential.

## Reproduce the source checkout

```sh
npm run obs:setup
```

`upstream.json` pins upstream commit `b5bfb79093e26ce4b0e71d999f59b6b22f961121` (based on 32.2.1). `helltube.patch` contains all OBS changes. The setup script clones upstream with its submodules, checks the exact revision, and applies the patch. Re-running recognizes an applied patch. A different revision or conflicting local edits produces an error rather than overwriting work. The nested source checkout is ignored by the parent repository; the manifest, patch and setup script are tracked so a fresh Helltube checkout can reproduce it.

## Build OBS

Follow the [upstream build instructions](https://github.com/obsproject/obs-studio/wiki/Install-Instructions) for platform dependencies. For this pinned revision, Windows uses Visual Studio 2026 with Desktop development with C++, Windows SDK 10.0.26100.0, and CMake 3.28 or newer. CMake downloads upstream's pinned OBS and Qt dependencies.

```powershell
cd apps/obs-studio
cmake --preset windows-x64
cmake --build build_x64 --config RelWithDebInfo --parallel 4
```

The assembled Windows app is under `build_x64/rundir/RelWithDebInfo/bin/64bit/obs64.exe`. For a smaller build without browser sources or the OBS WebSocket server, add `-DENABLE_BROWSER=OFF -DENABLE_WEBSOCKET=OFF` to the configure command. Keep **ENABLE_WEBRTC=ON** (the upstream default). On Linux/macOS use the corresponding upstream CMake presets; the Helltube changes are platform independent. A custom build is required for the named destination; an installed stock OBS can still use WHIP without building.

To refresh `helltube.patch` after editing the nested checkout, run `git diff --binary --output=../obs-support/helltube.patch` from `apps/obs-studio`. Keep the pinned revision aligned with the patch. OBS retains its upstream GPL license (`apps/obs-studio/COPYING`).

## Server and deployment

Helltube accepts `POST /api/whip/:roomId` with `Content-Type: application/sdp` and `Authorization: Bearer <token>`. It returns `201`, an SDP answer, and a relative `Location` resource URL. OBS stops with authenticated `DELETE` on that resource, receiving `200 OK` as in [WHIP's session teardown](https://www.rfc-editor.org/rfc/rfc9725.html#section-3). `OPTIONS` advertises the endpoint methods and configured STUN/TURN servers. ICE trickle PATCH, ICE restart, and simulcast are not supported; restart streaming to negotiate a new connection.

The browser creates/replaces tokens with authenticated `POST /api/rooms/:id/obs-token` while joined to the room, and revokes its own token with `DELETE` on that route. Stream negotiation stays on the frontend URL, including through the Cloudflare Worker. Encoded media flows directly to the existing `DESKTOP_LISTEN_IP` / `DESKTOP_ANNOUNCED_ADDRESS` / `DESKTOP_PORT` listener. Production requires HTTPS and a reachable media port, with optional `DESKTOP_ICE_SERVERS` / `DESKTOP_TURN_SECRET` for restricted networks. No RTMP listener, transcoding, new media port, or FFmpeg process is used. The browser's `DESKTOP_ICE_TRANSPORT_POLICY=relay` setting does not force OBS to use TURN.

## Verification

```sh
npm run test:obs
npm run test:obs:browser
```

The first command checks native relay negotiation with OBS-shaped SDP, scoped credentials, persistence, malformed/unsupported offers, duplicate publishers, resource cleanup, queue resumption, and Worker forwarding. The browser test requires Google Chrome and checks real H.264 pixels and decoded Opus audio through the native relay, a late viewer, closing the issuing page, and stream teardown. These tests cover the server protocol and room UI; they do not substitute for testing a built OBS capture source on each operating system.

After building Windows OBS, compile and run the native module test from the Helltube root:

```powershell
cmake -S test/obs-native -B test-artifacts/obs-native-build -G "Visual Studio 18 2026" -A x64
cmake --build test-artifacts/obs-native-build --config RelWithDebInfo
npm run test:obs:native
```

This loads the built OBS libraries and Helltube service, encodes a generated video/audio fixture with OBS's x264 and Opus encoders, publishes with OBS's actual WHIP output, verifies decoded pixels in Chrome and audio/video packets at the relay, then checks successful WHIP teardown. It needs FFmpeg only to generate the test fixture; the Helltube server runs with FFmpeg disabled. The test runs without opening a capture window or accessing desktop/microphone sources.
