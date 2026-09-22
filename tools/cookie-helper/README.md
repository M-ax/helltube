# Windows YouTube Cookie Helper

A native Windows tray app with dedicated Chrome/Edge sign-in, scheduled YouTube-only Netscape exports, optional Windows startup and SSH delivery to Helltube. It runs while you are signed in to Windows, including with its settings window closed. It cannot refresh while the PC is asleep, off or signed out; overdue refreshes run after wake.

## Start

Requires Windows 10/11, Node.js 22.13+, installed Chrome or Edge, and this checkout's npm dependencies. The launcher compiles the tray executable with Windows' included .NET Framework compiler. No .NET SDK, Python, Electron or browser extension is required on the PC.

```powershell
npm install
npm run cookie-helper
```

1. Select Chrome or Edge and a cookies file (the default is private). Click **Save settings**.
2. Click **Sign in**. Complete Google login, consent and verification in the ordinary Chrome/Edge window that opens. **Close all windows of that dedicated browser**, then click **Finish sign-in** in the helper. The helper reopens the saved profile in the background, exports cookies and closes it.
3. Enable **Refresh automatically**, choose an interval (default 60 minutes, minimum 15), and save. Optionally enable **Start in tray when I sign in to Windows**.
4. Close settings to keep running in the tray. Double-click the red play icon or use its menu to reopen settings, refresh, sign in or quit. Blue means refreshing; amber means attention is needed.

Sign in and Refresh now use **saved settings**. Switching browser creates a separate profile and requires another sign-in. Cancel sign-in asks the browser to close without changing the export. Scheduled refresh stays paused until you finish or cancel sign-in, including after closing its browser. Clicking Finish sign-in too early asks you to close the browser first. Uncheck automatic refresh and save to pause it. Quit closes the worker and asks its browser to close after the current operation finishes. If a browser window remains open, close it before restarting the helper. Only one tray instance runs per Windows account.

The GUI shows last export, last server sync, next attempt and safe errors. Failures retry after 5, 10, 20, etc. minutes, capped at the configured interval. A failed login/refresh preserves the previous export. Failed SSH delivery keeps the newly saved local file and reports the sync failure; the next attempt refreshes and retries.

If a helper crash leaves a background browser holding its profile, the next Sign in or refresh closes that abandoned browser normally before reopening the saved profile. This also recovers browsers whose debugging port file was removed by an older helper. A browser still owned by a running helper is left alone; quit that helper before retrying. An open sign-in browser asks you to close its windows first.

