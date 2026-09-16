# Helltube

A Svelte 5 + Node.js watch-together app. Every room has one authoritative playback clock, a collaborative queue, and a shared two-second HLS stream. No full YouTube download is required before playback.

## Run locally

Requirements: Node.js **22.13+**, npm, **FFmpeg** with `libx264`/AAC, and a current **yt-dlp** with a supported JavaScript runtime (Node is enabled explicitly). Keep yt-dlp updated as YouTube changes.

On Windows / PowerShell:

```powershell
winget install --id yt-dlp.yt-dlp -e --silent --accept-source-agreements --accept-package-agreements
# Reopen your terminal after installation so the PATH changes take effect.
yt-dlp --version
ffmpeg -version
npm install
npm run dev
```

Open **http://127.0.0.1:5173**. Vite proxies the API, media, and WebSockets to port 3000. In WebStorm, run `dev` from `package.json`, or run the same commands in its terminal.

Initial account: **`admin` / `garbageTime_`**. Open Account and change this password before sharing the server. Admins can create accounts, change roles, reset passwords, and delete users. There is no public registration. Everyone can create/join rooms and control playback; accounts are not room access-control lists.

For a production build:

```powershell
npm run build
npm start
```

Open **http://127.0.0.1:3000**. To listen on the LAN, set `$env:HOST = '0.0.0.0'` before starting. Use a TLS reverse proxy for Internet access and forward WebSocket upgrades. Set `SECURE_COOKIES=true` and `ALLOWED_ORIGINS` to your exact public origin. Do not expose this application using its seeded password.

## Watching together

- Create a room or join **The living room**. Paste a YouTube video or playlist URL. Playlist submissions expand up to **200** playable entries per submission; queue size is capped at **500**. A URL with a `list` parameter adds the playlist.
- YouTube links with a `t` parameter (such as `&t=90`, `?t=90s`, or `&t=1m30s`) reveal a checked **Start at** option below the URL. Edit seconds, `M:SS`, or `H:MM:SS`, or use its spring-return joystick for **±30-second** adjustments per release; uncheck to start at zero. This sets the queued video's shared starting point, without seeking the currently playing video. Preparation and replay use that start time too; everyone can still seek earlier. For playlists, it applies only to the linked video (or the first playable entry for playlist-only links), preserving playlist order. Times at or beyond a known video duration are rejected.
- Select an insertion position, move entries up/down, remove individual videos, or remove an entire queued playlist group with one click. Removing a playlist does not stop its currently playing video.
- Everyone can play, pause, seek, skip, or return to any of the **last five** played videos. Going back keeps the interrupted video at the front of the queue.
- Drag the seek joystick up to **±30 seconds**, then release to seek for everyone. Its inline offset stays beside the track, and the stick springs through center before settling in **380ms**. Arrow keys work too; Escape cancels, and reduced-motion preferences disable the wobble.
- While holding the playback joystick off-center, a **45%-opacity ghost of the target frame** appears if it is locally buffered. A separate silent decoder uses already-received video bytes; previewing never fetches missing media, seeks the playing video, or sends room commands. Release, cancellation, or a source change removes the ghost. Native-HLS-only browsers without MediaSource decoding omit previews rather than interrupt playback.
- The temporary **Beach ball test** button at the bottom of the player toggles a translucent, spinning beach ball on this device only. It bounces inside the viewport even while paused; reduced-motion preferences keep it stationary. Click again to remove it.
- The server prepares the current video and the next video concurrently, subject to the global transcoder limit. Ready next-video segments are reused when advancing.
- Click **Enable playback** if your browser blocks autoplay. This grants local playback permission; it does not change the room's state.
- Playback controls sit over the video's bottom edge, on a dark progressively blurred backdrop. After three seconds of inactivity during playback, they fade away and the seek bar contracts to a thin bottom line without its thumb. Pointer, touch, or keyboard activity brings them back; pause, buffering, errors, keyboard focus, and active dragging keep them visible. Reduced motion disables transitions; browsers without backdrop filters use a dark gradient.
- Volume and mute are personal account preferences saved in SQLite, not shared room controls. They follow you across room changes, page reloads, sign-ins, and server restarts.

## Streaming and synchronization

`yt-dlp` extracts metadata and signed audio/video source URLs. FFmpeg reads those remote sources directly and emits H.264/AAC HLS event playlists in two-second segments, up to 720p. Each room uses one media job per item, not one downloader per viewer. Atomic segment/manifest publishing prevents clients reading partially written chunks.

The server broadcasts room state every **750ms** and immediately after controls. Clients estimate server-clock offset using ping round trips and correct drift every **250ms**: gentle speed correction for small errors and a seek for errors over one second. Explicit room controls are separate from local video events, preventing feedback loops. Revisions reject stale controls. The server freezes its clock on source starvation and resumes after at least four seconds are ready. An individual slow viewer catches up locally rather than pausing everyone.

