# Helltube client/server contract

Account/control HTTP requests are same-origin and cookie authenticated; an optional Cloudflare Worker proxies them to bare metal. Direct media and upload requests use resource-scoped grants when `BARE_METAL_ORIGIN` is configured. JSON responses are objects. Errors are `{error: string}` with a non-2xx status. Passwords: 10–128 characters; usernames: 3–32 letters/numbers/underscore/hyphen. New installations seed `admin` / `garbageTime_` (show a reminder to change it).

## HTTP

- `POST /api/rooms/:id/media` `{url,insertAt?:number,startAt?:number}` -> `{added:number}`. Accepts YouTube videos/playlists, Twitch VODs, and public HTTP/HTTPS video or audio files. Requires room membership and FFmpeg; YouTube and Twitch also require yt-dlp. The existing `/youtube` endpoint remains YouTube-only. Twitch links use `/videos/:id` (also player and legacy VOD links); `t` timestamps support the same override as YouTube. Hosted-file query parameters are preserved verbatim and are not interpreted as start times. Hosted sources have filename titles and initially unknown durations, finalized when preparation completes. Private/reserved network addresses, credentials, unsafe redirects, and external HLS/DASH manifests are rejected. Source URLs stay server-side and persist with room state.

- `GET /api/config` -> `{bareMetalOrigin:string}` (authenticated). Empty means local/same-origin delivery. Only this configured origin may receive direct requests; never send cookies there.
- `GET /api/media/:jobId/access` -> `{url,fallbackUrl?}` after session/room authorization. Resolve each new `media.url` through this endpoint before attaching playback: proxied media defaults to same-origin and includes a granted absolute bare-metal `fallbackUrl` in split deployments; uploaded media starts directly on metal. Validate both destinations against the configured origin and exact job path. Acquire fallback access up front so recovery does not depend on another proxy request.

- `GET /api/me` -> `{user: {id,username,displayName,role,defaultPassword,preferences:{volume,muted}}, capabilities: {youtube,twitch,http,ffmpeg}}`, or 401. Volume defaults to `0.8`, mute to `false`.
- `POST /api/login` `{username,password}` -> same shape as me.
- `POST /api/logout` -> `{ok:true}`.
- `PATCH /api/me` `{displayName?,currentPassword?,password?}` -> `{user}`. Current password required for password changes.
- `PATCH /api/me/preferences` `{volume?:number,muted?:boolean}` -> `{user}`. Volume must be finite and between 0 and 1; unknown fields are rejected. Account-scoped, persisted in SQLite, never changes shared playback.
- `GET /api/users` -> `{users:[user]}` (admin).
- `POST /api/users` `{username,displayName,password,role:'user'|'admin'}` -> `{user}` (admin).
- `PATCH /api/users/:id` `{displayName?,password?,role?}` -> `{user}` (admin).
- `DELETE /api/users/:id` -> `{ok:true}` (admin; cannot delete self or last admin).
- `GET /api/rooms` -> `{rooms:[{id,name,memberCount,currentTitle}]}`.
- `POST /api/rooms` `{name}` -> `{room:{id,name}}`.
- `POST /api/rooms/:id/youtube` `{url,insertAt?:number,startAt?:number}` -> `{added:number}`. Expands playlists (max 200 items); can take a minute. Membership required. `startAt` is a nonnegative safe integer in seconds; omit it to use the URL's `t` parameter, or send `0` to ignore that parameter. Invalid times and starts at/past a known duration return 400. A playlist timestamp applies to its linked video, or its first playable entry for playlist-only URLs, without changing playlist order.
- `POST /api/rooms/:id/uploads` `{name,size,duration,mime,lastModified?:number,insertAt?:number}` -> `{uploadId,chunkSize:524288}`. Duration is obtained from a local video metadata element (or omitted if unavailable). Membership required. Queues the item immediately.
- `POST /api/rooms/:id/uploads/batch` `{files:[{name,size,duration?,mime,lastModified?}],insertAt?:number}` -> `{uploads:[{uploadId,chunkSize:524288}],playlistId,playlistTitle}`. Accepts 1–100 files in selection order; responses correspond to files in that order. Two or more files share a new playlist ID and a server-inferred title from the longest common whole-word phrase in their filenames, ignoring extensions/case/separators (fallback: `Uploaded videos`). One file has null playlist fields. Validates the whole batch and atomically saves the queue and upload records before broadcasting; no partial additions on rejection. Counts as one submission; existing queue/storage limits still apply. Each upload uses the normal chunk/status endpoints below.
- `GET /api/uploads` -> `{uploads:[{id,roomId,roomName,name,size,lastModified,received,duration,chunkSize}]}`. Own unfinished uploads from SQLite, allowing file reselection and resume after browser/server restart without browser storage.
- `GET /api/uploads/:id` -> `{received,complete,delayMs,bufferSeconds,slow,active,transferUrl?}` (uploader only). If `active:false`, wait before sending more chunks; media preparation is limited to current + next video. In split deployments `transferUrl` is the scoped bare-metal URL for chunk PUTs; append `&offset=N`. Do not send file bytes through the Worker.
- `PUT /api/uploads/:id?offset=N` binary chunk with `Content-Type: application/octet-stream` -> same status shape. Exactly one chunk in flight; retry with GET to recover offset; wait `delayMs` before next chunk. All size bytes arriving marks complete. `delayMs` is adaptive backpressure, not a fixed bandwidth cap.
- `DELETE /api/uploads/:id` cancels own upload and removes its queued item -> `{ok:true}`.

Clients retain selected `File` objects through backend deployments. Network failures, request timeouts, HTTP 408/429, and transient server errors retry automatically with exponential backoff capped at 15 seconds, without an attempt limit. Each retry first fetches upload status to recover the durable offset and current transfer grant; never blindly resend an unacknowledged chunk. Status requests time out after 15 seconds and chunk PUTs after 120 seconds. Online/room-reconnect events wake recovery waits without restarting paused, cancelled, or permanently failed uploads. Authentication/ownership failures, missing uploads, and invalid destinations/offsets stop the transfer. Defer automatic frontend deployment reloads while file-bearing unfinished transfers or upload registration are present; manual reloads still require file reselection.

### Media and direct delivery

- `/media/:jobId/index.m3u8` and `/media/:jobId/segment-NNNNNN.ts` are cookie/room authenticated. In split deployments YouTube, Twitch VODs, and hosted media use this route; uploaded media is rejected rather than proxied. Playlists are always uncached.
- `/direct/media/:jobId/key.bin?grant=...` returns exactly 16 AES-128 key bytes, `Cache-Control: no-store`, after live session/room checks. FFmpeg playlists reference this URI; in split deployments it is absolute and must bypass Cloudflare. Keys are never served as segment files.
- `/direct/media/:jobId/index.m3u8?grant=...` and `/direct/media/:jobId/segment-NNNNNN.ts?grant=...` deliver uploaded HLS and fallback HLS from bare metal, uncached, with range support. Every direct playlist's key and segment URLs retain the scoped grant and live session/room checks.
- `PUT /direct/uploads/:id?grant=...&offset=N` uses the same bounded raw chunks, ownership checks, offsets, backpressure, and response shape as local uploads. Direct CORS permits only allowlisted frontend origins and GET/HEAD/PUT; OPTIONS allows `Content-Type` and `Range`. No credentialed cross-site cookies are required. In local mode `/direct/*` also accepts the normal session cookie.
- `/api/edge/media/:jobId/:file` requires the shared `X-Helltube-Edge` secret plus the viewer cookie and room authorization, and returns `{cacheable:true}` only for existing encrypted YouTube, Twitch VOD, or hosted-media segments. The Worker calls it before **every** segment cache lookup and fails closed on failure. The Worker rejects `/direct/*` and binary upload proxying; the backend rejects direct traffic carrying the edge marker too.

