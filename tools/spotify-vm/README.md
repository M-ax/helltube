# Spotify desktop VM

Metal hosts a real Ubuntu 24.04 KVM guest: four vCPUs, 3 GB RAM, a sparse 30 GB disk,
and a 1920×1080 XFCE desktop. Spotify and Chrome come from their signed vendor APT
repositories. QEMU runs as `helltube-spotify-vm`, with access to `/dev/kvm`.

## Open the private desktop

From the project directory on Windows:

```powershell
./tools/spotify-vm/connect.ps1
```

This uses `.secrets/metal-credentials.json` and creates localhost-only SSH forwards.
The browser console is <http://127.0.0.1:6081/vnc.html?autoconnect=true&resize=scale>.
Guest SSH is forwarded to `127.0.0.1:22022`. Neither service is exposed publicly.
The generated VM keys and connection metadata are in `.secrets/`, which is ignored
by Git. The tunnel PID and diagnostics are there too. To close the tunnel:

```powershell
Stop-Process -Id ([int](Get-Content .secrets/spotify-vm-tunnel.pid))
```

Sign into Spotify through its login button or QR code. Then use the desktop's
**Enable Helltube sharing** launcher. XFCE may ask you to trust that launcher the
first time. Use **Disable Helltube sharing** before private account work. Sharing
is disabled initially; removing `~/.config/helltube/sharing-enabled` also disables it.

Spotify selects the music-video version in its own UI using **Switch to video**,
when available for that account and track. This integration does not manufacture
a video stream from an audio-only track or automatically click Spotify's video
toggle. Actual video availability and playback need verification after login.

## Room playback

When the backend integration is enabled, a Spotify queue entry opens on this
desktop. The bridge captures X11 video and the `helltube.monitor` PulseAudio source.
FFmpeg sends H.264 and stereo Opus RTP through QEMU's host alias `10.0.2.2` to
loopback-only mediasoup transports on metal. Existing authenticated WebRTC room
subscriptions deliver the stream to viewers. Video and audio are encoded once;
no media file is recorded.
Capture uses the full X11 desktop at startup, preserving its aspect ratio and
scaling down only when it exceeds 1920×1080. H.264 Baseline level 4.0 supports
1080p at 30 fps, with a 4.5 Mbps target and 6 Mbps ceiling. If the desktop resolution
changes during an active capture, it takes effect on the next capture start.

Audio capture requests 20 ms PulseAudio fragments and uses PCM sample counts for
continuous Opus timestamps, preserving the initial video/audio offset. Pulse's
latency updates no longer become gaps or overlaps in encoded audio. Receivers request
100 ms of audio jitter buffering. The VM encodes stereo Opus at 320 kbps / 48 kHz
with the music application and maximum encoder complexity. Constant bitrate keeps
each 20 ms audio frame within the RTP packet budget, including sudden transients;
constrained VBR can exceed that budget. The raw video queue is limited to eight
frames (about 64 MiB at 1080p) so capture stalls cannot fill the guest's RAM.

One VM/account serves one room at a time. The player explains this exclusive use;
other rooms display the name of the room using Spotify and wait without taking over.
The green Spotify controls centered in the bottom bar operate its previous track,
play/pause, and next track for everyone. The separate Skip button advances the
Helltube queue. Volume stays local to
each viewer. Audio-reactive visualizations are shown by default, with a per-viewer
Visualizations / Desktop switch. The visualizer taps the received stream without
adding another audible output or changing the desktop's volume controls.
Visualization viewers subscribe to audio alone initially. Opening Desktop adds
video on the same connection; switching back pauses only that viewer's video
consumer at the relay. Audio never pauses or reconnects during these changes.
The VM capture stays running for other desktop viewers and quick view switches.

Consecutive Spotify entries retain the same VM encoder, relay, desktop tile and
viewer subscriptions. Skip changes Spotify's URI while capture continues, so the
desktop and visualization selection stay in place. Leaving the Spotify sequence
releases the desktop and lets another waiting room use it. A single track
also advances when Spotify moves to a different track; collections use Spotify's
own navigation and the room's Skip control. A paused track does not advance.