The browser keeps roughly **30 seconds forward / 30 seconds back** in its MediaSource buffer, with a **60-second forward ceiling**. Disk-backed server segments are retained for queued/current/recent items and removed when no longer referenced. A far seek restarts source conversion at the requested absolute timestamp when necessary; clients then switch to the new playlist.

The visual player is a WebGL video-textured plane with an **orthographic projection**, implemented without an extra graphics dependency in `src\lib\video-renderer.js`. Coordinates are CSS pixels from the viewport's top-left, ready for future composited overlays; the current room notices remain accessible HTML above the canvas. The native video element still handles HLS decoding, audio, and synchronization. Rendering follows decoded frames, preserves aspect ratio, redraws paused seeks and resizes, and caps resolution at 2× device pixels / 4096 per dimension. WebGL unavailability or context loss falls back to native video; a restored context rebuilds the renderer.

Ghost and beach-ball layers share that orthographic WebGL composition, with a transparent 2D effects canvas for native-video fallback. Preview video bytes are capped at **32 MiB**, pruned with the local playback buffer, and cleared on media changes; only the requested fragment is decoded, into an image no larger than 960×540. Offsets are translated through the current stream's base time. Ball animation stops when hidden or disabled and does not re-upload unchanged video frames.

## Uploads and backpressure

Drop videos directly onto **Your files** (even while YouTube is selected) or its upload area, or click **Choose videos** to select one or several files. Multiple files become one playlist in selection/drop order at the chosen queue position. The title is the longest shared whole-word phrase from all filenames, ignoring extensions and differences in casing/separators: `Night Walk - 01.mp4` + `Night Walk - 02.mkv` becomes **Night Walk**. With no usable common text, the title is **Uploaded videos**. A single video stays ungrouped. Separate batches remain separate playlists even if their names match.

Select up to **100** videos per batch, subject to the existing queue limit, the server-wide limit of 100 retained upload sources, and the storage budget. Empty/non-video selections are rejected with an explanation. Batch metadata and queue entries are saved together before any upload starts, so a rejected batch never leaves a partial playlist. Uploaded playlists support the same reordering, individual removal, and one-click queued-group removal as YouTube playlists.

Local videos use sequential **512 KiB** acknowledged HTTP chunks with offset recovery, never an unbounded WebSocket binary flood. TCP handles retransmission and congestion control; application pacing reduces excess queueing but cannot guarantee zero packet loss.

The server exposes a loopback-only, secret-protected growing range source to FFmpeg. Playback can start while the browser is still uploading. Once estimated upload headroom exceeds **45 seconds**, the uploader delays requests adaptively. Current and next uploads are active; later queued uploads wait. Keep the uploading tab open. Upload metadata and acknowledged offsets persist in SQLite, and each chunk is flushed before acknowledgment. After a page or server restart, unfinished uploads appear from your account's server records: reselect the original unchanged file to resume. Browsers cannot restore a local File object automatically.

**Container limitation:** fragmented MP4, fast-start MP4, and streamable WebM/MKV can begin before EOF. A conventional MP4 with its `moov` index at the end must deliver that index first and may need the entire upload before conversion can begin. Such uploads are deliberately not throttled until playable segments exist, avoiding deadlock. Convert ahead of time if immediate progressive playback matters:

```powershell
ffmpeg -i input.mp4 -c copy -movflags +faststart output.mp4
```

Bitrate is estimated from browser-reported duration and file size. At least three samples and twelve seconds of measured transfer time are required to identify chronic insufficient upload throughput. Deliberate pacing sleeps are excluded. With under ten seconds estimated headroom and insufficient throughput, the uploader is warned and everyone in the room sees **“{username} has shitternet, laugh at them.”** for ten seconds, at most once per minute. Without readable duration, bitrate-based pacing/diagnosis is unavailable; chunks and TCP backpressure still apply. Seeking past received media is blocked until the upload completes.

## Configuration

Environment variables (set in PowerShell or your service manager; `.env` is not automatically loaded):

