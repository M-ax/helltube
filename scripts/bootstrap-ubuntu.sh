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
  [[ $1 =~ ^[a-zA-Z0-9_-]{20,256}$ ]]
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
  cat <<'EOF'
[Unit]
Description=Helltube backend
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=helltube
Group=helltube
WorkingDirectory=/opt/helltube/app
EnvironmentFile=/etc/helltube/helltube.env
Environment=PATH=/usr/local/bin:/usr/bin:/bin
Environment=HOME=/var/lib/helltube
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
  install -d -m 755 /opt/helltube/node
  tar -xJf "$WORK_DIR/$archive" --strip-components=1 -C /opt/helltube/node
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
  exec 3<>/dev/tty || die 'An interactive terminal is required; do not pipe this script into bash.'

  local source_dir hostname frontend email consent kind credential cloudflare_email reuse
  source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
  [[ -f $source_dir/package-lock.json && -f $source_dir/server/main.js && -f $source_dir/scripts/bootstrap-admin.mjs ]] ||
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

  for directory in /opt/helltube /etc/helltube /etc/helltube/.secrets /var/lib/helltube; do
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
  install_node
  "$NODE_BIN" --input-type=module -e 'import "node:sqlite"'
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
  # Stop before touching code or opening the application's SQLite database.
  if systemctl cat helltube.service >/dev/null 2>&1; then
    systemctl stop helltube.service
  fi
  install -d -o helltube -g helltube -m 755 /opt/helltube/app
  touch /etc/helltube/bootstrap-managed
  rsync -a --delete --exclude=.git --exclude=.idea --exclude=.junie --exclude=node_modules \
    --exclude=dist --exclude=data --exclude=test-artifacts --exclude='.env*' \
    --exclude='.dev.vars*' --exclude=.wrangler --exclude=.secrets "$source_dir/" /opt/helltube/app/
  chown -R helltube:helltube /opt/helltube/app
  chmod -R u+rwX,go+rX /opt/helltube/app
  (
    cd /opt/helltube/app
    runuser -u helltube -- env HOME=/var/lib/helltube "$NPM_BIN" ci --include=dev --no-audit --no-fund
    runuser -u helltube -- env HOME=/var/lib/helltube "$NPM_BIN" run build
  )
  chown -R root:root /opt/helltube/app
  chmod -R u+rwX,go+rX,go-w /opt/helltube/app

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
  render_service | sed "s|ExecStart=/usr/local/bin/node |ExecStart=$NODE_BIN |" > "$WORK_DIR/helltube.service"
  install -o root -g root -m 644 "$WORK_DIR/helltube.service" /etc/systemd/system/helltube.service
  systemctl daemon-reload
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
  curl --fail --silent --show-error --noproxy '*' --resolve "$hostname:443:127.0.0.1" "https://$hostname/api/health"
  printf '\nDeployment ready at https://%s\n' "$hostname"
  printf 'Initial admin password: /etc/helltube/.secrets/admin-password (root only; existing passwords are not reset).\n'
  printf 'Cloudflare credentials: /etc/helltube/.secrets/cloudflare.ini (root only).\n'
  printf 'Verify renewal with: sudo certbot renew --cert-name helltube --dry-run\n'
  if [[ -n $frontend ]]; then
    printf 'Worker deployment remains manual: set BARE_METAL_ORIGIN=https://%s and EDGE_PROXY_SECRET from /etc/helltube/.secrets/edge-proxy-secret.\n' "$hostname"
  fi
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then
  main "$@"
fi