Direct grants are session-bound HMAC capabilities, scoped to one media job or upload, not general API credentials. They expire with/revoke with the session and membership/ownership is checked on every use, so no periodic renewal or short-lived-grant revocation window is needed. Never log `grant` query strings. Cache lifetime is independent (90 seconds by default, 120 maximum); browser-facing data remains `no-store`. Native HLS and hls.js use standard AES-128 segment decryption with a fresh key per job and sequence-number IVs. A delivered key cannot be revoked.

## WebSocket `/ws`

Authentication is the session cookie. Reconnect with exponential backoff, rejoin previous room; never replay stale commands. On connect server sends `{type:'rooms',rooms}`.

Client sends:
- `{type:'join',roomId}`
- `{type:'ping',sentAt}` -> `{type:'pong',sentAt,serverTime}` (use RTT midpoint to estimate clock offset).
- `{type:'control',action:'play'|'pause'|'seek'|'skip'|'previous',position?:number,revision:number}`. Include latest `room.playback.revision`; stale commands are rejected. Seek is the absolute full-video position in seconds.
- `{type:'queue:move',itemId,toIndex}` (zero-based final index)
- `{type:'queue:remove',itemId}`
- `{type:'queue:remove-playlist',playlistId}` (removes all queued entries in the group, not current playback)
- `{type:'history:play',itemId}` (select one of five previously played entries)
- `{type:'reaction',kind:'hitmarker'|'metalpipe'|'heart'|'laugh'|'clap',x,y}` places a transient reaction at normalized player coordinates (0–1).
- `{type:'reaction',kind:'beachball',enabled:boolean}` shows or removes the room's shared ball.
- `{type:'reaction:pointer',x,y}` sends normalized cursor coordinates in the centered 1600×900 ball arena, at most 25 times/second. Send both coordinates as null on leave. Clients send at most once per 60ms, with a 500ms stationary heartbeat.

Server sends:
- `{type:'state',room,serverTime}` every 750ms and immediately after mutations. No per-client ended command; server advances the authoritative timeline.
- `{type:'rooms',rooms}` on membership / room changes.
- `{type:'error'|'notice',message}`
- `{type:'overlay',message,expiresAt}`; display over player until expiry.
- `{type:'session-ended'}`; return to login.
- `{type:'reaction',roomId,id,userId,kind,x,y,serverTime}` is broadcast only to the sender's room, including the sender. Deduplicate by ID; expired reactions are discarded and never replayed on reconnect. Limit: 8 reactions/second per socket.
- `{type:'reactions:state',roomId,ball,serverTime}` supplies the shared ball on join and at 20Hz while active. The server owns gravity, friction, bounces and cursor collisions; clients extrapolate briefly between snapshots. Reaction state is transient and cleared when the last viewer leaves or the room is deleted. Playback revisions and persistence are unaffected.

`room = {id,name,members:[{id,displayName}],current:item|null,queue:[item],history:[item],playback:{paused,position,updatedAt,revision},version}`. History is most recent first, capped at 5. Timeline is server wall-clock based: `position + (paused ? 0 : (Date.now()+clockOffset-updatedAt)/1000)`. Playback only begins when media is ready. During buffering the server freezes the timeline and resumes when ready.

`item = {id,title,duration:number|null,startAt:number,thumbnail:string|null,addedBy,kind:'youtube'|'twitch'|'http'|'upload',playlistId:string|null,playlistTitle:string|null,status:'queued'|'uploading'|'processing'|'ready'|'error',error:string|null,media:null|{url,baseTime,bufferedUntil,complete}}`. `startAt` defaults to zero and is the shared starting point for initial playback, queue advancement and history replay; later shared seeks do not change it.

