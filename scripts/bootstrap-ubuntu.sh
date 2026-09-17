#!/usr/bin/env bash
set +x
set -Eeuo pipefail
umask 077

die() {
  printf 'Error: %s\n' "$*" >&2
  exit 1
}

valid_hostname() {
  local label
  [[ ${#1} -le 253 && $1 == *.* && $1 != *[!a-zA-Z0-9.-]* ]] || return 1
  [[ $1 != .* && $1 != *. && $1 != *..* ]] || return 1
  local -a labels
  IFS=. read -r -a labels <<< "$1"
  for label in "${labels[@]}"; do
    [[ ${#label} -le 63 && $label != -* && $label != *- ]] || return 1
  done
}

valid_email() {
  [[ $1 =~ ^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$ ]]
}

valid_credential() {
  [[ ${#1} -ge 20 && ${#1} -le 256 && $1 =~ ^[a-zA-Z0-9_-]+$ ]]
}

prompt() {
  local value
  read -r -p "$2" value <&3 || die 'Input closed.'
  printf -v "$1" '%s' "$value"
}

prompt_secret() {
  local value
  read -r -s -p "$2" value <&3 || die 'Input closed.'
  printf '\n' >&3
  printf -v "$1" '%s' "$value"
}

write_cloudflare_credentials() {
  local destination=$1 kind=$2 credential=$3 email=${4:-} temporary
  valid_credential "$credential" || die 'Invalid Cloudflare credential format.'
  [[ $kind == token || $kind == key ]] || die 'Choose token or key.'
  if [[ $kind == key ]]; then
    valid_email "$email" || die 'Invalid Cloudflare account email.'
  fi
  [[ ! -L $destination ]] || die 'Refusing a symlinked credential file.'
  temporary=$(mktemp "${destination}.XXXXXX")
  chmod 600 "$temporary"
  if [[ $kind == token ]]; then
    printf 'dns_cloudflare_api_token = %s\n' "$credential" > "$temporary"
  else
    printf 'dns_cloudflare_email = %s\ndns_cloudflare_api_key = %s\n' "$email" "$credential" > "$temporary"
  fi
  chown root:root "$temporary"
  mv -fT "$temporary" "$destination"
}

valid_youtube_cookies() {
  local size
  [[ -f $1 && -r $1 && ! -L $1 ]] || return 1
  size=$(stat -c %s -- "$1" 2>/dev/null) || return 1
  (( size < 1048576 )) || return 1
  LC_ALL=C awk '
    function invalid() { bad = 1; exit 1 }
    BEGIN { FS = "\t" }
    {
      sub(/\r$/, "")
      if ($0 ~ /[\000-\010\013-\037\177]/) invalid()
    }
    NR == 1 {
      if ($0 !~ /^# (Netscape )?HTTP Cookie File$/) invalid()
      next
    }
    (/^#/ && !/^#HttpOnly_/) || /^$/ { next }
    /^#HttpOnly_/ { sub(/^#HttpOnly_/, "") }
    {
      if (NF != 7 || $2 !~ /^(TRUE|FALSE)$/ || $4 !~ /^(TRUE|FALSE)$/ ||
          $3 !~ /^\// || $5 !~ /^[0-9]*$/ ||
          $6 !~ /^[!#$%&\047*+.^_`|~0-9A-Za-z-]+$/ ||
          (($2 == "TRUE") != ($1 ~ /^\./))) invalid()
      domain = tolower($1)
      sub(/^\./, "", domain)
      if (length(domain) > 253 || (domain != "youtube.com" && domain !~ /\.youtube\.com$/)) invalid()
      count = split(domain, labels, /\./)
      for (i = 1; i <= count; i++) {
        if (length(labels[i]) > 63 || labels[i] !~ /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/) invalid()
      }
      cookies++
    }
    END { exit (bad || !cookies) }
  ' 2>/dev/null < "$1"
}

import_youtube_cookies() (
  local source=$1 destination=$2 temporary=''
  [[ -f $source && -r $source && ! -L $source ]] || die 'Choose a readable, regular cookies file, not a symlink.'
  [[ ! -L $destination && ( ! -e $destination || -f $destination ) ]] || die 'Refusing an unsafe cookie destination.'
  umask 077
  trap '[[ -z $temporary ]] || rm -f -- "$temporary"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  temporary=$(mktemp "${destination}.XXXXXX") || die 'Cannot create a private cookie import.'
  # Validate a private snapshot, not a source that may change during validation.
  cp --no-dereference -- "$source" "$temporary" 2>/dev/null || die 'Cannot copy the cookies file.'
  valid_youtube_cookies "$temporary" || die 'Invalid Netscape cookies file; export youtube.com cookies only.'
  chmod 600 "$temporary" || die 'Cannot protect the cookies file.'
  chown root:root "$temporary" || die 'Cannot set the cookies owner.'
  [[ ! -L $destination && ( ! -e $destination || -f $destination ) ]] || die 'Refusing an unsafe cookie destination.'
  mv -fT -- "$temporary" "$destination" || die 'Cannot install the cookies file.'
)

configure_youtube_cookies() {
  local destination=$1 choice cookie_path
  YOUTUBE_COOKIES_ENABLED=no
  [[ ! -L $destination && ( ! -e $destination || -f $destination ) ]] || die 'Refusing an unsafe cookie destination.'
  printf 'Optional YouTube authentication: import a pre-exported Netscape cookies file from a filesystem path.\n' >&3
  printf 'Export youtube.com only. Cookies are sensitive account credentials, not a YouTube Data API key; do not paste their contents.\n' >&3
  if [[ -f $destination ]]; then
    prompt choice 'Stored YouTube cookies: [reuse/replace/disable] (blank disables; stored file is kept): '
    case $choice in
      ''|disable) return ;;
      reuse) cookie_path=$destination ;;
      replace)
        prompt cookie_path 'Path to the replacement Netscape cookies file: '
        [[ -n $cookie_path ]] || die 'A replacement file path is required.'
        ;;
      *) die 'Choose reuse, replace, or disable.' ;;
    esac
  else
    prompt cookie_path 'Path to a Netscape cookies file (blank or skip disables authentication): '
    [[ -n $cookie_path && $cookie_path != skip ]] || return 0
  fi
  import_youtube_cookies "$cookie_path" "$destination" || die 'YouTube cookies were not enabled; the stored file was not replaced.'
  YOUTUBE_COOKIES_ENABLED=yes
}

configure_youtube_vpn() {
  local destination=$1 helper=$2 choice vpn_path
  YOUTUBE_VPN_ENABLED=no
  [[ ! -L $destination && ( ! -e $destination || -f $destination ) ]] || die 'Refusing an unsafe VPN destination.'
  printf 'Optional YouTube VPN: import a WireGuard profile from outside the checkout; never paste private keys.\n' >&3
  printf 'Requires host kernel WireGuard support and LXC permission for network namespaces, veth and nftables.\n' >&3
  if [[ -f $destination ]]; then
    prompt choice 'Stored WireGuard profile: [reuse/replace/disable] (blank reuses; disable restores direct YouTube access): '
    case $choice in
      ''|reuse) vpn_path=$destination ;;
      replace)
        prompt vpn_path 'Absolute path to the replacement WireGuard profile: '
        [[ $vpn_path == /* ]] || die 'An absolute replacement file path is required.'
        ;;
      disable) return ;;
      *) die 'Choose reuse, replace, or disable.' ;;
    esac
  else
    prompt vpn_path 'Absolute path to a WireGuard profile (blank or skip leaves direct access enabled): '
    [[ -n $vpn_path && $vpn_path != skip ]] || return 0
    [[ $vpn_path == /* ]] || die 'An absolute file path is required.'
  fi
  python3 "$helper" import "$vpn_path" "$destination" || die 'WireGuard profile was not enabled; fix the profile and rerun.'
  YOUTUBE_VPN_ENABLED=yes
}

acquire_deployment_lock() {
  local lock_file=${1:-/run/lock/helltube-deploy.lock}
  command -v flock >/dev/null || die 'Install util-linux (flock) before running this bootstrap.'
  [[ ! -L $lock_file && ( ! -e $lock_file || ( -f $lock_file && -O $lock_file ) ) ]] || die 'Refusing an unsafe deployment lock.'
  exec 9> "$lock_file" || die 'Cannot open the deployment lock.'
  flock -n 9 || die 'Another Helltube deployment is running; retry after it finishes.'
}

configure_auto_update() {
  local choice default=no
  if systemctl is-enabled --quiet helltube-update.timer 2>/dev/null; then default=yes; fi
  printf 'Optional automatic backend updates from public https://github.com/M-ax/helltube.git main.\n' >&3
  printf 'Enabling means you trust automatic main code, including npm dependencies; deployments cause brief restarts.\n' >&3
  printf 'Checks run about 5 minutes after the previous job, 2 minutes after boot, plus up to 30 seconds random delay, and when a new Worker commit is announced. Worker deployment stays separate and manual.\n' >&3
  prompt choice "Enable automatic backend updates? [yes/no] (blank keeps $default; fresh default no): "
  case $choice in
    '') AUTO_UPDATE_ENABLED=$default ;;
    yes|no) AUTO_UPDATE_ENABLED=$choice ;;
    *) die 'Answer yes or no, or leave blank to preserve the timer enabled state.' ;;
  esac
}

ensure_build_account() {
  if ! id helltube-build >/dev/null 2>&1; then
    useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin helltube-build
  fi
  [[ $(id -u helltube-build) =~ ^[1-9][0-9]*$ && $(id -u helltube-build) != "$(id -u helltube)" ]] ||
    die 'The build account must be separate from root and helltube.'
  [[ $(id -Gn helltube-build) == helltube-build ]] || die 'The build account must belong only to its own helltube-build group.'
  [[ $(getent passwd helltube-build | cut -d: -f6) == /nonexistent ]] || die 'Existing build account has an unexpected home directory.'
  [[ $(getent passwd helltube-build | cut -d: -f7) == /usr/sbin/nologin ]] || die 'The build account must use /usr/sbin/nologin.'
}

render_update_config() {
  python3 - "$1" "$2" <<'PY'
import json
import sys

json.dump({"node": sys.argv[1], "npm": sys.argv[2]}, sys.stdout)
sys.stdout.write("\n")
PY
}

render_update_service() {
  cat <<'EOF'
[Unit]
Description=Helltube automatic backend update
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
User=root
ExecStart=/usr/bin/python3 /usr/local/lib/helltube/update-helltube.py
TimeoutStartSec=30min
UMask=0077
EOF
}

render_update_timer() {
  cat <<'EOF'
[Unit]
Description=Check for Helltube backend updates

[Timer]
OnBootSec=2min
OnUnitInactiveSec=5min
RandomizedDelaySec=30s
Unit=helltube-update.service

[Install]
WantedBy=timers.target
EOF
}

render_update_path() {
  cat <<'EOF'
[Unit]
Description=Wake Helltube updater when a Worker commit is announced

[Path]
PathChanged=/var/lib/helltube/worker-deployment.json
Unit=helltube-update.service

[Install]
WantedBy=multi-user.target
EOF
}

reset_update_state() {
  local directory=$1 file
  [[ ! -L $directory && ( ! -e $directory || -d $directory ) ]] || die 'Refusing an unsafe updater state directory.'
  for file in pending.json deployed.json; do
    if [[ -f $directory/$file && ! -L $directory/$file ]]; then
      rm -- "$directory/$file" || die 'Cannot reset updater state after the manual deployment.'
    fi
  done
}

install_update_units() {
  [[ $AUTO_UPDATE_ENABLED == yes || $AUTO_UPDATE_ENABLED == no ]] || die 'Invalid auto-update setting.'
  render_update_service > "$WORK_DIR/helltube-update.service"
  render_update_timer > "$WORK_DIR/helltube-update.timer"
  render_update_path > "$WORK_DIR/helltube-update.path"
  install -o root -g root -m 644 "$WORK_DIR/helltube-update.service" /etc/systemd/system/helltube-update.service
  install -o root -g root -m 644 "$WORK_DIR/helltube-update.timer" /etc/systemd/system/helltube-update.timer
  install -o root -g root -m 644 "$WORK_DIR/helltube-update.path" /etc/systemd/system/helltube-update.path
  systemctl daemon-reload
  if [[ $AUTO_UPDATE_ENABLED == yes ]]; then
    systemctl enable --now helltube-update.timer helltube-update.path
  else
    systemctl disable --now helltube-update.timer helltube-update.path
  fi
}

render_vpn_service() {
  cat <<'EOF'
[Unit]
Description=Helltube YouTube WireGuard network
Wants=network-online.target
After=network-online.target
Before=helltube-youtube-proxy.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/bin/python3 /usr/local/lib/helltube/wireguard.py up
ExecStop=/usr/bin/python3 /usr/local/lib/helltube/wireguard.py down
TimeoutStartSec=90
TimeoutStopSec=30
UMask=0077

[Install]
WantedBy=multi-user.target
EOF
}

render_youtube_proxy_service() {
  cat <<'EOF'
[Unit]
Description=Helltube YouTube VPN proxy
BindsTo=helltube-vpn.service
After=helltube-vpn.service
PartOf=helltube-vpn.service

[Service]
Type=simple
User=helltube-proxy
Group=helltube-proxy
NetworkNamespacePath=/run/netns/helltube-youtube
BindReadOnlyPaths=/run/helltube-vpn/resolv.conf:/etc/resolv.conf
BindReadOnlyPaths=/run/helltube-vpn/nsswitch.conf:/etc/nsswitch.conf
LoadCredential=proxy-config:/etc/helltube/youtube-proxy.conf
ExecStart=/usr/bin/tinyproxy -d -c %d/proxy-config
RuntimeDirectory=helltube-youtube-proxy
RuntimeDirectoryMode=0700
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
CapabilityBoundingSet=
RestrictAddressFamilies=AF_INET AF_INET6
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
UMask=0077
StandardOutput=null
StandardError=null

[Install]
WantedBy=multi-user.target
EOF
}

render_youtube_proxy_config() {
  cat <<'EOF'
Port 8888
Listen 169.254.77.2
Allow 169.254.77.1
ConnectPort 443
Timeout 120
MaxClients 32
LogFile "/dev/null"
LogLevel Critical
PidFile "/run/helltube-youtube-proxy/tinyproxy.pid"
DisableViaHeader Yes
EOF
}

require_safe_apparmor_path() {
  local path=$1 kind=$2 metadata owner mode links
  while :; do
    [[ ! -L $path && ( ( $kind == file && -f $path ) || ( $kind == directory && -d $path ) ) ]] ||
      die "Refusing unsafe AppArmor $kind: $path"
    metadata=$(stat -c '%u:%a:%h' -- "$path") || die "Cannot inspect AppArmor path: $path"
    IFS=: read -r owner mode links <<< "$metadata"
    [[ $owner == 0 && $mode =~ ^[0-7]{3,4}$ ]] && (( (8#$mode & 0022) == 0 )) ||
      die "AppArmor path must be root-owned and not group/world-writable: $path"
    [[ $kind != file || $links == 1 ]] || die "Refusing hardlinked AppArmor file: $path"
    [[ $path != / ]] || break
    path=$(dirname -- "$path")
    kind=directory
  done
}

install_youtube_proxy_apparmor() (
  local rootfs=${1:-/} profile directory local_file addon temporary='' enabled state destination last_byte
  [[ $rootfs == /* ]] || die 'AppArmor rootfs must be an absolute path.'
  rootfs=${rootfs%/}
  profile=$rootfs/etc/apparmor.d/tinyproxy
  [[ -e $profile || -L $profile ]] || return 0
  require_safe_apparmor_path "$profile" file
  grep -qE '^[[:space:]]*#?include[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?<local/tinyproxy>[[:space:]]*(#.*)?$' "$profile" ||
    die "AppArmor profile lacks the local/tinyproxy include hook: $profile"
  directory=$rootfs/etc/apparmor.d/local
  local_file=$directory/tinyproxy
  addon=$directory/helltube-youtube-proxy
  if [[ -e $directory || -L $directory ]]; then
    require_safe_apparmor_path "$directory" directory
  else
    mkdir -m 755 -- "$directory" || die 'Cannot create the AppArmor local directory.'
    chown root:root "$directory" || die 'Cannot secure the AppArmor local directory.'
  fi
  for destination in "$local_file" "$addon"; do
    if [[ -e $destination || -L $destination ]]; then
      require_safe_apparmor_path "$destination" file
    fi
  done
  trap '[[ -z $temporary ]] || rm -f -- "$temporary"' EXIT
  temporary=$(mktemp "$addon.XXXXXX") || die 'Cannot stage the AppArmor addon.'
  printf '%s\n' '/run/credentials/helltube-youtube-proxy.service/proxy-config r,' \
    '/run/helltube-youtube-proxy/tinyproxy.pid rw,' > "$temporary" || die 'Cannot write the AppArmor addon.'
  chown root:root "$temporary" && chmod 644 "$temporary" || die 'Cannot secure the AppArmor addon.'
  mv -fT -- "$temporary" "$addon" || die 'Cannot install the AppArmor addon.'
  temporary=''
  if [[ ! -e $local_file ]]; then
    : > "$local_file" || die 'Cannot create the Tinyproxy local policy.'
    chown root:root "$local_file" && chmod 644 "$local_file" || die 'Cannot secure the Tinyproxy local policy.'
  fi
  if grep -qE '^[[:space:]]*#?include[[:space:]]+(if[[:space:]]+exists[[:space:]]+)?<local/helltube-youtube-proxy>[[:space:]]*(#.*)?$' "$local_file"; then
    :
  else
    [[ $? == 1 ]] || die 'Cannot inspect the Tinyproxy local policy include.'
    last_byte=$(tail -c 1 -- "$local_file") || die 'Cannot read the Tinyproxy local policy ending.'
    if [[ -s $local_file && -n $last_byte ]]; then
      printf '\n' >> "$local_file" || die 'Cannot terminate the Tinyproxy local policy line.'
    fi
    printf '%s\n' 'include if exists <local/helltube-youtube-proxy>' >> "$local_file" ||
      die 'Cannot append the Tinyproxy AppArmor include.'
  fi

  # Service status alone is unreliable in containers; use the kernel's actual interface.
  enabled=$rootfs/sys/module/apparmor/parameters/enabled
  if [[ -e $enabled ]]; then
    state=$(< "$enabled") || die 'Cannot read the AppArmor kernel enabled state.'
    case $state in
      N) printf 'AppArmor is disabled in the kernel; addon saved for future boots, not reloaded.\n'; return 0 ;;
      Y) ;;
      *) die 'Cannot determine the AppArmor kernel enabled state.' ;;
    esac
  fi
  if [[ ! -d $rootfs/sys/kernel/security/apparmor ]]; then
    printf 'AppArmor kernel interface unavailable; addon saved but not reloaded.\n'
    return 0
  fi
  if ! command -v apparmor_parser >/dev/null; then
    apt-get install -y --no-install-recommends apparmor || die 'Cannot install apparmor_parser for the existing Tinyproxy profile.'
  fi
  command -v apparmor_parser >/dev/null || die 'apparmor_parser is required to reload the existing Tinyproxy profile.'
  apparmor_parser -r "$profile" ||
    die 'AppArmor Tinyproxy reload failed. The LXC host must permit policy loading; resolve policy errors/privileges and rerun bootstrap. AppArmor was not bypassed.'
)

render_nginx() {
  local hostname=$1
  valid_hostname "$hostname" || die 'Invalid backend hostname.'
  cat <<EOF
# Managed by Helltube bootstrap. No query strings or bearer grants in access logs.
map \$http_upgrade \$helltube_connection_upgrade {
    default upgrade;
    '' close;
}

server {
    listen 80;
    server_name $hostname;
    access_log off;
    error_log /dev/null;
    return 301 https://$hostname\$uri;
}

server {
    listen 443 ssl;
    server_name $hostname;
    ssl_certificate /etc/letsencrypt/live/helltube/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/helltube/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;
    ssl_session_cache shared:helltube_tls:10m;
    ssl_session_tickets off;
    access_log off;
    error_log /dev/null;

    location = /internal { return 404; }
    location ^~ /internal/ { return 404; }

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$helltube_connection_upgrade;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header X-Forwarded-For \$remote_addr;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_cache off;
        proxy_buffering off;
        proxy_request_buffering off;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
        client_max_body_size 2m;
    }
}
EOF
}

render_service() {
  local cookies_enabled=${1:-no} vpn_enabled=${2:-no}
  [[ $cookies_enabled == yes || $cookies_enabled == no ]] || die 'Invalid YouTube cookie setting.'
  [[ $vpn_enabled == yes || $vpn_enabled == no ]] || die 'Invalid YouTube VPN setting.'
  cat <<'EOF'
[Unit]
Description=Helltube backend
After=network-online.target
Wants=network-online.target
EOF
  if [[ $vpn_enabled == yes ]]; then
    printf '%s\n' 'Wants=helltube-youtube-proxy.service' 'After=helltube-youtube-proxy.service'
  fi
  cat <<'EOF'

[Service]
Type=simple
User=helltube
Group=helltube
WorkingDirectory=/opt/helltube/app
EnvironmentFile=/etc/helltube/helltube.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/helltube
EOF
  if [[ $cookies_enabled == yes ]]; then
    printf '%s\n' 'LoadCredential=youtube-cookies:/etc/helltube/.secrets/youtube-cookies.txt' \
      'Environment=YTDLP_COOKIES_FILE=%d/youtube-cookies'
  fi
  if [[ $vpn_enabled == yes ]]; then
    printf '%s\n' 'Environment=YOUTUBE_PROXY=http://169.254.77.2:8888'
  fi
  cat <<'EOF'
ExecStart=/usr/local/bin/node /opt/helltube/app/server/main.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=60
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/helltube

[Install]
WantedBy=multi-user.target
EOF
}

extract_node_archive() (
  local archive=$1 destination=$2
  install -d -o root -g root -m 755 "$destination"
  umask 022
  tar -xJf "$archive" --strip-components=1 --no-same-owner --no-same-permissions -C "$destination"
)

install_node() {
  if command -v node >/dev/null && command -v npm >/dev/null &&
    node -e 'const [a,b] = process.versions.node.split(".").map(Number); process.exit(a > 22 || (a === 22 && b >= 13) ? 0 : 1)' &&
    node --input-type=module -e 'import "node:sqlite"' >/dev/null 2>&1; then
    NODE_BIN=$(command -v node)
    NPM_BIN=$(command -v npm)
    [[ $NODE_BIN == /usr/bin/* || $NODE_BIN == /usr/local/bin/* || $NODE_BIN == /opt/* ]] ||
      die 'Use a system-wide Node installation, not a root/user version manager.'
    return
  fi
  local architecture archive checksum
  case $(dpkg --print-architecture) in
    amd64) architecture=x64 ;;
    arm64) architecture=arm64 ;;
    *) die 'Automatic Node installation supports amd64 and arm64 only.' ;;
  esac
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt -o "$WORK_DIR/SHASUMS256.txt"
  archive=$(awk -v arch="$architecture" '$2 ~ ("^node-v24\\.[0-9]+\\.[0-9]+-linux-" arch "\\.tar\\.xz$") { print $2 }' "$WORK_DIR/SHASUMS256.txt")
  [[ $archive =~ ^node-v24\.[0-9]+\.[0-9]+-linux-(x64|arm64)\.tar\.xz$ ]] || die 'Cannot identify the Node 24 archive.'
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
    "https://nodejs.org/dist/latest-v24.x/$archive" -o "$WORK_DIR/$archive"
  checksum=$(awk -v archive="$archive" '$2 == archive { print $1 }' "$WORK_DIR/SHASUMS256.txt")
  (cd "$WORK_DIR"; printf '%s  %s\n' "$checksum" "$archive" | sha256sum --check --status)
  extract_node_archive "$WORK_DIR/$archive" /opt/helltube/node
  ln -sfn /opt/helltube/node/bin/node /usr/local/bin/node
  ln -sfn /opt/helltube/node/bin/npm /usr/local/bin/npm
  ln -sfn /opt/helltube/node/bin/npx /usr/local/bin/npx
  NODE_BIN=/usr/local/bin/node
  NPM_BIN=/usr/local/bin/npm
}

cleanup() {
  [[ -z ${WORK_DIR:-} ]] || rm -rf -- "$WORK_DIR"
}

main() {
  [[ ${1:-} != --help ]] || {
    printf 'Usage: sudo bash scripts/bootstrap-ubuntu.sh\nRun interactively from a trusted checkout in an Ubuntu 26.04 LXC with systemd.\n'
    printf 'Optional YouTube authentication accepts a filesystem path to a pre-exported Netscape cookies file (youtube.com only), not an API key or pasted content.\n'
    printf 'Blank/skip leaves authentication disabled. Reruns offer reuse/replace/disable; blank disables without deleting stored cookies.\n'
    printf 'Cookies stay root-only in /etc/helltube/.secrets/youtube-cookies.txt and are passed to the service only when enabled, using systemd credentials.\n'
    printf 'Optional WireGuard profile: /etc/helltube/.secrets/youtube-wireguard.conf (root:root 600); yt-dlp and YouTube FFmpeg traffic share a fail-closed VPN proxy.\n'
    printf 'Stored VPN profiles default to reuse; explicitly choose disable to restore direct YouTube traffic. Profiles need Address, numeric DNS and a full-tunnel peer; hooks are rejected.\n'
    printf 'Optional automatic backend updates: public https://github.com/M-ax/helltube.git main; trust automatic main code including npm dependencies and expect brief restarts. Worker deployment stays separate and manual.\n'
    printf 'Auto-update default no on fresh installs; blank on reruns preserves the timer enabled state; explicit yes/no enables/disables it after successful HTTPS health.\n'
    printf 'The timer checks about 5 minutes after the previous job, 2 minutes after boot, plus up to 30 seconds random delay. Only a manual bootstrap replaces the pinned root updater and VPN helpers.\n'
    return
  }
  [[ $# == 0 ]] || die 'No arguments accepted; use --help.'
  [[ $EUID == 0 ]] || die 'Run as root (sudo bash scripts/bootstrap-ubuntu.sh).'
  export PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ $ID == ubuntu && $VERSION_ID == 26.04 ]] || die 'This bootstrap targets Ubuntu 26.04 only.'
  [[ -d /run/systemd/system ]] || die 'The LXC must boot systemd as its init system.'
  systemctl show-environment >/dev/null || die 'Cannot reach systemd inside this container.'
  acquire_deployment_lock
  exec 3<>/dev/tty || die 'An interactive terminal is required; do not pipe this script into bash.'

  local source_dir hostname frontend email consent kind credential cloudflare_email reuse
  source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  [[ -f $source_dir/package-lock.json && -f $source_dir/server/main.js &&
    -f $source_dir/scripts/bootstrap-admin.mjs && -f $source_dir/scripts/wireguard.py &&
    -f $source_dir/scripts/update-helltube.py ]] ||
    die 'Run this script from a complete Helltube checkout.'
  [[ $source_dir != /opt/helltube && $source_dir != /opt/helltube/* ]] || die 'Keep the source checkout outside /opt/helltube.'

  printf 'Configure a DNS-only backend A record in Cloudflare before continuing.\n' >&3
  printf 'Forward TCP 80/443 to this LXC; never forward the Node port 3000.\n' >&3
  prompt hostname 'Backend hostname (e.g. metal.example.net): '
  hostname=${hostname,,}
  valid_hostname "$hostname" || die 'Enter a hostname without a scheme, path, port, or wildcard.'
  prompt frontend 'Worker frontend HTTPS origin (blank for single-server deployment): '
  if [[ -n $frontend ]]; then
    if [[ $frontend != https://* ]] || ! valid_hostname "${frontend#https://}"; then
      die 'Enter https://hostname without a path, port, or trailing slash.'
    fi
  fi
  prompt email "Let's Encrypt account email: "
  valid_email "$email" || die 'Invalid certificate account email.'
  printf "Let's Encrypt subscriber agreement: https://letsencrypt.org/repository/\n" >&3
  prompt consent 'Accept the agreement and install/update this dedicated Helltube container? [yes/no]: '
  [[ $consent == yes ]] || die 'Cancelled.'

  local AUTO_UPDATE_ENABLED=no
  configure_auto_update

  for directory in /opt/helltube /etc/helltube /etc/helltube/.secrets /var/lib/helltube /usr/local/lib/helltube; do
    [[ ! -L $directory ]] || die "Refusing symlinked deployment directory: $directory"
  done
  [[ ! -e /opt/helltube/app || -f /etc/helltube/bootstrap-managed ]] || die '/opt/helltube/app exists but is not managed by this bootstrap.'
  install -d -o root -g root -m 755 /opt/helltube
  install -d -o root -g root -m 700 /etc/helltube /etc/helltube/.secrets
  local secrets=/etc/helltube/.secrets
  [[ ! -L $secrets/cloudflare.ini ]] || die 'Refusing a symlinked credential file.'
  reuse=no
  if [[ -f $secrets/cloudflare.ini ]]; then
    chmod 600 "$secrets/cloudflare.ini"
    chown root:root "$secrets/cloudflare.ini"
    prompt reuse 'Reuse the existing Cloudflare credentials? [yes/no]: '
    [[ $reuse == yes || $reuse == no ]] || die 'Answer yes or no.'
  fi
  if [[ $reuse == no ]]; then
    printf 'Prefer a scoped API token: Zone:DNS:Edit and Zone:Zone:Read for this zone only.\n' >&3
    prompt kind 'Cloudflare credential type [token/key] (key means Global API Key): '
    [[ $kind == token || $kind == key ]] || die 'Choose token or key.'
    cloudflare_email=''
    if [[ $kind == key ]]; then
      prompt cloudflare_email 'Cloudflare account email (for Global API Key): '
    fi
    prompt_secret credential 'Cloudflare API credential (hidden): '
    write_cloudflare_credentials "$secrets/cloudflare.ini" "$kind" "$credential" "$cloudflare_email"
    unset credential
  fi

  local YOUTUBE_COOKIES_ENABLED=no
  configure_youtube_cookies "$secrets/youtube-cookies.txt"

  WORK_DIR=$(mktemp -d /opt/helltube/.bootstrap.XXXXXX)
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  export DEBIAN_FRONTEND=noninteractive
  apt-get update
  if ! apt-cache show python3-certbot-dns-cloudflare >/dev/null 2>&1; then
    apt-get install -y --no-install-recommends software-properties-common
    add-apt-repository --yes universe
    apt-get update
  fi
  apt-get install -y --no-install-recommends ca-certificates curl xz-utils openssl \
    git rsync ffmpeg python3 python3-venv nginx certbot python3-certbot-dns-cloudflare util-linux passwd
  local YOUTUBE_VPN_ENABLED=no
  configure_youtube_vpn "$secrets/youtube-wireguard.conf" "$source_dir/scripts/wireguard.py"
  if [[ $YOUTUBE_VPN_ENABLED == yes ]]; then
    apt-get install -y --no-install-recommends wireguard-tools iproute2 nftables tinyproxy-bin
  fi
  install_node
  "$NODE_BIN" --input-type=module -e 'import "node:sqlite"'
  install -d -o root -g root -m 755 /usr/local/lib/helltube
  install -o root -g root -m 755 "$source_dir/scripts/update-helltube.py" /usr/local/lib/helltube/update-helltube.py
  [[ ! -L /etc/helltube/update.json ]] || die 'Refusing a symlinked updater config.'
  render_update_config "$NODE_BIN" "$NPM_BIN" > "$WORK_DIR/update.json"
  install -o root -g root -m 600 "$WORK_DIR/update.json" /etc/helltube/update.json
  if [[ ! -x /opt/helltube/tools/bin/yt-dlp ]]; then
    (
      umask 022
      python3 -m venv /opt/helltube/tools
      /opt/helltube/tools/bin/pip install --disable-pip-version-check 'yt-dlp[default]'
    )
  fi
  /opt/helltube/tools/bin/yt-dlp --version
  ffmpeg -hide_banner -encoders > "$WORK_DIR/encoders"
  grep -q 'libx264' "$WORK_DIR/encoders" || die 'FFmpeg lacks libx264.'
  grep -qE '[[:space:]]aac[[:space:]]' "$WORK_DIR/encoders" || die 'FFmpeg lacks AAC.'

  certbot certonly --non-interactive --agree-tos --email "$email" \
    --dns-cloudflare --dns-cloudflare-credentials "$secrets/cloudflare.ini" \
    --dns-cloudflare-propagation-seconds 60 --preferred-challenges dns-01 \
    --cert-name helltube --domain "$hostname" --keep-until-expiring
  install -d -m 755 /etc/letsencrypt/renewal-hooks/deploy
  printf '#!/bin/sh\n/usr/sbin/nginx -t && /usr/bin/systemctl reload nginx\n' > "$WORK_DIR/renew-nginx"
  install -o root -g root -m 755 "$WORK_DIR/renew-nginx" /etc/letsencrypt/renewal-hooks/deploy/helltube-nginx
  systemctl enable --now certbot.timer

  if ! id helltube >/dev/null 2>&1; then
    useradd --system --user-group --home-dir /var/lib/helltube --shell /usr/sbin/nologin helltube
  fi
  [[ $(id -u helltube) != 0 ]] || die 'The helltube account must not be root.'
  [[ $(getent passwd helltube | cut -d: -f6) == /var/lib/helltube ]] || die 'Existing helltube account has an unexpected home directory.'
  install -d -o helltube -g helltube -m 700 /var/lib/helltube
  ensure_build_account
  # Stop before touching code or opening the application's SQLite database.
  if systemctl cat helltube.service >/dev/null 2>&1; then
    systemctl stop helltube.service
  fi
  local vpn_unit
  for vpn_unit in helltube-youtube-proxy.service helltube-vpn.service; do
    if systemctl cat "$vpn_unit" >/dev/null 2>&1; then
      [[ -f /etc/helltube/vpn-managed ]] || die 'A VPN service name is already in use by an unmanaged deployment.'
      systemctl stop "$vpn_unit"
      if [[ $YOUTUBE_VPN_ENABLED == no ]]; then systemctl disable "$vpn_unit"; fi
    fi
  done
  install -d -o helltube -g helltube -m 755 /opt/helltube/app
  touch /etc/helltube/bootstrap-managed
  rsync -a --delete --exclude=.git --exclude=.idea --exclude=.junie --exclude=node_modules \
    --exclude=dist --exclude=data --exclude=test-artifacts --exclude='.env*' \
    --exclude='.dev.vars*' --exclude=.wrangler --exclude=.secrets \
    --exclude=cookies.txt --exclude=youtube-cookies.txt --exclude=youtube-wireguard.conf --exclude='*.conf' "$source_dir/" /opt/helltube/app/
  chown -R helltube:helltube /opt/helltube/app
  chmod -R u+rwX,go+rX /opt/helltube/app
  local source_commit
  source_commit=${HELLTUBE_COMMIT:-$(git -c safe.directory="$source_dir" -C "$source_dir" rev-parse --verify HEAD 2>/dev/null || true)}
  (
    cd /opt/helltube/app
    runuser -u helltube -- env HOME=/var/lib/helltube "$NPM_BIN" ci --include=dev --no-audit --no-fund
    runuser -u helltube -- env HOME=/var/lib/helltube HELLTUBE_COMMIT="$source_commit" "$NPM_BIN" run build
  )
  chown -R root:root /opt/helltube/app
  chmod -R u+rwX,go+rX,go-w /opt/helltube/app

  if [[ $YOUTUBE_VPN_ENABLED == yes ]]; then
    if ! id helltube-proxy >/dev/null 2>&1; then
      useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin helltube-proxy
    fi
    [[ $(id -u helltube-proxy) != 0 ]] || die 'The proxy account must not be root.'
    install -o root -g root -m 755 "$source_dir/scripts/wireguard.py" /usr/local/lib/helltube/wireguard.py
    render_vpn_service > "$WORK_DIR/helltube-vpn.service"
    render_youtube_proxy_service > "$WORK_DIR/helltube-youtube-proxy.service"
    render_youtube_proxy_config > "$WORK_DIR/youtube-proxy.conf"
    install -o root -g root -m 644 "$WORK_DIR/helltube-vpn.service" /etc/systemd/system/helltube-vpn.service
    install -o root -g root -m 644 "$WORK_DIR/helltube-youtube-proxy.service" /etc/systemd/system/helltube-youtube-proxy.service
    install -o root -g root -m 600 "$WORK_DIR/youtube-proxy.conf" /etc/helltube/youtube-proxy.conf
    touch /etc/helltube/vpn-managed
  fi

  local secret_file
  for secret_file in admin-password edge-proxy-secret; do
    [[ ! -L $secrets/$secret_file ]] || die 'Refusing a symlinked application secret.'
    if [[ ! -f $secrets/$secret_file ]]; then
      openssl rand -hex 32 > "$secrets/$secret_file"
    fi
    chmod 600 "$secrets/$secret_file"
    chown root:root "$secrets/$secret_file"
    [[ $(< "$secrets/$secret_file") =~ ^[a-f0-9]{64}$ ]] || die "Invalid saved $secret_file."
  done
  runuser -u helltube -- env DATA_DIR=/var/lib/helltube "$NODE_BIN" \
    /opt/helltube/app/scripts/bootstrap-admin.mjs < "$secrets/admin-password"
  {
    printf 'NODE_ENV=production\nHOST=127.0.0.1\nPORT=3000\nDATA_DIR=/var/lib/helltube\nSECURE_COOKIES=true\n'
    printf 'FFMPEG_PATH=/usr/bin/ffmpeg\nYTDLP_PATH=/opt/helltube/tools/bin/yt-dlp\n'
    printf 'ALLOWED_ORIGINS=%s\n' "${frontend:-https://$hostname}"
    if [[ -n $frontend ]]; then
      printf 'BARE_METAL_ORIGIN=https://%s\nEDGE_PROXY_SECRET=%s\n' "$hostname" "$(< "$secrets/edge-proxy-secret")"
    else
      printf 'BARE_METAL_ORIGIN=\nEDGE_PROXY_SECRET=\n'
    fi
  } > "$WORK_DIR/helltube.env"
  install -o root -g root -m 600 "$WORK_DIR/helltube.env" /etc/helltube/helltube.env
  render_service "$YOUTUBE_COOKIES_ENABLED" "$YOUTUBE_VPN_ENABLED" | sed "s|ExecStart=/usr/local/bin/node |ExecStart=$NODE_BIN |" > "$WORK_DIR/helltube.service"
  install -o root -g root -m 644 "$WORK_DIR/helltube.service" /etc/systemd/system/helltube.service
  systemctl daemon-reload
  if [[ $YOUTUBE_VPN_ENABLED == yes ]]; then
    install_youtube_proxy_apparmor
    systemctl enable --now helltube-vpn.service helltube-youtube-proxy.service
    local vpn_ready=no
    for ((attempt = 0; attempt < 5; attempt++)); do
      if curl --fail --silent --max-time 20 --noproxy '' --proxy http://169.254.77.2:8888 \
        --output /dev/null https://www.youtube.com/robots.txt; then
        vpn_ready=yes
        break
      fi
      sleep 2
    done
    [[ $vpn_ready == yes ]] || die 'YouTube VPN connectivity failed. Check the VPN endpoint, DNS and services; direct fallback is disabled.'
  fi
  systemctl enable --now helltube.service
  local ready=no
  for ((attempt = 0; attempt < 30; attempt++)); do
    if curl --fail --silent http://127.0.0.1:3000/api/health > /dev/null; then
      ready=yes
      break
    fi
    sleep 1
  done
  [[ $ready == yes ]] || die 'Backend health check failed; inspect journalctl -u helltube.'

  render_nginx "$hostname" > "$WORK_DIR/helltube.nginx"
  install -o root -g root -m 644 "$WORK_DIR/helltube.nginx" /etc/nginx/sites-available/helltube
  ln -sfn /etc/nginx/sites-available/helltube /etc/nginx/sites-enabled/helltube
  nginx -t
  systemctl enable --now nginx
  systemctl reload nginx
  curl --fail --silent --show-error --noproxy '*' --resolve "$hostname:443:127.0.0.1" "https://$hostname/api/health" ||
    die 'Local HTTPS health check failed; automatic update settings were not changed.'
  reset_update_state /opt/helltube/update-state
  install_update_units
  printf '\nDeployment ready at https://%s\n' "$hostname"
  printf 'Automatic backend updates: %s (helltube-update.timer); Worker deployment remains separate.\n' "$AUTO_UPDATE_ENABLED"
  printf 'Initial admin password: /etc/helltube/.secrets/admin-password (root only; existing passwords are not reset).\n'
  printf 'Cloudflare credentials: /etc/helltube/.secrets/cloudflare.ini (root only).\n'
  if [[ $YOUTUBE_COOKIES_ENABLED == yes ]]; then
    printf 'YouTube cookies: enabled via systemd credentials; source /etc/helltube/.secrets/youtube-cookies.txt (root only).\n'
  else
    printf 'YouTube cookies: disabled; any stored /etc/helltube/.secrets/youtube-cookies.txt is kept for reuse.\n'
  fi
  printf 'Rerun this bootstrap to reuse, replace expired cookies, or disable YouTube authentication.\n'
  if [[ $YOUTUBE_VPN_ENABLED == yes ]]; then
    printf 'YouTube VPN: enabled for yt-dlp and YouTube FFmpeg; profile /etc/helltube/.secrets/youtube-wireguard.conf (root only).\n'
    printf 'VPN services: helltube-vpn and helltube-youtube-proxy. Web/API/upload networking is unchanged.\n'
  else
    printf 'YouTube VPN: disabled (direct access); any stored profile is kept for reuse.\n'
  fi
  printf 'Verify renewal with: sudo certbot renew --cert-name helltube --dry-run\n'
  if [[ -n $frontend ]]; then
    printf 'Worker deployment remains manual: set BARE_METAL_ORIGIN=https://%s and EDGE_PROXY_SECRET from /etc/helltube/.secrets/edge-proxy-secret.\n' "$hostname"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi
