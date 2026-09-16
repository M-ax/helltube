# Helltube client/server contract

Account/control HTTP requests are same-origin and cookie authenticated; an optional Cloudflare Worker proxies them to bare metal. Direct media and upload requests use resource-scoped grants when `BARE_METAL_ORIGIN` is configured. JSON responses are objects. Errors are `{error: string}` with a non-2xx status. Passwords: 10–128 characters; usernames: 3–32 letters/numbers/underscore/hyphen. New installations seed `admin` / `garbageTime_` (show a reminder to change it).

## HTTP

- `GET /api/config` -> `{bareMetalOrigin:string}` (authenticated). Empty means local/same-origin delivery. Only this configured origin may receive direct requests; never send cookies there.
- `GET /api/media/:jobId/access` -> `{url}` after session/room authorization. Resolve each new `media.url` through this endpoint before attaching playback: YouTube remains same-origin, configured uploaded media uses a granted absolute bare-metal playlist URL.

- `GET /api/me` -> `{user: {id,username,displayName,role,defaultPassword,preferences:{volume,muted}}, capabilities: {youtube,ffmpeg}}`, or 401. Volume defaults to `0.8`, mute to `false`.
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

### Media and direct delivery

- `/media/:jobId/index.m3u8` and `/media/:jobId/segment-NNNNNN.ts` are cookie/room authenticated. In split deployments only YouTube uses this route; uploaded media is rejected rather than proxied. Playlists are always uncached.
- `/direct/media/:jobId/key.bin?grant=...` returns exactly 16 AES-128 key bytes, `Cache-Control: no-store`, after live session/room checks. FFmpeg playlists reference this URI; in split deployments it is absolute and must bypass Cloudflare. Keys are never served as segment files.
- `/direct/media/:jobId/index.m3u8?grant=...` and `/direct/media/:jobId/segment-NNNNNN.ts?grant=...` deliver uploaded HLS from bare metal, uncached, with range support. Playlist key and segment URLs retain the scoped grant.
- `PUT /direct/uploads/:id?grant=...&offset=N` uses the same bounded raw chunks, ownership checks, offsets, backpressure, and response shape as local uploads. Direct CORS permits only allowlisted frontend origins and GET/HEAD/PUT; OPTIONS allows `Content-Type` and `Range`. No credentialed cross-site cookies are required. In local mode `/direct/*` also accepts the normal session cookie.
- `/api/edge/media/:jobId/:file` requires the shared `X-Helltube-Edge` secret plus the viewer cookie and room authorization, and returns `{cacheable:true}` only for existing encrypted YouTube segments. The Worker calls it before **every** segment cache lookup and fails closed on failure. The Worker rejects `/direct/*` and binary upload proxying; the backend rejects direct traffic carrying the edge marker too.

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

Server sends:
- `{type:'state',room,serverTime}` every 750ms and immediately after mutations. No per-client ended command; server advances the authoritative timeline.
- `{type:'rooms',rooms}` on membership / room changes.
- `{type:'error'|'notice',message}`
- `{type:'overlay',message,expiresAt}`; display over player until expiry.
- `{type:'session-ended'}`; return to login.

`room = {id,name,members:[{id,displayName}],current:item|null,queue:[item],history:[item],playback:{paused,position,updatedAt,revision},version}`. History is most recent first, capped at 5. Timeline is server wall-clock based: `position + (paused ? 0 : (Date.now()+clockOffset-updatedAt)/1000)`. Playback only begins when media is ready. During buffering the server freezes the timeline and resumes when ready.

`item = {id,title,duration:number|null,startAt:number,thumbnail:string|null,addedBy,kind:'youtube'|'upload',playlistId:string|null,playlistTitle:string|null,status:'queued'|'uploading'|'processing'|'ready'|'error',error:string|null,media:null|{url,baseTime,bufferedUntil,complete}}`. `startAt` defaults to zero and is the shared starting point for initial playback, queue advancement and history replay; later shared seeks do not change it.

`media.url` is an authenticated HLS event playlist. It changes when server restarts a source for a far seek. HLS local time is absolute room position minus `media.baseTime`. `bufferedUntil` is an absolute full-video position. For uploads still arriving, seeking beyond this is rejected with an explanation. Completed uploads and YouTube can restart at arbitrary positions. Use hls.js with ~30s forward and 30s back memory buffer, `liveSyncDurationCount:3`, `maxLiveSyncPlaybackRate:1`, and disable automatic live-edge seeking (`liveMaxLatencyDurationCount:Infinity`). Start at the room target, not the live edge. Never drive server state from video DOM play/pause/seeking events: shared controls send explicit commands only. Correct drift every ~250ms: >1s hard seek, 0.15–1s adjust playbackRate 0.97/1.03, otherwise 1. Pause if server pauses. Handle blocked autoplay with an explicit local “Enable playback” button, not a shared pause.

## UX expectations

Distinctive polished dark cinema / Discord-inspired layout: left room rail, central player and transport, right queue with playlist grouping and one-click group removal. Everyone controls playback. Queue insertion at selected index, reorder (accessible up/down sufficient), remove, previous, skip, last-five history selection. Login; account panel; admin user CRUD. Upload progress, queued/buffering status, backend capability warnings, actionable errors and reconnect state. No fake room members, media or activity. Responsive layout and keyboard-accessible controls.

Controls overlay the bottom of the video with a progressively blurred/darkened backdrop. After three idle seconds while playing, transport fades and the seek bar becomes a thin bottom line with no thumb. Activity restores controls, and focus/drag/pause/buffering/errors keep them visible. Respect reduced motion and provide a gradient fallback without backdrop-filter support.

## Persistence and cleanup

SQLite stores durable accounts, sessions, preferences, room/item state, playback checkpoints and upload metadata. Rebuild transient HLS URLs and live membership after restart; freeze offline elapsed time. Preserve referenced original upload files, delete obsolete streaming output on startup, and periodically collect media not referenced by current/queue/history. See `README.md` for migration, retention and backup details.