| Variable | Default | Purpose |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | HTTP listen address |
| `PORT` | `3000` | HTTP/WebSocket port; update Vite proxy if changing in development |
| `DATA_DIR` | `data` | SQLite database, retained upload sources, and disposable streaming segments |
| `FFMPEG_PATH` | `ffmpeg` | FFmpeg executable path |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp executable path |
| `MAX_TRANSCODERS` | `4` | Global concurrent media jobs |
| `MAX_UPLOAD_BYTES` | `10737418240` | Maximum individual upload (10 GiB) |
| `MAX_STORAGE_BYTES` | `32212254720` | Shared upload/media budget (30 GiB; checked every 10s) |
| `CLEANUP_INTERVAL_MS` | `60000` | Interval for sweeping unreferenced uploads and streaming files |
| `SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `ALLOWED_ORIGINS` | localhost Vite origins | Comma-separated additional trusted browser origins; same-origin always accepted |

Durable application state lives in **`data\helltube.sqlite`**, using Node's built-in SQLite support (no separate database installation). This includes accounts with salted scrypt hashes, sessions and their expiry/revocation, volume/mute preferences, rooms, ordered queues/playlist groups, five-item history, shared playback checkpoints, and upload metadata/offsets. Existing `users.json` accounts migrate transactionally without changing IDs or passwords; legacy account files are removed only after a successful migration. Invalid databases are not silently reset.

Playback mutations are saved immediately, and advancing clocks are checkpointed every **750ms**. Offline time does not advance playback: restart rebuilds each current stream at the saved position, resuming only if it was previously playing or waiting for media. Paused rooms remain paused. Live connections/presence, decoders, temporary previews, and buffers are runtime resources and are recreated, not restored as phantom viewers.

On startup, obsolete streaming segments under `data\media` and unreferenced/legacy files under `data\uploads` are removed. Original upload bytes remain on disk **while referenced by a current video, any queue, or the five-item history**; storing large video blobs inside SQLite is intentionally avoided. Missing source files produce an actionable error instead of a broken stream. Shutdown retains referenced uploads; runtime cleanup cancels obsolete jobs and removes their files, and sweeps orphan files every minute (configurable above). Cleanup never removes the SQLite database or unrelated files in `DATA_DIR`.

Run **one Node process** per data directory, not a load-balanced cluster. A database ownership guard rejects a second updated backend before it can clean an active server's media. Stop the existing server before upgrading. To back up, stop the server and copy `helltube.sqlite` **and `uploads` together**; live backups must use SQLite's backup facilities rather than copying a live database without its WAL.

## Security and operating limits

Session cookies are HttpOnly/SameSite=Strict; HTTP and WebSocket origin checks, role checks, login/command/submission rate limits, bounded message/chunk sizes, upload ownership, and authenticated room-media checks are enforced. Password/role changes revoke sessions. The last administrator cannot be deleted or demoted. Only validated YouTube URLs reach yt-dlp, subprocesses do not use a shell, and uploaded network-playlist formats are denied to FFmpeg.

Run media processing as an unprivileged OS account/container with CPU/disk limits and restricted egress if admitting untrusted users: FFmpeg and yt-dlp are external parsers, not a complete sandbox. The storage budget is a guardrail, not a filesystem quota. Native HLS fallback depends on browser buffering behavior; Chrome/Edge/Firefox use hls.js. YouTube live broadcasts, DRM, private/paid/age-gated content, and cookie-authenticated extraction are not supported. YouTube may rate-limit or require bot verification; those failures surface as errors and can be skipped. Only stream content you have permission to access and share.

## Verification

```powershell
npm test
npm run test:media
npm run build
npm run test:browser
# Optional: contacts YouTube (requires a working Internet connection and current yt-dlp).
npm run test:youtube
```

`npm test` covers SQLite migration/rollback, session and volume persistence, restart recovery, periodic cleanup and retention, room clocks, queues/playlists/history, upload resumption/pacing, URL validation, and real HTTP/WebSocket connections. It requires FFmpeg for capability checks but does not contact YouTube. `test:media` generates a synthetic video with FFmpeg, confirms playable HLS **before upload completion**, decodes served media before and after a server restart, checks next-video preparation/history, and rejects malicious uploaded playlists. Fixtures live under ignored `test-artifacts` and clean themselves up. No external YouTube availability is assumed by the deterministic test suite.

`test:browser` requires installed Google Chrome. It builds the app and uses Playwright to test two separate user sessions, admin creation/deletion, uploaded video decoding, sub-second synchronization, shared pause/seek, offline recovery, display-name changes, and mobile overflow. It also checks WebGL pixels against native decoded frames, fullscreen/HiDPI resizing, context recovery, native fallback, joystick spring motion/alignment, and reduced motion. Desktop/mobile screenshots are saved under `test-artifacts`. `test:youtube` exercises the complete real YouTube-to-HLS path; set `YOUTUBE_TEST_URL` to test another public video or playlist. Its success depends on YouTube availability and access policies.

Implementation: `server\rooms.js` (state engine), `server\media.js` (job scheduler/HLS), `server\uploads.js` (growing sources/pacing), `server\youtube.js` (extraction), `server\auth.js` (accounts), `server\app.js` (HTTP/WebSockets), and `src` (Svelte client). See `CONTRACT.md` for API details.