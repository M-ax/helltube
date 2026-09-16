#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/bootstrap-ubuntu.sh
source "$root/scripts/bootstrap-ubuntu.sh"

assert_contains() {
  [[ $1 == *"$2"* ]] || die "Expected output to contain: $2"
}

for hostname in metal.example.net example.com xn--bcher-kva.example; do
  valid_hostname "$hostname" || die "Rejected valid hostname: $hostname"
done
for hostname in '' localhost '*.example.net' 'https://metal.example.net' 'metal.example.net/path' \
  'metal.example.net:443' '.example.net' 'example.net.' 'a..example.net' '-a.example.net' \
  'a-.example.net' 'a_b.example.net' 'example.net;return 200' $'example.net\nserver'; do
  if valid_hostname "$hostname"; then die "Accepted invalid hostname: $hostname"; fi
done
if valid_hostname "$(printf 'a%.0s' {1..64}).example.net"; then die 'Accepted an oversized DNS label.'; fi
valid_email 'admin+tls@example.net' || die 'Rejected valid email.'
for email in '' 'admin@example' 'admin@example.net;injection' $'admin@example.net\nsetting=x'; do
  if valid_email "$email"; then die 'Accepted invalid email.'; fi
done
valid_credential '0123456789abcdefghijklmnopqrstuv_-AB' || die 'Rejected a valid token.'
for credential in '' short '01234567890123456789#comment' $'01234567890123456789\nkey=value'; do
  if valid_credential "$credential"; then die 'Accepted an invalid credential.'; fi
done
printf 'PASS: input validation rejects configuration injection\n'

nginx=$(render_nginx metal.example.net)
# These are literal nginx variables, not shell variables.
# shellcheck disable=SC2016
for directive in 'server_name metal.example.net;' \
  'ssl_certificate /etc/letsencrypt/live/helltube/fullchain.pem;' \
  'location = /internal { return 404; }' 'location ^~ /internal/ { return 404; }' \
  'proxy_set_header Upgrade $http_upgrade;' 'proxy_set_header Connection $helltube_connection_upgrade;' \
  'proxy_set_header Host $host;' 'proxy_cache off;' 'proxy_buffering off;' \
  'proxy_request_buffering off;' 'access_log off;' 'error_log /dev/null;' 'client_max_body_size 2m;'; do
  assert_contains "$nginx" "$directive"
done
[[ $nginx != *"\$request_uri"* ]] || die 'Query-bearing request URI could leak into logs or redirects.'
if (render_nginx 'example.net; include evil;') >/dev/null 2>&1; then die 'Renderer accepted config injection.'; fi
service=$(render_service)
for directive in 'User=helltube' 'Group=helltube' 'ProtectSystem=strict' 'ProtectHome=true' \
  'NoNewPrivileges=true' 'ReadWritePaths=/var/lib/helltube' 'EnvironmentFile=/etc/helltube/helltube.env'; do
  assert_contains "$service" "$directive"
done
printf 'PASS: nginx and service security/streaming configuration\n'

# Exercise the real credential writer with filesystem operations captured, not root writes.
# These command doubles are called indirectly by write_cloudflare_credentials.
# shellcheck disable=SC2329
credential_case() (
  local kind=$1 expected=$2 output
  # Redirect only the writer's temporary file into the capture stream.
  mktemp() { printf '/dev/stdout\n'; }
  chmod() { [[ $1 == 600 && $2 == /dev/stdout ]] || die 'Wrong credential permissions.'; }
  chown() { [[ $1 == root:root && $2 == /dev/stdout ]] || die 'Wrong credential owner.'; }
  mv() { [[ $* == '-fT /dev/stdout /unused/cloudflare.ini' ]] || die 'Credentials not atomically replaced.'; }
  output=$(write_cloudflare_credentials /unused/cloudflare.ini "$kind" 0123456789abcdefghijklmnop admin@example.net)
  [[ $output == "$expected" ]] || die 'Incorrect Certbot credential format.'
)
credential_case token 'dns_cloudflare_api_token = 0123456789abcdefghijklmnop'
credential_case key $'dns_cloudflare_email = admin@example.net\ndns_cloudflare_api_key = 0123456789abcdefghijklmnop'
if (write_cloudflare_credentials /unused/cloudflare.ini token bad) >/dev/null 2>&1; then
  die 'Invalid credential was written.'
fi
printf 'PASS: token/key formats, root ownership, mode 600 and atomic replacement commands\n'

printf 'All bootstrap shell tests passed. No system packages, services or real credentials were touched.\n'