For refresh and export, the helper reports a normal Windows Chrome user agent using the most popular numbered Chrome version in [Statcounter's latest worldwide desktop usage report](https://gs.statcounter.com/browser-version-market-share/desktop/worldwide). These are monthly browsing-usage measurements, used as a proxy for installed popularity; unversioned categories such as Chrome for Android cannot identify a release. The helper checks for updated data at most once every 24 hours when starting background refresh and records the selection in `chrome-identity.json`. A failed lookup preserves the last known selection; offline first use has a bundled Chrome 151 selection from the August 2026 report. The GUI shows the selected version, report month and any cached/bundled fallback.

Sign-in uses the installed browser's real identity, without remote debugging, an automation connection or a User-Agent override. [Google can reject sign-ins from automated browsers](https://support.google.com/accounts/answer/7675428?hl=en). The helper waits for that browser to exit and save its profile before opening it for background refresh. If Google previously showed "This browser or app may not be secure," quit and reopen the updated helper, click Sign in, and retry in the new window. Update Chrome/Edge if Google still rejects the browser.

Background refresh and exports use the selected Chrome identity, even if Edge is the installed browser. The helper sets the User-Agent before navigation and aligns the refresh page's JavaScript identity and User-Agent Client Hints with that Chrome major version. `HeadlessChrome` is never used in a new export. New usage data takes effect when the helper next refreshes. The popularity lookup is a separate HTTPS request with no Google cookies or credentials, a ten-second timeout and a size limit.

A `# Helltube-User-Agent: ...` comment in the Netscape file carries this identity with the cookies through local replacement, SSH delivery and each extraction's private snapshot. Helltube supplies it to yt-dlp through `--add-headers User-Agent:...` for metadata and playback requests. Existing exports without the comment keep yt-dlp's default. No additional setting or server credential is needed. Restart the helper and choose **Refresh now** to replace any previous HeadlessChrome export; the backend must include the user-agent metadata support described above, and SSH installations should use the updated receiver. This changes the reported browser identity, not the installed browser engine, TLS fingerprint or source IP; it does not guarantee avoiding YouTube verification.

## Local Helltube

The default export is `%LOCALAPPDATA%\Helltube\CookieHelper\youtube-cookies.txt`. To use it with Helltube running under your Windows account:

```powershell
$env:YTDLP_COOKIES_FILE = Join-Path $env:LOCALAPPDATA 'Helltube\CookieHelper\youtube-cookies.txt'
npm start
```

Restart an existing backend once to configure this variable. Subsequent replacements are picked up by each new extraction. If another account runs the backend, arrange a suitable private destination and access for that account.

## Optional SSH delivery to managed Ubuntu

First enable cookies using the [updated bootstrap](../../README.md#youtube-authentication) and an initial YouTube-only export. It installs the receiver and configures `YTDLP_COOKIES_FILE=/etc/helltube-cookies/youtube-cookies.txt`. SSH refresh atomically replaces that file **without restarting or reloading `helltube.service`**. New extractions read the refreshed cookies and user agent; active extractions keep their private copies. Desktop shares and connections stay open. Inactive/failed services stay stopped, and identical contents leave the file untouched.

For an older installation using `LoadCredential`, run the updated bootstrap once during maintenance and choose **reuse**. It migrates the legacy root-only export when no live file exists and restarts the backend once to adopt the new path. Subsequent cookie refreshes need no restart. Updating only the receiver or running `daemon-reload` does not migrate a running process; the receiver rejects that state without changing cookies or restarting the backend. Automatic application updates do not install this infrastructure migration.

The bootstrap installs the receiver. To update it later on an already migrated server, use this checkout:

```bash
sudo install -o root -g root -m 0755 scripts/import-youtube-cookies.py /usr/local/sbin/helltube-import-cookies
```

For a non-root SSH account, use `sudo visudo -f /etc/sudoers.d/helltube-cookies` to grant only this command (replace `YOUR_SSH_USER`):

```sudoers
YOUR_SSH_USER ALL=(root) NOPASSWD: /usr/local/sbin/helltube-import-cookies ""
```

Set up SSH key authentication from the PC. Connect interactively once, verify the host-key fingerprint and store that verified key. Load encrypted keys into Windows `ssh-agent` first. The helper never asks for or saves SSH passwords/passphrases. It uses Windows OpenSSH with noninteractive authentication and strict known-host checking; cookies travel exclusively through encrypted standard input.

Enter the hostname (or IPv4 address), username, port and optional absolute key path, enable SSH sync and save. An empty key path uses normal OpenSSH identity/agent configuration. Hostname aliases from your SSH config work; for IPv6 use a hostname. **Refresh now** exports locally and syncs.

The receiver requires Python 3.9+, runs in isolated mode, validates format/size/domains/account cookies, uses the existing deployment lock and atomically replaces a root-owned file. The directory is `root:helltube` mode `750` and the file is mode `640`: Helltube can read but cannot write or replace it, and unrelated root-only secrets remain inaccessible. It accepts no client-supplied paths or commands. Invalid input and failed atomic replacements preserve the previous export. Concurrent deployments cause a retryable failure. No new HTTP endpoint or Worker secret is involved.

## Session and storage

Settings, nonsecret timestamps and dedicated browser profiles live in `%LOCALAPPDATA%\Helltube\CookieHelper`, protected for your Windows account and SYSTEM. Export files receive private Windows ACLs before contents are written and are replaced atomically. Use a local NTFS destination outside the checkout. Network paths and destinations inside the helper's browser profiles are rejected. Exports are sensitive account sessions, not encrypted archives; the browser profile also holds Google login state. Cookie values are never displayed, logged or placed in process arguments.

During background refresh, the helper makes a short-lived loopback DevTools connection to its own profile, following [Chrome's separate-profile requirement](https://developer.chrome.com/blog/remote-debugging-port). No DevTools connection is opened during sign-in. It never reads your ordinary browser profile. Closing the browser after export stops ongoing tab-driven rotation. Unlike [yt-dlp's manual private-session export](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies), this is a periodically refreshed session: old copies may stop working after later refreshes, so keep the destination synchronized.

Google can revoke sessions, deny browser sign-in, require verification, or reject requests from a server's IP. A successful export means the browser reports a signed-in session, not that server playback has been verified. Use Sign in when attention is needed. The helper cannot solve YouTube challenges or guarantee indefinite login. Existing Helltube [account-use considerations](../../README.md#youtube-authentication) apply.

Keep the checkout, `node_modules`, Node executable and `tools/cookie-helper/bin/HelltubeCookieHelper.exe` available: Windows startup uses their absolute paths. Quit before rebuilding or moving the checkout, then relaunch and save settings to update startup. To uninstall, uncheck Windows startup, save, quit and remove the local data folder and any external exports. Revoke the Google session separately if desired; removing local files does not revoke it.

## Verification

```powershell
npm run test:cookie-helper
node --test test/cookie-helper.browser.integration.js
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/cookie-helper/start.ps1 -SmokeTest
python test/import-youtube-cookies.test.py -v
```

The browser test uses isolated Chrome profiles, synthetic cookies, a local sign-in fixture and intercepted refresh responses. It verifies that sign-in has no debugging connection, cookie persistence survives the transition to background refresh, and cancellation closes the owned browser. Set `COOKIE_HELPER_TEST_BROWSER=edge` to exercise Edge instead. The worker test checks that scheduled refresh stays paused until sign-in finishes or is cancelled. The native GUI smoke test uses an isolated folder, exercises the startup launcher configuration, captures its own settings window and exits without enabling refresh or Windows startup. Artifacts are under ignored `test-artifacts/`. Run the Python tests as root on Linux to also exercise atomic refresh, file permissions, deployment locking, migration checks and replacement failures in temporary fixtures (systemctl is mocked; no host service is changed). `node --test test/youtube-cookies.test.js` verifies concurrent extractions keep their snapshots across refresh. Live Google authentication and SSH delivery require your account and configured server.
