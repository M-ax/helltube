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

The sidebar shows the frontend's build commit below the account controls (short hash, with the full hash on hover). Builds read Git `HEAD`; when building a source archive without Git metadata, set `HELLTUBE_COMMIT` to the full commit hash. The Ubuntu bootstrap passes the source checkout's commit automatically. In a split deployment, this identifies the Worker frontend release.

Production browsers check the frontend's uncached `version.json` every 30 seconds and when returning to a tab or coming online. A changed build automatically reloads the page; the existing session and selected room are restored. Automatic reloads wait while the tab holds unfinished upload files (including paused uploads) or is registering new uploads, so an update cannot discard their file access. Reloading becomes eligible again after those uploads finish or are cancelled. Each build has a unique ID, including rebuilds of the same commit. Deploy the complete `dist` together. With a Worker frontend, backend-only updates do not trigger a frontend reload. Browsers must load this update once before they can detect subsequent deployments.

Open **http://127.0.0.1:3000**. To listen on the LAN, set `$env:HOST = '0.0.0.0'` before starting. Use a TLS reverse proxy for Internet access and forward WebSocket upgrades. Set `SECURE_COOKIES=true` and `ALLOWED_ORIGINS` to your exact public origin. Do not expose this application using its seeded password.

## Cloudflare Worker frontend + bare-metal backend

`worker.js` serves the built frontend and proxies API/WebSocket traffic. **Set `BARE_METAL_ORIGIN` to your bare-metal HTTPS origin both as a Worker runtime binding and in the backend service environment.** This checkout uses a Worker secret for that binding; it is intentionally not set in `wrangler.jsonc`. No frontend rebuild is needed when changing the backend setting, but deploy the Worker with matching settings. Leave the backend setting empty for the original single-server/Vite setup.

```text
Browser → Worker: frontend, API, WebSocket, remote-media playlists
Browser → Worker cache: encrypted YouTube, Twitch VOD, and hosted-media segments (90 seconds)
Worker → bare metal: live authorization before every cached segment
Browser → bare metal directly: HLS keys, upload bytes, uploaded-video HLS
Browser → bare metal on slow Cloudflare delivery: proxied playlists and segments
```

### Bare metal

Use a public, **DNS-only (not Cloudflare-proxied)** hostname such as `https://metal.example.net`, with a valid browser-trusted TLS certificate and HTTPS terminating on your machine. Do not use Cloudflare Tunnel for this hostname: keys and uploaded data must bypass Cloudflare. A local TLS reverse proxy should forward requests to Node, including WebSocket upgrades. Keep `/internal/*` inaccessible externally; FFmpeg uses it on loopback only. Disable proxy caching for this service, especially `/direct/*`, `/api/*`, and `/media/*`; avoid buffering direct uploads/responses. Preserve `Origin`, cookies, range headers, and `X-Helltube-Edge`.

Set the following in the backend service manager (PowerShell equivalent below). Use a randomly generated secret of at least 32 characters, and configure that **same value** as the Worker's `EDGE_PROXY_SECRET` secret; do not put it in `wrangler.jsonc`, source control, or frontend build variables.

```powershell
$env:HOST = '127.0.0.1'
$env:PORT = '3000'
$env:SECURE_COOKIES = 'true'
$env:ALLOWED_ORIGINS = 'https://watch.example.com'
$env:BARE_METAL_ORIGIN = 'https://metal.example.net'
$env:EDGE_PROXY_SECRET = '<your-random-shared-secret>'
npm start
```

`BARE_METAL_ORIGIN` accepts only an HTTPS origin, without credentials, a path, query, or fragment. HTTP is allowed for loopback development. `ALLOWED_ORIGINS` must include the exact frontend origin (no trailing slash); CORS is enabled **only for `/direct/*`**, never the account API. Keys and upload/playback access use resource-scoped URLs rather than cross-site cookies, including when the frontend and backend use unrelated domains. Browser-facing direct requests omit cookies.

### Ubuntu 26.04 LXC bootstrap

For a **dedicated Ubuntu 26.04 container**, copy or clone this trusted checkout into the container, outside `/opt/helltube`, then run from its root:

```bash
sudo bash scripts/bootstrap-ubuntu.sh
```

Run as root without `sudo` if your minimal container does not have sudo installed. The script requires a real interactive terminal and a running systemd instance inside the LXC. It supports automatic Node installation on **amd64 and arm64**. It does not configure the LXC host, NAT, firewall, DNS records, or deploy the Worker.

Before running:

- Create a **DNS-only** Cloudflare A record for the backend pointing at your public IPv4 address, and forward TCP **80/443** to the container. This nginx configuration listens on IPv4; do not publish an AAAA record unless you also configure and verify IPv6 listeners/routing. Keep port **3000** private.
- Prepare the backend hostname, your Let's Encrypt email, and the frontend HTTPS origin (for example `https://watch.example.com`). Leave the frontend origin blank to serve everything from the backend hostname instead.
- Prepare a Cloudflare **API token** scoped to this zone with **Zone:DNS:Edit** and **Zone:Zone:Read** permissions. Alternatively, choose `key` to use a **Global API Key**, which also requires your Cloudflare account email. A scoped token is preferred because a global key has much broader access.
- Optionally prepare a YouTube-only Netscape cookies export using [YouTube authentication](#youtube-authentication) below. This is an account session, **not a YouTube Data API key**; leave it unconfigured if anonymous extraction works.
- To route YouTube through a VPN, prepare a standard WireGuard client profile outside the checkout. See [YouTube WireGuard VPN](#youtube-wireguard-vpn) for profile and LXC requirements.
- Allow outbound HTTPS and DNS. DNS-01 issuance requires the public zone to be hosted by Cloudflare, but does not require inbound port 80 or the backend record to be orange-cloud proxied.

The bootstrap:

- Installs missing system packages, nginx, Certbot and its Cloudflare DNS plugin, FFmpeg, and an isolated `yt-dlp[default]` Python environment. Enables Ubuntu's Universe repository when needed. Reuses a compatible system-wide Node/npm installation, or downloads the current **Node 24 LTS** archive from nodejs.org and checks its published SHA-256 checksum.
- Reads the Cloudflare credential **without terminal echo** and writes `/etc/helltube/.secrets/cloudflare.ini`, owned by `root:root` with **mode `600`**, inside a **mode `700`** directory. Credentials never go into the checkout, service environment, or Certbot command-line arguments. Reruns offer to reuse or replace the file.
- Optionally imports a YouTube cookies file into `/etc/helltube/.secrets/youtube-cookies.txt` (`root:root`, **mode `600`**). Uses systemd `LoadCredential` to expose only that secret to the backend, without granting access to the other secrets. Reruns offer reuse, replacement, or disabling authentication; disabling retains the protected saved file.
- Optionally imports `/etc/helltube/.secrets/youtube-wireguard.conf` (`root:root`, **mode `600`**) and installs WireGuard tools, nftables and a private Tinyproxy service. Both yt-dlp and YouTube FFmpeg downloads use the VPN; nginx, uploads and certificate renewal retain normal networking. Saved VPN profiles default to reuse, not disabling.
- Obtains a Let's Encrypt certificate using DNS-01 with a 60-second propagation wait. Certbot retains the credentials-file reference for renewals. Enables `certbot.timer` and installs an nginx configuration-test/reload deploy hook.
- Copies the checkout to `/opt/helltube/app`, installs locked npm dependencies and builds the frontend as the unprivileged `helltube` user, then makes application code root-owned. Runs one `helltube.service` process on loopback with persistent data in `/var/lib/helltube`.
- Replaces seeded/default account passwords before starting the backend, using a generated initial password stored in `/etc/helltube/.secrets/admin-password` (root-only). Existing non-default passwords are preserved. Source-checkout `data` is **not** imported.
- Configures HTTPS and WebSocket forwarding, blocks `/internal` and `/internal/*`, and disables proxy caching and request/response buffering. Uploads use the app's 512 KiB chunks, so the nginx per-request limit is 2 MiB, not the total video-size limit. Site access/error logs are disabled to prevent bearer URLs appearing in logs.
- Offers opt-in [automatic bare-metal updates](#automatic-bare-metal-updates) from the repository's `main` branch, with isolated builds and a systemd timer. Blank preserves the current timer setting on reruns; new installations default to disabled.
- Checks backend readiness, validates nginx configuration, and makes a local HTTPS health request with certificate verification enabled.

Retrieve the initial password privately as root, sign in as `admin`, and change it in Account. The saved initial password will not track later password changes:

```bash
sudo cat /etc/helltube/.secrets/admin-password
```

For a split Worker deployment, set the Worker's `BARE_METAL_ORIGIN` to the backend HTTPS origin and provision its `EDGE_PROXY_SECRET` using the value in `/etc/helltube/.secrets/edge-proxy-secret`. The bootstrap sets matching backend values in `/etc/helltube/helltube.env` (mode `600`); it does not change `wrangler.jsonc` or publish secrets to Cloudflare for you.

Verify certificate renewal and inspect services inside the container:

```bash
sudo certbot renew --cert-name helltube --dry-run
sudo systemctl status helltube nginx certbot.timer
sudo journalctl -u helltube -n 100 --no-pager
```

Rerun from the updated checkout with the same hostname to redeploy. It preserves deployed data, generated secrets, existing changed passwords, and reusable certificates, but **overwrites the managed nginx site, service unit and environment file** and stops the backend during deployment. Back up `/var/lib/helltube` with the service stopped and `/etc/helltube` before upgrades. A failed deployment exits immediately; there is no automatic rollback. Fix the reported error and rerun. Existing nginx sites are left alone; resolve conflicting hostname/listener configurations before deployment.

Node and yt-dlp are not automatically upgraded when already installed. Keep them current; update the managed yt-dlp environment with `sudo /opt/helltube/tools/bin/pip install --upgrade 'yt-dlp[default]'`. Keep the Cloudflare credential file for unattended renewals and protect any backups of it. For slower DNS propagation, adjust the 60-second Certbot setting before issuance.

Bootstrap-specific checks (safe, no package installation or live certificate requests):

```bash
bash -n scripts/bootstrap-ubuntu.sh
bash test/bootstrap.test.sh
node --test test/bootstrap-admin.test.js
node --test test/youtube-cookies.test.js
node --test test/youtube-vpn.test.js
python3 test/wireguard.test.py
# Linux/root: updater tests use temporary files and mocked external commands, not installed services:
sudo python3 test/update.test.py
# Linux with systemd and Tinyproxy installed (validates units; does not start them):
bash test/bootstrap-units.test.sh
# Optional root-only Linux network test; uses synthetic peers in private namespaces:
sudo python3 test/wireguard.integration.py --run
```

### Automatic bare-metal updates

The bootstrap can install **`helltube-update.timer`** to poll **[`M-ax/helltube`, branch `main`](https://github.com/M-ax/helltube)** approximately every **five minutes**, with up to 30 seconds of jitter and an initial check two minutes after boot. Only that branch is tracked, not every branch or tag. Polling needs outbound HTTPS to GitHub and the npm registry, but **no GitHub token, webhook, inbound port, or additional secret**.

**Enable on an existing container:** update your trusted checkout outside `/opt/helltube`, then rerun the bootstrap and answer **`yes`** to automatic updates. Reuse your existing secrets/VPN settings as appropriate; this one-time bootstrap redeploy still prompts for configuration.

```bash
git pull --ff-only
sudo bash scripts/bootstrap-ubuntu.sh
```

The timer is enabled only after the bootstrap's deployment health checks succeed. Its first successful update establishes the Git revision baseline, so expect one build/restart even if your manual checkout was already current. Later checks do nothing when `main` has not changed. A successful manual bootstrap resets that baseline.

For each new commit, the updater:

- Fetches the exact observed commit into a fresh staging directory. If the branch changes between checking and fetching, it aborts safely and retries on a later check.
- Runs locked `npm ci`, `npm test`, and the frontend build as a separate **`helltube-build`** account in a restricted systemd service, without access to production data or secrets. The existing backend remains online during this work. Builds have a 20-minute limit; unsupported Node/dependency requirements fail instead of silently upgrading the runtime.
- Prunes development dependencies after tests and the build, without rerunning package lifecycle scripts. This removes build-only esbuild/workerd hard links; release sealing still rejects any remaining hard links or special files instead of weakening filesystem safety checks.
- Makes the candidate code root-owned, stops the backend, replaces `/opt/helltube/app`, and starts it again. It requires three consecutive loopback `/api/health` successes before recording the deployed revision. Restarts briefly interrupt playback/connections; this is not zero-downtime deployment.
- Preserves `/var/lib/helltube` and `/etc/helltube`, including accounts, uploads, environment settings, certificates, cookies, and the WireGuard profile. A shared deployment lock prevents overlap with another update or the bootstrap. An already-stopped backend is left stopped.

**Trust and scope:** enabling this automatically trusts future `main` commits and their npm dependencies to run as your backend, with its data and configured YouTube account access. Protect repository write access and review/merge changes accordingly. The updater does not verify commit signatures. Builds are isolated from production files, but still use host networking. Keep space under `/opt/helltube` for the running app, a staged build/npm cache, and one previous app copy.

Updates replace application code, **not** nginx/systemd configuration, OS packages, Node, yt-dlp, or the Cloudflare Worker. The privileged updater and WireGuard helper are pinned in `/usr/local/lib/helltube` by the trusted bootstrap; downloaded app code is never used as a root deployment hook. Rerun the bootstrap to adopt infrastructure/helper changes. **Deploy the Worker separately** when frontend/API changes require it; this timer cannot keep a separately deployed Worker in sync.

```bash
# Check schedule and recent update/build results:
sudo systemctl list-timers helltube-update.timer
sudo journalctl -u helltube-update.service -n 200 --no-pager

# Check for an update immediately (waits for build/restart if needed):
sudo systemctl start helltube-update.service

# Pause future automatic checks; this does not cancel an in-progress update:
sudo systemctl disable --now helltube-update.timer

# Resume automatic checks after setup/recovery:
sudo systemctl enable --now helltube-update.timer
```

**Failures and recovery:** fetch, dependency, test, or build failures leave the old backend running and are retried on later checks. A failed startup/health check stops the candidate and leaves `/opt/helltube/update-state/pending.json`, which blocks further automatic deployments. Interrupted cutovers also require administrator review. The previous code is retained at `/opt/helltube/update-state/previous-app` after replacement; it is **not a data backup**. Before candidate startup, a failed code swap restores the old backend where possible.

There is deliberately **no automatic rollback after candidate startup**: the new server may already have migrated SQLite or changed uploads. Disable the timer, inspect both update and backend journals, and back up the stopped server's data before repairing it. Use a trusted, schema-compatible checkout and rerun the bootstrap (choose updates disabled until the problem in `main` is resolved). Only a successful bootstrap clears the failure marker and revision baseline. Do not just delete the marker or copy old code over a potentially migrated database. Continue keeping your own consistent data/secrets backups as described above.

**Startup error: `Deployment directories must be root-owned and protected, without symlinks.`** Older bootstraps extracted Node with the archive's numeric owner (for example, UID/GID `1001`), so the updater correctly rejected `/opt/helltube/node/bin` or npm's directories. Check ownership without exposing secrets:

```bash
sudo namei -l /etc/helltube/update.json /opt/helltube/app /opt/helltube/update-state /usr/local/bin/node /usr/local/bin/npm
```

If this confirms the original bootstrap-installed Node tree has the archive's owner, repair **only that runtime tree**, under the deployment lock, then retry. This does not modify application data, secrets, or the failure marker:

```bash
sudo systemctl stop helltube-update.timer
sudo flock -x /run/lock/helltube-deploy.lock sh -ec 'chown -hR root:root /opt/helltube/node; chmod -R go-w /opt/helltube/node'
sudo systemctl start helltube-update.service
sudo systemctl start helltube-update.timer
sudo journalctl -u helltube-update.service -n 100 --no-pager
```

The fixed bootstrap extracts new Node archives as root with protected permissions, while retaining read/execute access for the unprivileged services. Rerunning the bootstrap may reuse an existing Node installation, so apply the repair above first when affected. The updated pinned updater reports the exact rejected path, owner and mode; rerun the trusted bootstrap to install those diagnostics. Do not recursively change ownership of `/opt/helltube`, `/var/lib/helltube` or `/etc/helltube`, or bypass the updater's checks. If a different path is rejected, investigate it separately; if runtime contents may have been tampered with, reinstall a verified Node distribution instead of merely changing ownership.

### YouTube WireGuard VPN

Helltube uses **yt-dlp**, with **FFmpeg fetching the extracted video/audio URLs**. VPN mode sends both through the same private HTTP proxy inside a WireGuard-only network namespace. This preserves the same public egress IP for extraction and playback, without changing the container's default route or moving nginx/the backend into the VPN.

**Enable:** export/download a standard WireGuard client profile from your VPN provider, transfer it privately into the container **outside the checkout** (for example `/root/youtube-wireguard.conf`), and restrict it with `chmod 600`. Run `sudo bash scripts/bootstrap-ubuntu.sh` from the updated checkout and supply its absolute path at the WireGuard prompt. The profile is validated and atomically imported as `/etc/helltube/.secrets/youtube-wireguard.conf`, owned by `root:root`, mode **`600`**, inside the existing **`700`** secrets directory. Neither the app nor the proxy receives its private key. After import, remove your transfer copies and protect backups. Never put VPN keys in Worker secrets or frontend settings.

Requirements:

- The **LXC host kernel** must support WireGuard. The container must be permitted to create network/mount namespaces and veth interfaces and manage nftables (`CAP_NET_ADMIN` and namespace/mount permissions). An unprivileged/restricted LXC may need narrowly scoped host configuration; the bootstrap does not change the host or disable its security policy. Allow outbound UDP to the VPN endpoint. Failure aborts deployment, rather than enabling direct fallback.
- Use one `[Interface]` with `PrivateKey`, `Address` and **numeric `DNS` server addresses reachable through the VPN**, and one `[Peer]` with `PublicKey`, `Endpoint` and `AllowedIPs` containing **`0.0.0.0/0`**. Optional `MTU`, `ListenPort`, `PresharedKey` and `PersistentKeepalive` are supported. IPv6 needs both a VPN IPv6 address and `::/0`; otherwise IPv6 egress is blocked. Localhost/link-local DNS stubs such as `127.0.0.53` are not supported.
- Shell hooks (`PreUp`, `PostUp`, `PreDown`, `PostDown`), `SaveConfig`, custom `Table`, multiple peers and vendor-specific extensions are rejected, not executed. Use a plain full-tunnel profile; the bootstrap owns routing and DNS. Do not also start this profile with `wg-quick`.
- The transport subnet **`169.254.77.0/30`** and names `helltube-youtube`, `ht-wg0`, `ht-vpn-host`, `ht-vpn-peer` are reserved by this deployment. Conflicts cause setup to fail.

The proxy listens only on **`169.254.77.2:8888`**, accepts connections from the container's `169.254.77.1`, and is not an Internet-facing proxy. Its namespace has no ordinary Internet gateway: nftables allows outbound traffic through WireGuard and only established proxy replies over the veth link. DNS lookups for YouTube/media happen inside the VPN, without using the host's resolver daemon. Resolving a **VPN endpoint hostname itself** happens on the host before tunnel creation; use a numeric endpoint if that bootstrap DNS lookup must also be avoided. No request URLs are logged by the proxy. The bootstrap verifies a proxied HTTPS request to YouTube's public `robots.txt` before starting the backend; a successful handshake alone is not treated as a working connection.

**Fail-closed:** a dead tunnel or stopped proxy makes YouTube requests fail; there is no automatic direct retry. Inherited `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY` and `NO_PROXY` variants are removed from proxied subprocesses. The web app and upload playback remain on their original networking. This is egress isolation for these YouTube requests, not a sandbox for a compromised media parser; browser thumbnail fetches and browser-to-server traffic are not tunneled.

Reruns offer **reuse / replace / disable**, with **blank meaning reuse** when a profile exists. Explicitly disabling restores direct YouTube access and stops the managed VPN/proxy, but retains the protected profile. To rotate credentials, rerun and choose replacement. After an administrator manually replaces the saved profile, restart **both services**:

```bash
sudo systemctl restart helltube-vpn helltube-youtube-proxy
sudo systemctl status helltube-vpn helltube-youtube-proxy
sudo journalctl -u helltube-vpn -n 100 --no-pager
sudo ip netns exec helltube-youtube wg show ht-wg0 latest-handshakes
# This third-party endpoint sees the VPN's public IP, not credentials.
curl --fail --max-time 30 --noproxy '' --proxy http://169.254.77.2:8888 https://api.ipify.org
```

Confirm that IP matches your VPN provider, then add/play a video through your normal site. To verify the kill switch during a maintenance window, bring `ht-wg0` down inside `helltube-youtube` and repeat the explicit-proxy curl: it must fail, while `/api/health` and uploads remain reachable. Bring the interface back up afterward. Do not use `wg showconf` or publish profiles/dumps containing private keys.

**Tinyproxy exits `70` opening its systemd credential:** Ubuntu's `/etc/apparmor.d/tinyproxy` can deny Helltube's credential/PID paths. Rerun the updated trusted bootstrap with VPN enabled. It installs `/etc/apparmor.d/local/helltube-youtube-proxy` with only credential-read and PID-read/write rules, preserves custom `local/tinyproxy` content/permissions, and reloads the profile before proxy startup. The sandbox, private paths and suppressed request logs remain unchanged. Disabled/unavailable kernel AppArmor interfaces skip reload; an enabled interface rejecting policy loading aborts with an LXC privilege diagnostic—resolve this on the host without disabling AppArmor. No-profile/no-VPN installs do not modify shared policy. Automatic app updates do not install this infrastructure fix.

**CONNECT returns 200, then TLS fails with `Permission denied`:** Inspect the **Proxmox host's** kernel journal for Tinyproxy `operation="file_perm" class="net" requested="receive"` denials. A working WireGuard handshake does not rule out this failure. AppArmor's ABI 5 fine-grained socket mediation has had [kernel bugs affecting socket reads/writes](https://bugs.launchpad.net/bugs/2141298); adding network allowances or disabling the VPN firewall is not the fix. This behavior was reproduced with Ubuntu AppArmor 5.0.2 on `6.17.2-1-pve`: an enforcing ABI 4.0 profile with the same coarse network/filesystem rules restored proxy traffic. Confirm that diagnosis on the affected host rather than assuming every TLS failure has this cause.

The live recovery uses a **Helltube-only compatibility pin**: `/etc/apparmor.d/helltube-youtube-proxy-compat` and `/etc/systemd/system/helltube-youtube-proxy.service.d/20-apparmor-compat.conf`. Other profiles and the distribution's Tinyproxy profile remain unchanged; AppArmor enforcement and WireGuard/nftables isolation stay enabled. This is not a default bootstrap setting. Update the host kernel to a release containing the relevant AppArmor fixes, then re-test the distribution's ABI 5 profile during maintenance before retiring only this compatibility profile/drop-in. Retain the credential/PID allowances above. Bootstrap reruns preserve the drop-in, so rerunning the bootstrap alone does not remove the compatibility pin.

**Startup error: `Cannot safely inspect existing network resources.`** Older helpers reject the empty output that `ip -j netns list` can return on a fresh host when `/run/netns` does not exist. This happens before tunnel creation and is not evidence of invalid VPN credentials. The updated helper accepts empty namespace output only after independently confirming the directory is absent or empty; existing handles, inspection errors, failed commands and malformed JSON still fail closed.

From a trusted checkout containing the fix, rerun the bootstrap and reuse the saved settings, or replace only the installed helper during a maintenance window (this briefly stops YouTube networking):

```bash
sudo systemctl stop helltube-youtube-proxy helltube-vpn
sudo install -o root -g root -m 755 scripts/wireguard.py /usr/local/lib/helltube/wireguard.py
sudo systemctl restart helltube-vpn helltube-youtube-proxy
sudo systemctl status helltube-vpn helltube-youtube-proxy --no-pager
```

The automatic app updater does **not** replace this privileged helper. As a temporary workaround for an older helper, if `sudo ip -j netns list` succeeds with blank output and `/run/netns` is absent, create that directory with `sudo mkdir -p /run/netns`, then restart both services. `/run` is volatile, so install the fix for subsequent boots. Do not delete existing namespaces, interfaces or ownership markers to bypass inspection failures.

For a non-bootstrap deployment, **`YOUTUBE_PROXY=http://proxy-host:port`** applies to both yt-dlp and YouTube FFmpeg inputs. Only credential-free HTTP proxy origins are accepted; setting this variable alone does **not** create a VPN or firewall. You must supply equivalent isolated proxy networking. Empty/unset retains the existing direct behavior. A VPN does not guarantee that YouTube bot checks disappear, and does not remove the cookie-account ban risk described below.

### YouTube authentication

Helltube uses **yt-dlp**, not youtube-dl. A **YouTube Data API key does not sign in your account** and will not fix “Sign in to confirm you're not a bot.” Optional browser cookies are supplied to both metadata/playlist extraction and playback-source extraction, even with yt-dlp's `--ignore-config` option.

**Account risk:** [yt-dlp's maintainers warn of temporary or permanent account bans](https://github.com/yt-dlp/yt-dlp/wiki/Extractors#exporting-youtube-cookies). Low-volume use by a few friends does not guarantee safety; there is no published ban-safe request threshold. Avoid using a valuable primary Google account. Everyone using this Helltube backend shares the configured YouTube identity, potentially including access to account-only content; this is not per-user YouTube login. Only share content you are authorized to access and redistribute.

Export cookies on your own computer, not inside the headless LXC:

1. Choose a reputable Netscape-format exporter from [yt-dlp's cookie-export FAQ](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp), such as **Get cookies.txt LOCALLY** for Chrome or **cookies.txt** for Firefox. Review its permissions and allow it in private browsing only when needed. Do not use online cookie-conversion services.
2. Open a fresh private/incognito window and sign in to YouTube with the account you intend the backend to use. Complete any legitimate sign-in or verification prompts normally.
3. In the **same tab**, navigate to `https://www.youtube.com/robots.txt`, keeping it the only private/incognito tab. Export **only `youtube.com` and its subdomain cookies** to `youtube-cookies.txt` in Netscape format, then close the entire private window and do not reopen that session. This follows yt-dlp's advice to avoid browser-driven cookie rotation.
4. Transfer the export privately to a file inside the container, outside the checkout (for example `/root/youtube-cookies.txt` when using a root SSH account). Restrict it to its owner with `chmod 600 /root/youtube-cookies.txt`. Never paste cookies into chat, tickets, shell commands, frontend settings, or Worker secrets. Do not export your entire browser profile: it includes unrelated accounts and the bootstrap rejects non-YouTube cookie domains.
5. From the updated checkout, run `sudo bash scripts/bootstrap-ubuntu.sh` and provide that file's absolute path at the optional YouTube cookies prompt. On later deployments choose reuse, replace, or disable as appropriate. The bootstrap validates/imports the file and restarts the backend. After successful import, remove the transfer/export copies you created, including the local browser download.

The original secret remains root-only. The service receives a read-only credential snapshot, and each yt-dlp invocation uses its own temporary **mode `600`** working copy in a **mode `700`** directory. Working copies are removed after subprocess completion, including handled failures/cancellation; yt-dlp's cookie updates are deliberately not written back to the saved secret. Raw extractor errors are hidden while cookies are configured because malformed-cookie diagnostics can contain credential values.

To refresh expired or revoked cookies, repeat the export and rerun the bootstrap choosing replacement. A direct administrator replacement of the saved file also requires `sudo systemctl restart helltube` to reload systemd's snapshot. To disable use, rerun the bootstrap and choose disable; revoke the exported session in your Google account as well if it may have leaked. Merely disabling Helltube's use does not revoke the session.

For a non-bootstrap deployment, set **`YTDLP_COOKIES_FILE`** to a private, backend-readable Netscape file path and restart the backend. On Linux restrict the file to its owning service account (`600`) and parent directory (`700`); on Windows use equivalent account-only NTFS permissions. The source can be read-only because yt-dlp receives a copy. An unset/empty variable retains anonymous behavior; an unreadable configured file fails rather than silently continuing anonymously. Keep credentials outside the checkout; the ignore rules are only an additional safeguard.

Cookies are **not a guaranteed bot-check fix**: keep yt-dlp and its JavaScript runtime current, avoid repeated retries and unnecessarily large playlists, and remember that queue preparation/seeks can make more requests than the number of videos pasted. Extraction is shared per media job, not repeated for every viewer. YouTube can still reject the container's IP or require a [Proof of Origin token](https://github.com/yt-dlp/yt-dlp/wiki/PO-Token-Guide); automated PO-token provisioning is not included here.

If you separately need a **YouTube Data API key** for an application using Google's official metadata API: create/select a project in [Google Cloud Console](https://console.cloud.google.com/), enable **YouTube Data API v3** under **APIs & Services → Library**, then choose **Credentials → Create credentials → API key**. Restrict it to **YouTube Data API v3** and the appropriate application restriction (for a server, its public egress IP). That key identifies the Cloud project, not a logged-in YouTube account; private account data needs OAuth authorization. Helltube does not consume that key.

### Worker deployment

1. Set the Worker's runtime `BARE_METAL_ORIGIN` secret to the same bare-metal HTTPS origin, using Settings → Variables and Secrets or `wrangler secret put BARE_METAL_ORIGIN`. Enter only the origin, without surrounding quotes or whitespace, and deploy dashboard changes. Build variables do not create runtime bindings. A `vars.BARE_METAL_ORIGIN` entry in `wrangler.jsonc` is an alternative for this non-sensitive URL, but do not define it as both a variable and a secret. `SEGMENT_CACHE_TTL` controls the short internal cache lifetime (default 90 seconds, maximum 120).
2. Authenticate Wrangler with your Cloudflare account and provision `EDGE_PROXY_SECRET` using Cloudflare's dashboard secret binding or `wrangler secret put EDGE_PROXY_SECRET`. Never store the value as an ordinary Worker variable.
3. Run `npm run deploy:worker`, then attach your frontend hostname (for example `watch.example.com`) as the Worker's custom domain. Set `ALLOWED_ORIGINS` to match it. The backend hostname must not route back to this Worker.
4. Change the seeded administrator password before permitting external access.

The deploy script builds `dist` before publishing. Wrangler is a development dependency; no Worker runtime is needed on bare metal. For local split-host testing, build first and use `npm run dev:worker`; put local `BARE_METAL_ORIGIN` and `EDGE_PROXY_SECRET` overrides in an ignored `.dev.vars`, use the same settings on the backend, and allow the local Worker origin in `ALLOWED_ORIGINS`. Keep `SECURE_COOKIES=false` for HTTP loopback. Do not override protected routes with Cloudflare cache rules or expose the assets binding through a separate unauthenticated media route.

#### Diagnosing Worker 502 responses

Worker-generated 502 responses keep the generic `Upstream unavailable.` body and `no-store` headers, but include a safe `X-Helltube-Error` code. No binding values, cookies, request URLs, or exception messages are included. Inspect the failing request's response headers in browser developer tools, or check the public health endpoint without sending credentials:

```powershell
curl.exe --silent --show-error --include --max-time 20 'https://watch.example.com/api/health'
```

| `X-Helltube-Error` | Meaning / next check |
| --- | --- |
| `origin-missing` | The running Worker received no `BARE_METAL_ORIGIN` or an empty string; no backend request was attempted. Check that binding on the active Worker serving this hostname. |
| `origin-invalid` | Origin validation failed before proxying. Check for quotes, whitespace, non-string bindings, or anything other than an HTTPS origin; HTTP is allowed only for loopback development. |
| `edge-secret-missing` | The origin is valid, but the Worker received no `EDGE_PROXY_SECRET` or an empty string. |
| `edge-secret-invalid` | The shared-secret binding is not a usable string (for example, it contains surrounding whitespace or line breaks). |
| `upstream-request-failed` | Bindings passed validation, but constructing or fetching the backend request threw. Check runtime compatibility and backend DNS, TLS, IPv4/IPv6 routing, firewall, and reachability from Cloudflare. Direct browser reachability alone does not verify Worker reachability. |
| `media-authorization-failed` | The backend authorization check returned an unexpected status or unreadable decision. Cached segments remain inaccessible. |
| `assets-fetch-failed` | Fetching or processing the `ASSETS` response failed. |
| `upstream-response-failed` / `worker-error` | Processing the upstream response or another Worker operation threw. |

A normal proxied backend response is not assigned a Worker error code: signed-out `/api/me` should return 401, and rejected edge credentials return 403. A 502 without the header may come from the backend, an older Worker, or another proxy; check its body and the hostname's routing rather than assuming a missing secret. A healthy backend `/api/health` together with a Worker error code lets you distinguish backend availability from Worker configuration without sharing credentials.

### Encryption, caching, and privacy limits

FFmpeg encrypts MPEG-TS HLS using **AES-128**, with a random 16-byte key per job and a sequence-derived IV per segment. Far seeks/restarts create a new job and key. Keys and FFmpeg key-info files are kept separately from public segment directories and cleaned up with their jobs. Standard `hls.js` and native HLS decrypt during playback; no custom player crypto is required.

Only successful, complete encrypted **YouTube, Twitch VOD, and hosted-media** segments enter the shared cache. The Worker checks the live session, room membership, job, and file with the backend **before every hit**. It never caches playlists, API responses, keys, errors, ranges, or uploaded video. Browser-facing media responses are `no-store`; the short public TTL exists only on the private internal cache copy. Do not add CDN cache rules that override these headers. When the authorization server is unavailable, cached content is not served.

The Cache API is local to each Cloudflare data center, not Tiered Cache. Misses, simultaneous requests, expiry, and eviction can still produce multiple origin fetches; this reduces bandwidth but does **not** guarantee one transfer globally. Uploaded videos deliberately consume bare-metal bandwidth per viewer instead. Worker request charges/quotas and applicable Cloudflare video-delivery terms still apply.

Direct access URLs are **bearer credentials restricted to one media job or one upload**. They remain valid only while the issuing session is valid; every use rechecks current membership/ownership. They survive backend restarts and expire with the session, so native HLS can pause/resume without short-lived URL renewal. Logout/revocation immediately blocks new requests. Do not log query strings containing `grant`, publish these URLs, or persist them in browser storage. Already delivered keys, decoded buffers, or saved segments cannot be revoked; this is not DRM.

Cloudflare receives encrypted segment bytes but no key responses in this design. It still sees metadata, sizes, timing, and scoped access URLs through API/playlists, and serves the client JavaScript. This protects against readable segments sitting in its cache, **not an actively untrusted provider obtaining keys or identifying content**. Provider-blind confidentiality needs an independently trusted client and authentication path. Safari/native HLS should be smoke-tested with your actual TLS hostnames before rollout.

## Watching together

**Supported links:** public Twitch recordings such as `https://www.twitch.tv/videos/123456789?t=1h2m3s`, and directly downloadable HTTP/HTTPS media files such as `https://example.com/movie.mp4`. Hosted files support common video containers (MP4/MOV, WebM/MKV, AVI, MPEG/TS, Ogg) and audio (MP3, M4A, AAC, FLAC, WAV, AIFF). Signed query strings and range requests are preserved; the URL must remain valid while preparing or seeking. No browser CORS configuration is needed on the file host because the backend reads the source and serves the shared encrypted stream.

Hosted files with unknown duration receive an early **ffprobe metadata check** when their current/next media job starts. It reads through the protected range proxy, so an MP4's index can be fetched from the end without downloading the intervening media. Duration is sent to viewers and saved before conversion completes, making the full seek timeline available; seeking still prepares the selected position as needed. Known durations are reused across seeks and restarts, and starts at/past the discovered end are rejected. The optional probe has a 10-second timeout, bounded stream analysis/output, and the same file-format restrictions as hosted playback. Missing ffprobe, invalid metadata or a timeout leave playback on the normal conversion path, with duration filled in on completion. Cancelling/removing a job stops its probe. FFprobe is normally installed alongside FFmpeg; use `FFPROBE_PATH` if it lives elsewhere.

Hosted watch pages with a static `<video src>`, `<audio src>`, or nested `<source src>` also work, including archive pages whose addresses end in `.mp4` but return HTML. The backend reads at most 256 KiB of HTML, resolves relative URLs and escaped query separators, and validates the media destination again. It preserves the submitted page URL and resolves it for each new media range request so temporary signed links can refresh. JavaScript-only players and pages without a native media source require a direct file link. Page resolution and HTTP redirects share a five-hop limit.

Twitch uses the installed yt-dlp, without the YouTube cookies or YouTube VPN configuration. Only public VODs are supported, not channels, clips, or subscriber-only recordings. Hosted links require a public Internet address; local/private addresses, embedded credentials, and hosted HLS/DASH playlists are rejected. Hosted files work without yt-dlp. Twitch and hosted files use the same queue, history, synchronization, encrypted segment delivery, and direct-key access as YouTube.

- Create a room or join **The living room**. Use **Video link** to paste a YouTube video or playlist URL, a Twitch VOD URL, or a public HTTP/HTTPS media file URL. Playlist submissions expand up to **200** playable entries per submission; queue size is capped at **500**. A URL with a `list` parameter adds the playlist.
- YouTube and Twitch VOD links with a `t` parameter (such as `&t=90`, `?t=90s`, or `&t=1m30s`) reveal a checked **Start at** option below the URL. Edit seconds, `M:SS`, or `H:MM:SS`, or use its spring-return joystick for **±30-second** adjustments per release; uncheck to start at zero. This sets the queued video's shared starting point, without seeking the currently playing video. Preparation and replay use that start time too; everyone can still seek earlier. For playlists, it applies only to the linked video (or the first playable entry for playlist-only links), preserving playlist order. Times at or beyond a known video duration are rejected.
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

The buffer health row updates every second with **locally buffered seconds**, seconds ready at the source, the current delivery route, and recent download speed (hls.js). In split deployments, each viewer automatically switches YouTube playback from Cloudflare to **metal** when buffer stays below six seconds for six seconds, playback stalls for three seconds with less than half a second buffered, or a proxy playlist/segment request fails. Initial loads and room seeks have a four-second grace period. Pauses, blocked autoplay, source preparation, disconnection, and fully buffered endings do not trigger a health-based switch. The granted fallback URL is obtained before loading the stream, so recovery needs no further proxy API call. Metal stays selected for that video, including retries and far seeks; a different video starts with the default route. The player catches up to the room clock and displays the switch reason; other viewers and shared controls are unaffected. Native HLS uses the same buffer monitoring without download-speed metrics. Reports remain local to the viewer. Deploy the updated backend and frontend to enable fallback; an older backend without `fallbackUrl` continues using its original route.

The visual player is a WebGL video-textured plane with an **orthographic projection**, implemented without an extra graphics dependency in `src\lib\video-renderer.js`. Coordinates are CSS pixels from the viewport's top-left, ready for future composited overlays; the current room notices remain accessible HTML above the canvas. The native video element still handles HLS decoding, audio, and synchronization. Rendering follows decoded frames, preserves aspect ratio, redraws paused seeks and resizes, and caps resolution at 2× device pixels / 4096 per dimension. WebGL unavailability or context loss falls back to native video; a restored context rebuilds the renderer.

Ghost and beach-ball layers share that orthographic WebGL composition, with a transparent 2D effects canvas for native-video fallback. Preview video bytes are capped at **32 MiB**, pruned with the local playback buffer, and cleared on media changes; only the requested fragment is decoded, into an image no larger than 960×540. Offsets are translated through the current stream's base time. Ball animation stops when hidden or disabled and does not re-upload unchanged video frames.

## Uploads and backpressure

Drop videos directly onto **Your files** (even while Video link is selected) or its upload area, or click **Choose videos** to select one or several files. Multiple files become one playlist in selection/drop order at the chosen queue position. The title is the longest shared whole-word phrase from all filenames, ignoring extensions and differences in casing/separators: `Night Walk - 01.mp4` + `Night Walk - 02.mkv` becomes **Night Walk**. With no usable common text, the title is **Uploaded videos**. A single video stays ungrouped. Separate batches remain separate playlists even if their names match.

Select up to **100** videos per batch, subject to the existing queue limit, the server-wide limit of 100 retained upload sources, and the storage budget. Empty/non-video selections are rejected with an explanation. Batch metadata and queue entries are saved together before any upload starts, so a rejected batch never leaves a partial playlist. Uploaded playlists support the same reordering, individual removal, and one-click queued-group removal as YouTube playlists.

Local videos use sequential **512 KiB** acknowledged HTTP chunks with offset recovery, never an unbounded WebSocket binary flood. TCP handles retransmission and congestion control; application pacing reduces excess queueing but cannot guarantee zero packet loss.

The server exposes a loopback-only, secret-protected growing range source to FFmpeg. Playback can start while the browser is still uploading. Once estimated upload headroom exceeds **45 seconds**, the uploader delays requests adaptively. Current and next uploads are active; later queued uploads wait. Keep the uploading tab open. Upload metadata and acknowledged offsets persist in SQLite, and each chunk is flushed before acknowledgment. Active uploads automatically reconnect after a metal deployment or network outage, checking the saved offset and obtaining a fresh transfer URL before sending more bytes. Recovery backs off up to 15 seconds between attempts and continues through long outages; reconnecting the room or coming online wakes the retry sooner. Paused uploads stay paused, and authorization failures or removed uploads require attention. Closing or manually reloading the page still requires reselecting the original unchanged file from your account's unfinished uploads; browsers cannot restore a local File object automatically.

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
| `FFPROBE_PATH` | Beside FFmpeg | Optional ffprobe executable override for early hosted-file duration |
| `YTDLP_PATH` | `yt-dlp` | yt-dlp executable path |
| `YTDLP_COOKIES_FILE` | empty | Optional private Netscape YouTube cookies file; backend-readable path, never the cookie contents (bootstrap configures this via systemd credentials) |
| `YOUTUBE_PROXY` | empty | Optional HTTP proxy origin used by both yt-dlp and YouTube FFmpeg downloads; bootstrap sets its WireGuard-isolated proxy automatically |
| `MAX_TRANSCODERS` | `4` | Global concurrent media jobs |
| `MAX_UPLOAD_BYTES` | `10737418240` | Maximum individual upload (10 GiB) |
| `MAX_STORAGE_BYTES` | `32212254720` | Shared upload/media budget (30 GiB; checked every 10s) |
| `CLEANUP_INTERVAL_MS` | `60000` | Interval for sweeping unreferenced uploads and streaming files |
| `SECURE_COOKIES` | `false` | Set `true` behind HTTPS |
| `ALLOWED_ORIGINS` | localhost Vite origins | Comma-separated additional trusted browser origins; same-origin always accepted |
| `BARE_METAL_ORIGIN` | empty | Public DNS-only HTTPS backend origin for direct keys, uploaded-video playback, and upload chunks; also set as a Worker runtime binding |
| `EDGE_PROXY_SECRET` | empty | Shared backend/Worker secret (at least 32 characters) enabling authenticated edge authorization; store as a Worker secret |

Durable application state lives in **`data\helltube.sqlite`**, using Node's built-in SQLite support (no separate database installation). This includes accounts with salted scrypt hashes, sessions and their expiry/revocation, volume/mute preferences, rooms, ordered queues/playlist groups, five-item history, shared playback checkpoints, and upload metadata/offsets. Existing `users.json` accounts migrate transactionally without changing IDs or passwords; legacy account files are removed only after a successful migration. Invalid databases are not silently reset.

Playback mutations are saved immediately, and advancing clocks are checkpointed every **750ms**. Offline time does not advance playback: restart rebuilds each current stream at the saved position, resuming only if it was previously playing or waiting for media. Paused rooms remain paused. Live connections/presence, decoders, temporary previews, and buffers are runtime resources and are recreated, not restored as phantom viewers.

On startup, obsolete streaming segments under `data\media` and unreferenced/legacy files under `data\uploads` are removed. Original upload bytes remain on disk **while referenced by a current video, any queue, or the five-item history**; storing large video blobs inside SQLite is intentionally avoided. Missing source files produce an actionable error instead of a broken stream. Shutdown retains referenced uploads; runtime cleanup cancels obsolete jobs and removes their files, and sweeps orphan files every minute (configurable above). Cleanup never removes the SQLite database or unrelated files in `DATA_DIR`.

Run **one Node process** per data directory, not a load-balanced cluster. A database ownership guard rejects a second updated backend before it can clean an active server's media. Stop the existing server before upgrading. To back up, stop the server and copy `helltube.sqlite` **and `uploads` together**; live backups must use SQLite's backup facilities rather than copying a live database without its WAL.

## Security and operating limits

Session cookies are HttpOnly/SameSite=Strict; HTTP and WebSocket origin checks, role checks, login/command/submission rate limits, bounded message/chunk sizes, upload ownership, and authenticated room-media checks are enforced. Password/role changes revoke sessions. The last administrator cannot be deleted or demoted. Only validated YouTube and Twitch VOD URLs reach yt-dlp, subprocesses do not use a shell, and uploaded network-playlist formats are denied to FFmpeg.

Run media processing as an unprivileged OS account/container with CPU/disk limits and restricted egress if admitting untrusted users: FFmpeg and yt-dlp are external parsers, not a complete sandbox. The storage budget is a guardrail, not a filesystem quota. Native HLS fallback depends on browser buffering behavior; Chrome/Edge/Firefox use hls.js. Live broadcasts and DRM are not supported; private/paid/age-gated content is not guaranteed even with [optional cookie authentication](#youtube-authentication). YouTube may rate-limit or require bot verification; those failures surface as errors and can be skipped. Only stream content you have permission to access and share.

## Verification

```powershell
npm test
npm run test:media
npm run build
npm run test:browser
npm run test:worker
# Optional: contacts YouTube (requires a working Internet connection and current yt-dlp).
npm run test:youtube
```

`npm test` covers SQLite migration/rollback, session and volume persistence, restart recovery, periodic cleanup and retention, room clocks, queues/playlists/history, upload resumption/pacing, URL validation, and real HTTP/WebSocket connections. It requires FFmpeg for capability checks but does not contact YouTube. `test:media` generates a synthetic video with FFmpeg, confirms playable HLS **before upload completion**, decodes served media before and after a server restart, checks next-video preparation/history, and rejects malicious uploaded playlists. Fixtures live under ignored `test-artifacts` and clean themselves up. No external YouTube availability is assumed by the deterministic test suite.

`test:browser` requires installed Google Chrome. It builds the app and uses Playwright to test two separate user sessions, admin creation/deletion, uploaded video decoding, sub-second synchronization, shared pause/seek, offline recovery, display-name changes, and mobile overflow. It also checks WebGL pixels against native decoded frames, fullscreen/HiDPI resizing, context recovery, native fallback, joystick spring motion/alignment, and reduced motion. Desktop/mobile screenshots are saved under `test-artifacts`. `test:youtube` exercises the complete real YouTube-to-HLS path; set `YOUTUBE_TEST_URL` to test another public video or playlist. Its success depends on YouTube availability and access policies.

`test:worker` uses local Wrangler and Chrome with distinct frontend/backend origins. It checks real WebSocket proxying, direct upload and encrypted playback, cookie-free key delivery, shared segment caching, and authorization of warm cache hits using synthetic media; it does not deploy to Cloudflare or contact YouTube. Production DNS/TLS configuration, global cache behavior, and Safari/native HLS still require deployment smoke tests.

Implementation: `server\rooms.js` (state engine), `server\media.js` (job scheduler/HLS), `server\uploads.js` (growing sources/pacing), `server\youtube.js` (extraction), `server\auth.js` (accounts), `server\app.js` (HTTP/WebSockets), and `src` (Svelte client). See `CONTRACT.md` for API details.
