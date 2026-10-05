# Strife desktop embed

The separate `/embed/strife.html` entry point reuses Helltube's login, room navigation, player and queue. The ordinary website retains browser screen sharing. Strife probes the entry point's `helltube-embed` marker and falls back to the ordinary page on older deployments. Build with `npm run build`; both HTML entry points are included in the static deployment.

The embed admits a versioned `helltube.strife` postMessage protocol only when loaded as a frame with an exact HTTP loopback parent origin (including its port) and a session nonce in the URL fragment. Messages check the sender window, origin, protocol version, session, and a fresh connection challenge selected by the host on each load. This does not give the frame access to Strife's native capability or Mumble controls.

The host can select rooms and change local playback mute/volume. The frame reports account/room identity, connection state, available rooms and playback preferences. If the host advertises native sharing, **Share desktop** delegates to Strife's window/display picker instead of the browser capture dialog. If the helper is unavailable, Helltube keeps its existing browser-sharing controls. The native helper currently targets Windows x64 development builds of Strife; it is not a production download claim.

Sharing uses a frame-generated request ID bound to its current room and generation. The host requests credentials only for that active request; stale replies are revoked. State changes, Stop, reload and sign-out retire the request. Strife owns the publisher lifetime and shows connection/error status. Helltube playback is muted while native sharing is active to avoid recapturing it in system audio.

`POST /api/rooms/:id/strife-token` requires the existing authenticated session, room membership and a non-automated room. It returns the same `{token,path,expires}` shape as the manual OBS endpoint, but uses a separate `strife` purpose. One Strife credential per user/room can coexist with the standalone OBS credential. Both remain publishing-only, hashed in storage, and bound to the issuing login session. `DELETE` on the Strife route requires `{token}` in the JSON body and revokes only that exact credential; cleanup of a superseded request cannot stop a newer share. Legacy persisted OBS keys without a purpose remain ordinary OBS keys.

The desktop uses the existing WHIP ingest and relay. New endpoints do not create another account system, streaming listener, or transcoder. The protocol does not expose arbitrary server administration, native commands, or login cookies.

Validation: `node --test test/strife-embed.test.js`, `npm run test:obs`, `npm run test:embed`, and `npm run test:obs:browser`. Strife's `npm run test:sharing` exercises the complete embedded UI and a real native WHIP publisher using generated media. Full protocol/build notes are maintained in Strife's `docs/helltube-embed.md`.
