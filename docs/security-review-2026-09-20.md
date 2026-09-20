# Security review — 2026-09-20

This local source review found and fixed three authorization races. Each requires a request that starts with valid access; none is an unauthenticated account takeover. The regression tests reproduced successful mutations after revocation before the fixes, and rejection after the fixes.

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Account creation and password changes could finish after the initiating session was revoked while password hashing ran. A pending administrator request could still create an administrator or reset another account's password. | Revalidate the initiating session and, for administrator operations, its current role immediately before committing account changes. |
| Medium | Single-file upload creation checked membership and authentication before asynchronous file setup, but did not repeat the checks before adding the item to the room. | Pass the same commit-time checks used for batch uploads through single-file creation. Failed authorization rolls back files, reservations, and upload records. |
| Medium | Upload PUT requests authenticated before receiving the body. A caller could send a partial body, wait for session revocation, then finish an accepted chunk using either a cookie or a direct grant. | Authenticate again after body parsing, and check the session after opening the file and before advancing persisted progress. |

Changes are in `server/app.js`, `server/auth.js`, and `server/uploads.js`; reproductions and regression coverage are in `test/security-regressions.test.js`. Existing unrelated workspace changes were preserved.

The review covered HTTP and WebSocket authentication, account approval, room permissions, uploads and direct grants, media fetching and subprocess input restrictions, Worker cache authorization, desktop client credential/IPC boundaries, and selected cookie-helper and deployment paths. A source scan for private-key blocks and common access-token patterns returned no matches. This scan does not establish that all possible secret formats are absent.

Validation: **198 tests passed, 0 failed, 0 skipped** on Windows, across the following suites:

```powershell
node --test --test-concurrency=1 test/security-regressions.test.js test/auth.test.js test/account-requests.test.js test/upload-playlists.test.js test/delivery.test.js test/worker.test.js test/remote-media.test.js test/server.test.js test/desktop.test.js test/caster.test.js test/cookie-helper.test.js test/youtube-cookies.test.js test/youtube-vpn.test.js test/twitch.test.js test/bootstrap-admin.test.js
```

The local test log is `test-artifacts/security-sweep-tests.log` (ignored by Git). `git diff --check` passed for the changed implementation and tests.

Dependency advisory checks remain incomplete: the initial npm registry requests failed, and automatic approval review rejected the network escalation because it would send this private project's dependency metadata to the registry. Approval for that specific check has been requested. No dependency vulnerability clearance is claimed. Native capture internals and the .NET client were not subjected to a complete runtime security audit, and no live deployment was tested or changed.