`media.url` is an authenticated HLS event playlist. It changes when server restarts a source for a far seek. HLS local time is absolute room position minus `media.baseTime`. `bufferedUntil` is an absolute full-video position. For uploads still arriving, seeking beyond this is rejected with an explanation. Completed uploads, YouTube, Twitch VODs, and hosted media can restart at arbitrary positions. Use hls.js with ~30s forward and 30s back memory buffer, `liveSyncDurationCount:3`, `maxLiveSyncPlaybackRate:1`, and disable automatic live-edge seeking (`liveMaxLatencyDurationCount:Infinity`). Start at the room target, not the live edge. Never drive server state from video DOM play/pause/seeking events: shared controls send explicit commands only. Correct drift every ~250ms: >1s hard seek, 0.15–1s adjust playbackRate 0.97/1.03, otherwise 1. Pause if server pauses. Handle blocked autoplay with an explicit local “Enable playback” button, not a shared pause.

Hosted media with unknown duration is probed through its authenticated loopback source before conversion, using ffprobe with a 10-second timeout. The proxy retains range requests and validates redirects/watch-page sources, allowing MP4 metadata at EOF to be read early. A positive finite full-file duration is stored on the item and published by the normal room snapshots before HLS completion, without changing playback revisions. Reuse known durations on seeks/restarts. Probe failure or missing ffprobe is nonfatal; final conversion supplies duration as before. Cancelled jobs discard late results and terminate the probe. A requested start at/past the discovered end fails before conversion.

## UX expectations

Playback buffer health is sampled and displayed locally every second: contiguous seconds buffered at both the decoder and room playheads, source headroom, delivery route, and (with hls.js) recent segment throughput including request latency. Do not count buffered ranges beyond gaps. A Cloudflare viewer with source headroom switches to its validated metal URL after six seconds below six seconds of buffer, or three seconds stalled with less than 0.5 seconds buffered, with four seconds of initial/seek grace. Proxy playlist/segment transport failures also trigger fallback; authorization errors, key failures and decode errors do not trigger immediate switching. Pauses, blocked autoplay, disconnection, user seeks, source starvation and fully buffered endings suppress the health-based decision; room revisions and suspended tabs reset observations. Recovery replaces only this viewer's source, uses the current room target/base time, and never sends shared controls. Retain metal for the current video across retries/far-seek source changes, reset on a different video, and show the existing retry UI if metal fails. Health reports stay on the device; they do not mutate room state.

Distinctive polished dark cinema / Discord-inspired layout: left room rail, central player and transport, right queue with playlist grouping and one-click group removal. Everyone controls playback. Queue insertion at selected index, reorder (accessible up/down sufficient), remove, previous, skip, last-five history selection. Login; account panel; admin user CRUD. Upload progress, queued/buffering status, backend capability warnings, actionable errors and reconnect state. No fake room members, media or activity. Responsive layout and keyboard-accessible controls.

Controls overlay the bottom of the video with a progressively blurred/darkened backdrop. After three idle seconds while playing, transport fades and the seek bar becomes a thin bottom line with no thumb. Activity restores controls, and focus/drag/pause/buffering/errors keep them visible. Respect reduced motion and provide a gradient fallback without backdrop-filter support.

The Reactions panel sits below, outside the player shell. Hit marker arms a one-shot placement target; click/tap the picture, or aim with arrow keys and press Enter. Escape cancels. Hit-marker audio follows device volume/mute and the panel's local sound toggle, and unlocks after browser user interaction. Hearts, laughter and applause float briefly; reduced motion removes the flourish. The ball is 96% opaque, shared even while video is paused, and uses a fixed-aspect arena above the controls so desktop/mobile/fullscreen clients agree on collisions and can reach the resting ball.

Metal pipe drops a gray pipe at the reaction's horizontal position. The fall accelerates over 900ms from `serverTime`, ending at the actual player bottom; the locally bundled metal-pipe meme sound starts on the rendered impact frame, once per reaction. It uses full device volume (hit markers use 65%), respects both mute controls, and does not replay stale impacts after a tab resumes or reconnects. The pipe fades out after landing and never captures pointer events.

## Persistence and cleanup

SQLite stores durable accounts, sessions, preferences, room/item state, playback checkpoints and upload metadata. Rebuild transient HLS URLs and live membership after restart; freeze offline elapsed time. Preserve referenced original upload files, delete obsolete streaming output on startup, and periodically collect media not referenced by current/queue/history. See `README.md` for migration, retention and backup details.
