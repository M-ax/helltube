#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/bootstrap-ubuntu.sh
source "$root/scripts/bootstrap-ubuntu.sh"

command -v systemd-analyze >/dev/null || die 'This check needs Linux systemd-analyze.'
mkdir -p "$root/test-artifacts"
workspace=$(mktemp -d "$root/test-artifacts/bootstrap-units.XXXXXX")
trap 'rm -rf -- "$workspace"' EXIT
render_update_service > "$workspace/helltube-update.service"
render_update_timer > "$workspace/helltube-update.timer"
render_update_path > "$workspace/helltube-update.path"
chmod 644 "$workspace/helltube-update.service" "$workspace/helltube-update.timer" "$workspace/helltube-update.path"
systemd-analyze verify --man=no "$workspace/helltube-update.service" "$workspace/helltube-update.timer" "$workspace/helltube-update.path"
printf 'PASS: systemd parses the rendered update service, timer and path and their dependencies\n'

proxy_binary=${TINYPROXY_TEST_BIN:-/usr/bin/tinyproxy}
[[ -x $proxy_binary && $proxy_binary == /* && $proxy_binary != *'|'* ]] || die 'Set TINYPROXY_TEST_BIN to an absolute Tinyproxy executable path.'
render_vpn_service > "$workspace/helltube-vpn.service"
render_connection_log_socket > "$workspace/helltube-connection-log.socket"
render_connection_log_service > "$workspace/helltube-connection-log.service"
render_youtube_proxy_service | sed "s|ExecStart=/usr/bin/tinyproxy |ExecStart=$proxy_binary |" > "$workspace/helltube-youtube-proxy.service"
chmod 644 "$workspace/helltube-vpn.service" "$workspace/helltube-youtube-proxy.service"
systemd-analyze verify --man=no "$workspace/helltube-vpn.service" "$workspace/helltube-youtube-proxy.service" \
  "$workspace/helltube-connection-log.socket" "$workspace/helltube-connection-log.service"
printf 'PASS: systemd parses the rendered VPN/proxy units and their dependencies\n'