The original Spotify entry stays in room state and history. VM disconnects,
disabled sharing, missing login/playback metadata, and stalled capture release
media resources without silently discarding that entry. The bridge stops capture
after ten seconds without requests or when its SSH connection ends. Streaming
also stops when the last viewer leaves. A new backend connection requires the
same pinned guest SSH host key.

Without `SPOTIFY_DESKTOP_KEY`, existing per-device Spotify embeds remain available.
With the VM configured, the room shows its connection/readiness state and never
plays an embed alongside the shared stream.

## Host configuration and deployment

The VM is independent of `helltube.service`:

```bash
systemctl status helltube-spotify-vm helltube-spotify-console
journalctl -u helltube-spotify-vm -n 30
systemctl stop helltube-spotify-vm   # requests a graceful guest shutdown
systemctl start helltube-spotify-vm
```

The live VM disk, seed, and serial log are under `/var/lib/helltube-spotify-vm`.
Provisioning sources are under `/opt/helltube-spotify-vm`. Re-running `provision.sh`
retains an existing disk; cloud-init does not reinstall an already initialized guest.
Changes to `bridge.py` must also be copied to `/opt/helltube/bridge.py` in the guest.
The restricted SSH command is `/usr/local/bin/helltube-spotify-bridge`.
An already connected bridge keeps its loaded code; end that bridge connection
after installing an update so the backend reconnects with the new capture settings.
This briefly interrupts playback. Frontend buffering changes require the normal
application deployment and a viewer reload as well.
Install the updated guest bridge before deploying the consecutive-track feature:
its `open` request accepts `keepCapture: true` for a track handoff. Regular opens,
disconnects, disabled sharing and expired heartbeats still stop capture.

The backend needs a dedicated private key whose matching public key is installed
in the guest `spotify` user's `authorized_keys` with `restrict` and the forced
bridge command. It also needs a host-key file verified through the private admin
connection. These files belong in `/etc/helltube-spotify`, readable by `helltube`.
The prepared systemd drop-in uses:

```ini
[Service]
Environment=SPOTIFY_DESKTOP_KEY=/etc/helltube-spotify/bridge.key
Environment=SPOTIFY_DESKTOP_KNOWN_HOSTS=/etc/helltube-spotify/known_hosts
Environment=SPOTIFY_DESKTOP_PORT=22022
```

Deploy the separate **spotify - desktop VM playback** WebStorm changeset through
the normal application deployment. The VM and credentials can be prepared before
that deployment; the currently running backend does not pick up the new integration
until it is deployed and restarted. The setup does not change the running app checkout.

## Provision a fresh VM

Pass through `/dev/kvm` to metal and verify KVM VM creation first. Generate two
Ed25519 key pairs, one for private guest administration and one for the restricted
bridge. Keep private keys in `.secrets/`. Copy this tool directory and the two
public keys to `/opt/helltube-spotify-vm` on metal, then run as root:

```bash
cd /opt/helltube-spotify-vm
bash provision.sh spotify-vm-admin.pub spotify-vm-bridge.pub
```

Provisioning verifies the Ubuntu image against its published SHA-256 checksum,
builds the cloud-init seed, and starts the guest. Installation continues in the
guest; inspect `/var/log/helltube-desktop-install.log` there. The completion marker
is `/var/lib/helltube-desktop-installed`.

Installer sources: [Ubuntu cloud images](https://cloud-images.ubuntu.com/noble/current/),
[Spotify Linux](https://www.spotify.com/us/download/linux/),
[Google package signing](https://www.google.com/linuxrepositories/).

## Validation

```bash
node --test test/spotify-desktop.test.js test/audio-sources.test.js test/desktop.test.js
npm run build
node --test test/spotify-desktop.browser.integration.js
```

The browser integration needs Chrome and FFmpeg. It exercises real H.264/Opus RTP,
two WebRTC viewers, audible decoded audio, shared controls, and cleanup; Spotify
itself is replaced with a controlled fixture. Linux bridge tests run with:

```bash
python3 test/spotify-vm.test.py
```

On the provisioned VM, set `HELLTUBE_BRIDGE_PATH=/opt/helltube/bridge.py` when running
that test outside the repository. Live checks also verify guest X11/Pulse capture
and guest-to-metal RTP reception. These checks do not replace testing a signed-in
Spotify account and its available videos.
