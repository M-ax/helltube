#!/usr/bin/env bash
set -Eeuo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck source=scripts/bootstrap-ubuntu.sh
source "$root/scripts/bootstrap-ubuntu.sh"

assert_contains() {
  [[ $1 == *"$2"* ]] || die "Expected output to contain: $2"
}

for disabled in "$(render_service)" "$(render_service no)"; do
  [[ $disabled != *LoadCredential=* && $disabled != *YTDLP_COOKIES_FILE=* ]] ||
    die 'Disabled cookies must not configure an optional credential.'
done
enabled=$(render_service yes)
assert_contains "$enabled" 'LoadCredential=youtube-cookies:/etc/helltube/.secrets/youtube-cookies.txt'
assert_contains "$enabled" 'Environment=YTDLP_COOKIES_FILE=%d/youtube-cookies'
[[ $enabled != *'ReadOnlyPaths=/etc/helltube/.secrets'* && $enabled != *'ReadWritePaths=/etc/helltube'* ]] ||
  die 'The service must not gain access to the other root-only secrets.'
if (render_service invalid) >/dev/null 2>&1; then die 'Accepted an invalid cookie setting.'; fi
printf 'PASS: optional cookie credential is rendered only when explicitly enabled\n'

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
for length in 20 256; do
  valid_credential "$(printf '%*s' "$length" '' | tr ' ' a)" || die 'Rejected a valid credential length.'
done
for length in 19 257; do
  if valid_credential "$(printf '%*s' "$length" '' | tr ' ' a)"; then die 'Accepted an invalid credential length.'; fi
done
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
  'proxy_set_header X-Forwarded-For $remote_addr;' 'proxy_set_header X-Real-IP $remote_addr;' \
  'proxy_request_buffering off;' 'access_log /var/log/nginx/helltube-access.log helltube_connection;' \
  'error_log syslog:server=unix:/run/helltube-logging/syslog,tag=helltube_nginx info;' \
  'proxy_set_header X-Helltube-Request-Id $request_id;' \
  'log_format helltube_connection escape=json' '"upstreamStatus":"$upstream_status"' 'client_max_body_size 2m;'; do
  assert_contains "$nginx" "$directive"
done
[[ $nginx != *"\$request_uri"* ]] || die 'Query-bearing request URI could leak into logs or redirects.'
log_format=${nginx#*log_format helltube_connection}
log_format=${log_format%%;*}
for private in '$uri' '$args' '$http_authorization' '$http_cookie' '$http_referer' '$request"'; do
  [[ $log_format != *"$private"* ]] || die "Private field in access logs: $private"
done
if (render_nginx 'example.net; include evil;') >/dev/null 2>&1; then die 'Renderer accepted config injection.'; fi
service=$(render_service)
for directive in 'User=helltube' 'Group=helltube' 'ProtectSystem=strict' 'ProtectHome=true' \
  'NoNewPrivileges=true' 'ReadWritePaths=/var/lib/helltube' 'EnvironmentFile=/etc/helltube/helltube.env' \
  'StandardOutput=journal' 'StandardError=journal' 'SyslogIdentifier=helltube'; do
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

# Keep all fixtures in this checkout and never require root, services or real cookies.
# Command doubles verify ownership and supply prompt input without requiring a terminal.
# shellcheck disable=SC2329
cookie_cases() (
  workspace=$(mktemp -d "$root/test/.bootstrap.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  mkdir -m 700 "$workspace/.secrets"
  destination=$workspace/.secrets/youtube-cookies.txt
  cookie_source="$workspace/export cookies.txt"
  permissions=$workspace/permissions
  : > "$permissions"
  chown() {
    [[ $1 == root:root && $2 == "$destination"* ]] || die 'Wrong cookie owner or target.'
    printf 'chown %s %s\n' "$1" "$2" >> "$permissions"
  }
  chmod() {
    [[ $1 == 600 && $2 == "$destination"* ]] || die 'Wrong cookie mode or target.'
    printf 'chmod %s %s\n' "$1" "$2" >> "$permissions"
    command chmod "$@"
  }
  mv() {
    [[ $1 == -fT && $2 == -- && $3 == "$destination".* && $4 == "$destination" ]] ||
      die 'Cookies not atomically replaced in their private directory.'
    command mv "$@"
  }

  header='# Netscape HTTP Cookie File'
  record=$'.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tsecret-test-marker'
  printf '%s\n%s\n' "$header" "$record" > "$cookie_source"
  valid_youtube_cookies "$cookie_source" || die 'Rejected valid Netscape cookies.'
  import_youtube_cookies "$cookie_source" "$destination"
  cmp -s "$cookie_source" "$destination" || die 'Cookie import changed the file.'
  permission_output=$(< "$permissions")
  assert_contains "$permission_output" "chmod 600 $destination."
  assert_contains "$permission_output" "chown root:root $destination."
  [[ $(< "$cookie_source") == "$header"$'\n'"$record" ]] || die 'Import changed its source.'
  case $(uname -s) in
    MINGW*|MSYS*) printf 'NOTE: Windows cannot verify POSIX ownership/modes; permission commands are asserted.\n' ;;
    *)
      [[ $(stat -c %a "$destination") == 600 ]] || die 'Cookie file is not private.'
      [[ $(stat -c %a "$workspace/.secrets") == 700 ]] || die 'Secret directory is not private.'
      ;;
  esac
  for size in 1048575 1048576 1048577; do
    {
      printf '%s\n%s\n#' "$header" "$record"
      printf '%*s\n' "$((size - ${#header} - ${#record} - 4))" ''
    } > "$workspace/sized.txt"
    [[ $(wc -c < "$workspace/sized.txt") -eq $size ]] || die 'Incorrect cookie size fixture.'
    if (( size < 1048576 )); then
      import_youtube_cookies "$workspace/sized.txt" "$destination"
      cmp -s "$workspace/sized.txt" "$destination" || die 'Below-limit import changed the file.'
      cp -- "$destination" "$workspace/size-saved.txt"
    else
      if output=$(import_youtube_cookies "$workspace/sized.txt" "$destination" 2>&1); then
        die "Imported cookies at or above the credential size limit ($size bytes)."
      fi
      [[ $output == 'Error: Invalid Netscape cookies file; export youtube.com cookies only.' ]] ||
        die 'Oversize import did not return a generic validation error.'
      cmp -s "$workspace/size-saved.txt" "$destination" || die 'Oversize replacement damaged the stored cookies.'
      leftovers=("$destination".*)
      [[ ! -e ${leftovers[0]} ]] || die 'Oversize import left a private temporary file behind.'
    fi
  done
  printf 'PASS: cookie size boundary, oversize rejection, preservation and cleanup\n'
  printf '%s\r\n%s\r\n%s\r\n\r\n' "$header" '# Export youtube.com only' \
    "#HttpOnly_$record" > "$workspace/crlf.txt"
  valid_youtube_cookies "$workspace/crlf.txt" || die 'Rejected CRLF or HttpOnly cookies.'
  import_youtube_cookies "$workspace/crlf.txt" "$destination"
  cmp -s "$workspace/crlf.txt" "$destination" || die 'CRLF import changed the file.'
  printf '%s\n%s\n%s\n' "$header" '# Helltube-User-Agent: Mozilla/5.0 Chrome/153.0.0.0' "$record" > "$workspace/browser.txt"
  import_youtube_cookies "$workspace/browser.txt" "$destination"
  cmp -s "$workspace/browser.txt" "$destination" || die 'Import lost the matching browser user agent.'
  printf '# HTTP Cookie File\nyoutube.com\tFALSE\t/\tFALSE\t\tSID\t\n' > "$workspace/session.txt"
  valid_youtube_cookies "$workspace/session.txt" || die 'Rejected session cookies or an empty value.'
  printf '%s\n#HttpOnly_.www.youtube.com\tTRUE\t/path\tTRUE\t0\tSID\tvalue\n' "$header" > "$workspace/subdomain.txt"
  valid_youtube_cookies "$workspace/subdomain.txt" || die 'Rejected a YouTube subdomain.'

  cp -- "$destination" "$workspace/saved.txt"
  for invalid in '' "$header" "$record" $'{"cookies":[]}' \
    "$header"$'\n# comment only' "$header"$'\n#HttpOnly_broken' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tSID\tvalue\textra' \
    "$header"$'\n.youtube.com\tfalse\t/\tTRUE\t0\tSID\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tyes\t0\tSID\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t-1\tSID\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\tnow\tSID\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\tnot-a-path\tTRUE\t0\tSID\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t0\t\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t0\tbad name\tvalue' \
    "$header"$'\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\rbroken' \
    "$header"$'\n.youtube.com\tFALSE\t/\tTRUE\t0\tSID\tvalue' \
    "$header"$'\nyoutube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue' \
    "$header"$'\n'"$record"$'\n#HttpOnly_' \
    "$header"$'\n'"$record"$'\n#HttpOnly_#broken' \
    "$header"$'\n'"$record"$'\nmalformed-secret-test-marker'; do
    printf '%s\n' "$invalid" > "$workspace/invalid.txt"
    if valid_youtube_cookies "$workspace/invalid.txt"; then die 'Accepted malformed cookie data.'; fi
    if output=$(import_youtube_cookies "$workspace/invalid.txt" "$destination" 2>&1); then
      die 'Imported malformed cookies.'
    fi
    [[ $output != *secret-test-marker* && $output != *value* ]] || die 'Validation leaked cookie contents.'
    cmp -s "$workspace/saved.txt" "$destination" || die 'Invalid replacement damaged the stored cookies.'
    leftovers=("$destination".*)
    [[ ! -e ${leftovers[0]} ]] || die 'Failed import left a private temporary file behind.'
  done
  for domain in .google.com .example.com .youtube.com.evil.test .notyoutube.com \
    .evil-youtube.com ..youtube.com .-bad.youtube.com .youtube.com. \
    ".$(printf 'a%.0s' {1..64}).youtube.com"; do
    printf '%s\n%s\n%s\tTRUE\t/\tTRUE\t0\tSID\tsecret-test-marker\n' \
      "$header" "$record" "$domain" > "$workspace/invalid.txt"
    if valid_youtube_cookies "$workspace/invalid.txt"; then die 'Accepted a non-YouTube or malformed domain.'; fi
  done
  printf '%s\n%s\0\n' "$header" "$record" > "$workspace/invalid.txt"
  if valid_youtube_cookies "$workspace/invalid.txt"; then die 'Accepted binary cookie data.'; fi
  for missing in "$workspace/missing.txt" "$workspace"; do
    if (import_youtube_cookies "$missing" "$destination") >/dev/null 2>&1; then
      die 'Imported a missing or non-regular source.'
    fi
  done
  if (import_youtube_cookies "$cookie_source" "$workspace/.secrets") >/dev/null 2>&1; then
    die 'Accepted a non-regular destination.'
  fi
  if (mv() { return 1; }; import_youtube_cookies "$cookie_source" "$destination") >/dev/null 2>&1; then
    die 'Reported success after a failed atomic rename.'
  fi
  cmp -s "$workspace/saved.txt" "$destination" || die 'Failed rename damaged the stored cookies.'
  leftovers=("$destination".*)
  [[ ! -e ${leftovers[0]} ]] || die 'Failed rename left a temporary file behind.'
  if ln -s "$cookie_source" "$workspace/source-link" 2>/dev/null && [[ -L $workspace/source-link ]]; then
    if (import_youtube_cookies "$workspace/source-link" "$destination") >/dev/null 2>&1; then
      die 'Accepted a symlinked source.'
    fi
    ln -s "$destination" "$workspace/destination-link"
    if (import_youtube_cookies "$cookie_source" "$workspace/destination-link") >/dev/null 2>&1; then
      die 'Accepted a symlinked destination.'
    fi
    ln -s "$workspace/missing.txt" "$workspace/dangling-link"
    if (import_youtube_cookies "$cookie_source" "$workspace/dangling-link") >/dev/null 2>&1; then
      die 'Accepted a dangling symlink destination.'
    fi
    cmp -s "$workspace/saved.txt" "$destination" || die 'Symlink rejection changed the stored cookies.'
  else
    case $(uname -s) in
      MINGW*|MSYS*) printf 'NOTE: Native symlinks unavailable; symlink rejection requires a Unix check.\n' ;;
      *) die 'Cannot create symlink test fixtures.' ;;
    esac
  fi
  printf 'PASS: cookie validation, private imports, replacement preservation and failure cleanup\n'

  prompt() {
    local value
    read -r value <&4 || die 'Test input closed.'
    printf -v "$1" '%s' "$value"
  }
  exec 3> "$workspace/prompts"
  for choice in '' skip; do
    printf '%s\n' "$choice" > "$workspace/input"
    exec 4< "$workspace/input"
    YOUTUBE_COOKIES_ENABLED=yes
    configure_youtube_cookies "$workspace/new-cookies.txt"
    [[ $YOUTUBE_COOKIES_ENABLED == no && ! -e $workspace/new-cookies.txt ]] || die 'Fresh skip enabled cookies.'
  done
  for choice in disable '' reuse replace; do
    if [[ $choice == replace ]]; then
      printf 'replace\n%s\n' "$cookie_source" > "$workspace/input"
    else
      printf '%s\n' "$choice" > "$workspace/input"
    fi
    exec 4< "$workspace/input"
    YOUTUBE_COOKIES_ENABLED=yes
    configure_youtube_cookies "$destination"
    case $choice in
      disable|'')
        [[ $YOUTUBE_COOKIES_ENABLED == no ]] || die 'Disabled rerun enabled cookies.'
        cmp -s "$workspace/saved.txt" "$destination" || die 'Disabling deleted or changed stored cookies.'
        disabled=$(render_service "$YOUTUBE_COOKIES_ENABLED")
        [[ $disabled != *LoadCredential=* && $disabled != *YTDLP_COOKIES_FILE=* ]] || die 'Disabled rerun renders credentials.'
        ;;
      reuse) [[ $YOUTUBE_COOKIES_ENABLED == yes ]] || die 'Reuse did not enable cookies.' ;;
      replace)
        [[ $YOUTUBE_COOKIES_ENABLED == yes ]] || die 'Replacement did not enable cookies.'
        cmp -s "$cookie_source" "$destination" || die 'Replacement did not import the new cookies.'
        ;;
    esac
  done
  for input in $'replace\n'"$workspace/invalid.txt" unexpected $'replace\n'; do
    printf '%s\n' "$input" > "$workspace/input"
    exec 4< "$workspace/input"
    if (configure_youtube_cookies "$destination") >/dev/null 2>&1; then die 'Accepted an invalid rerun choice/import.'; fi
    cmp -s "$cookie_source" "$destination" || die 'Invalid rerun changed stored cookies.'
  done
  rm -- "$destination"
  printf '%s\n' "$cookie_source" > "$workspace/input"
  exec 4< "$workspace/input"
  configure_youtube_cookies "$destination"
  [[ $YOUTUBE_COOKIES_ENABLED == yes ]] || die 'Fresh import did not enable cookies.'
  cmp -s "$cookie_source" "$destination" || die 'Fresh import did not store the cookies.'
  printf 'PASS: fresh skip/import and rerun reuse/replace/disable choices\n'
)
cookie_cases

vpn=$(render_service no yes)
assert_contains "$vpn" 'Environment=YOUTUBE_PROXY=http://169.254.77.2:8888'
assert_contains "$vpn" 'Wants=helltube-youtube-proxy.service'
assert_contains "$vpn" 'After=helltube-youtube-proxy.service'
[[ $(render_service yes no) != *YOUTUBE_PROXY=* ]] || die 'Disabled VPN configured a proxy.'
[[ $vpn != *'LoadCredential=wireguard'* && $vpn != *'CAP_NET_ADMIN'* ]] || die 'Backend received VPN secrets or privileges.'
if (render_service no invalid) >/dev/null 2>&1; then die 'Accepted an invalid VPN setting.'; fi
vpn_unit=$(render_vpn_service)
assert_contains "$vpn_unit" 'ExecStart=/usr/bin/python3 /usr/local/lib/helltube/wireguard.py up'
assert_contains "$vpn_unit" 'ExecStop=/usr/bin/python3 /usr/local/lib/helltube/wireguard.py down'
[[ $vpn_unit != *'/opt/helltube/app/'* ]] || die 'Root VPN helper must not execute auto-updated checkout code.'
proxy_unit=$(render_youtube_proxy_service)
for directive in 'User=helltube-proxy' 'NetworkNamespacePath=/run/netns/helltube-youtube' \
  'BindsTo=helltube-vpn.service' 'After=helltube-vpn.service' 'NoNewPrivileges=true' \
  'BindReadOnlyPaths=/run/helltube-vpn/resolv.conf:/etc/resolv.conf' \
  'BindReadOnlyPaths=/run/helltube-vpn/nsswitch.conf:/etc/nsswitch.conf' \
  'BindReadOnlyPaths=/run/helltube-logging/syslog:/dev/log' 'Requires=helltube-connection-log.socket' \
  'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX' \
  'LoadCredential=proxy-config:/etc/helltube/youtube-proxy.conf' \
  'RuntimeDirectory=helltube-youtube-proxy' 'RuntimeDirectoryMode=0700' \
  'CapabilityBoundingSet=' 'ProtectSystem=strict' 'ProtectHome=true' \
  'PrivateTmp=true' 'PrivateDevices=true' 'UMask=0077' 'StandardOutput=null' 'StandardError=null' \
  'ExecStart=/usr/bin/tinyproxy -d -c %d/proxy-config'; do
  assert_contains "$proxy_unit" "$directive"
done
proxy_config=$(render_youtube_proxy_config)
for directive in 'Listen 169.254.77.2' 'Port 8888' 'Allow 169.254.77.1' 'ConnectPort 443' \
  'Syslog On' 'LogLevel Connect' 'PidFile "/run/helltube-youtube-proxy/tinyproxy.pid"'; do
  assert_contains "$proxy_config" "$directive"
done
printf 'PASS: VPN service isolation, explicit proxy and no backend privileges\n'

# Owner operations are doubled only for unprivileged runs; root exercises native ownership.
# All policy/kernel paths and external commands stay inside the fixture boundary.
# shellcheck disable=SC2329
apparmor_cases() (
  workspace=$(mktemp -d "$root/test-artifacts/bootstrap-apparmor.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  local rootfs=$workspace/rootfs profile local_file addon expected_include expected_rules
  local parser_status=0 parser_available=no install_parser=yes apt_status=0 unsafe_owner='' details
  profile=$rootfs/etc/apparmor.d/tinyproxy
  local_file=$rootfs/etc/apparmor.d/local/tinyproxy
  addon=$rootfs/etc/apparmor.d/local/helltube-youtube-proxy
  expected_include='include if exists <local/helltube-youtube-proxy>'
  expected_rules=$'/run/credentials/helltube-youtube-proxy.service/proxy-config r,\n/run/helltube-youtube-proxy/tinyproxy.pid rw,\n/run/helltube-logging/syslog w,'
  stat() {
    details=$(command stat "$@") || return
    if [[ $EUID != 0 && $1 == -c && $2 == '%u:%a:%h' ]]; then
      if [[ ${!#} == "$unsafe_owner" ]]; then
        details="65534:${details#*:}"
      elif [[ $details == "$EUID":* ]]; then
        details="0:${details#*:}"
      fi
    fi
    printf '%s\n' "$details"
  }
  chown() {
    [[ $1 == root:root && $2 == "$rootfs"/* ]] || die 'Unexpected AppArmor ownership change.'
    if [[ $EUID == 0 ]]; then command chown "$@"; fi
  }
  command() {
    if [[ $* == '-v apparmor_parser' ]]; then
      [[ $parser_available == yes ]]
    else
      builtin command "$@"
    fi
  }
  apt-get() {
    [[ $* == 'install -y --no-install-recommends apparmor' ]] || die 'Unexpected AppArmor package install.'
    printf 'install\n' >> "$workspace/actions"
    (( apt_status == 0 )) || return "$apt_status"
    parser_available=$install_parser
  }
  apparmor_parser() {
    [[ $# == 2 && $1 == -r && $2 == "$profile" ]] || die 'Wrong AppArmor reload command.'
    [[ $(< "$addon") == "$expected_rules" ]] || die 'Reload ran before the exact addon was installed.'
    grep -qF "$expected_include" "$local_file" || die 'Reload ran before the local include was installed.'
    printf 'reload\n' >> "$workspace/actions"
    if (( parser_status != 0 )); then printf 'Permission denied loading policy\n' >&2; fi
    return "$parser_status"
  }
  mkdir -p "$rootfs/sys/module/apparmor/parameters" "$rootfs/sys/kernel/security/apparmor"
  printf 'Y\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
  : > "$workspace/actions"
  install_youtube_proxy_apparmor "$rootfs"
  [[ ! -e $rootfs/etc && ! -s $workspace/actions ]] || die 'No-profile run changed policy or installed packages.'

  mkdir -p "${profile%/*}"
  install_youtube_proxy_apparmor "$rootfs"
  [[ ! -e ${profile%/*}/local && ! -s $workspace/actions ]] || die 'Missing Tinyproxy profile must leave shared policy alone.'
  parser_available=yes
  printf 'profile tinyproxy /usr/bin/tinyproxy {\n  include if exists <local/tinyproxy>\n}\n' > "$profile"
  cp "$profile" "$workspace/original-profile"
  install_youtube_proxy_apparmor "$rootfs"
  printf '%s\n' "$expected_rules" > "$workspace/expected-addon"
  cmp -s "$workspace/expected-addon" "$addon" || die 'Addon must contain exactly the scoped credential, PID and logging rules.'
  [[ $(< "$local_file") == "$expected_include" ]] || die 'Missing local file was not created with the include.'
  [[ $(command stat -c %a "$addon") == 644 && $(command stat -c %a "$local_file") == 644 ]] || die 'Wrong generated AppArmor file modes.'
  if [[ $EUID == 0 ]]; then
    [[ $(command stat -c '%u:%g' "$addon") == 0:0 && $(command stat -c '%u:%g' "$local_file") == 0:0 ]] || die 'Generated AppArmor files are not root-owned.'
  fi
  [[ $(< "$workspace/actions") == reload ]] || die 'Existing parser should reload without package installation.'
  if [[ -n ${APPARMOR_TEST_PARSER:-} ]]; then
    [[ $APPARMOR_TEST_PARSER == /* && -x $APPARMOR_TEST_PARSER ]] || die 'APPARMOR_TEST_PARSER must be an absolute parser executable path.'
    "$APPARMOR_TEST_PARSER" --skip-kernel-load --skip-cache --base "${profile%/*}" "$profile"
    printf 'PASS: real AppArmor parser compiles the fixture without loading kernel policy or writing cache\n'
  fi
  printf '/unexpected/broad/** rw,\n' > "$addon"
  install_youtube_proxy_apparmor "$rootfs"
  cmp -s "$workspace/expected-addon" "$addon" || die 'Managed addon was not restored to exactly the two rules.'

  for custom in $'# custom policy\n/custom/path r,\n' $'# custom policy\n/custom/path r,' ''; do
    printf '%s' "$custom" > "$local_file"
    chmod 600 "$local_file"
    printf '%s' "$custom" > "$workspace/expected-local"
    if [[ -n $custom && $custom != *$'\n' ]]; then printf '\n' >> "$workspace/expected-local"; fi
    printf '%s\n' "$expected_include" >> "$workspace/expected-local"
    install_youtube_proxy_apparmor "$rootfs"
    install_youtube_proxy_apparmor "$rootfs"
    cmp -s "$workspace/expected-local" "$local_file" || die 'Rerun damaged custom content, trailing LF or duplicated the include.'
    [[ $(command stat -c %a "$local_file") == 600 ]] || die 'Existing local policy permissions were weakened.'
  done
  printf '  %s # administrator include' "$expected_include" > "$local_file"
  cp "$local_file" "$workspace/expected-local"
  install_youtube_proxy_apparmor "$rootfs"
  cmp -s "$workspace/expected-local" "$local_file" || die 'Existing include with whitespace/comment was duplicated or modified.'
  cmp -s "$workspace/original-profile" "$profile" || die 'Distro profile was modified.'
  printf 'PASS: exact AppArmor addon, native file modes, preserved custom content and idempotent includes\n'

  for state in disabled unavailable missing-parameter; do
    : > "$workspace/actions"
    parser_available=no
    printf 'N\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
    if [[ $state == unavailable ]]; then
      printf 'Y\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
      rmdir "$rootfs/sys/kernel/security/apparmor"
    elif [[ $state == missing-parameter ]]; then
      rm "$rootfs/sys/module/apparmor/parameters/enabled"
    fi
    install_youtube_proxy_apparmor "$rootfs" > "$workspace/output"
    [[ ! -s $workspace/actions ]] || die 'Disabled/unavailable kernel caused reload or package installation.'
  done
  mkdir "$rootfs/sys/kernel/security/apparmor"
  : > "$workspace/actions"
  install_youtube_proxy_apparmor "$rootfs"
  [[ $(< "$workspace/actions") == $'install\nreload' ]] || die 'Visible kernel interface without module parameter must still reload.'
  printf 'Y\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
  parser_status=13
  if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die 'AppArmor reload failure was ignored.'; fi
  assert_contains "$(< "$workspace/output")" 'AppArmor'
  assert_contains "$(< "$workspace/output")" 'LXC'
  assert_contains "$(< "$workspace/output")" 'Permission denied loading policy'
  parser_status=0
  parser_available=no
  install_parser=no
  if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die 'Missing parser after installation was ignored.'; fi
  assert_contains "$(< "$workspace/output")" 'apparmor_parser'
  apt_status=100
  if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die 'Failed parser package installation was ignored.'; fi
  assert_contains "$(< "$workspace/output")" 'Cannot install apparmor_parser'
  parser_available=yes
  printf 'unexpected\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
  : > "$workspace/actions"
  if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die 'Unknown kernel state was silently treated as disabled.'; fi
  [[ ! -s $workspace/actions ]] || die 'Unknown kernel state caused a reload.'
  printf 'Y\n' > "$rootfs/sys/module/apparmor/parameters/enabled"
  printf 'PASS: actual kernel availability gates reload; enabled policy/parser failures abort clearly\n'

  for target in "$addon" "$local_file" "$profile" "${local_file%/*}" "${profile%/*}" "$rootfs/etc" "$rootfs"; do
    mv "$target" "$target.saved"
    for kind in symlink dangling directory fifo; do
      case $kind in
        symlink) ln -s "$target.saved" "$target" ;;
        dangling) ln -s "$workspace/missing" "$target" ;;
        directory) [[ -f $target.saved ]] || continue; mkdir "$target" ;;
        fifo) [[ -f $target.saved ]] || continue; mkfifo "$target" ;;
      esac
      : > "$workspace/actions"
      if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then
        # Missing profiles under dangling parents require no writes, but must never create through them.
        [[ $kind == dangling && -d $target.saved ]] || die "Accepted unsafe AppArmor destination: $target ($kind)"
      fi
      [[ ! -s $workspace/actions && ! -e $workspace/missing ]] || die 'Unsafe path caused an external action or followed a dangling link.'
      if [[ $kind == directory ]]; then rmdir "$target"; else rm "$target"; fi
    done
    mv "$target.saved" "$target"
    for writable in g o; do
      chmod "$writable+w" "$target"
      if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die "Accepted writable AppArmor path: $target"; fi
      chmod "$writable-w" "$target"
    done
    unsafe_owner=$target
    if [[ $EUID == 0 ]]; then command chown 65534 "$target"; fi
    if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die "Accepted untrusted AppArmor owner: $target"; fi
    if [[ $EUID == 0 ]]; then command chown root "$target"; fi
    unsafe_owner=''
  done
  ln "$local_file" "$workspace/hardlink"
  if (install_youtube_proxy_apparmor "$rootfs") >/dev/null 2>&1; then die 'Accepted a hardlinked local policy.'; fi
  rm "$workspace/hardlink"
  printf 'profile tinyproxy /usr/bin/tinyproxy {}\n' > "$profile"
  if (install_youtube_proxy_apparmor "$rootfs") > "$workspace/output" 2>&1; then die 'Accepted a distro profile without the local include hook.'; fi
  printf 'PASS: AppArmor rejects unsafe destinations, ancestors, ownership and missing local hooks\n'
)
mkdir -p "$root/test-artifacts"
apparmor_cases

vpn_prompt_cases() (
  workspace=$(mktemp -d "$root/test/.bootstrap-vpn.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  destination=$workspace/youtube-wireguard.conf
  printf 'saved-profile' > "$destination"
  exec 3> "$workspace/prompts"
  prompt() { local value; read -r value <&4 || die 'Test input closed.'; printf -v "$1" '%s' "$value"; }
  python3() {
    [[ $1 == /helper && $2 == import && $4 == "$destination" ]] || die 'Wrong import interface.'
    [[ $3 == "$destination" || $3 == /replacement.conf ]] || die 'Wrong VPN source.'
  }
  for choice in '' reuse replace disable; do
    printf '%s\n/replacement.conf\n' "$choice" > "$workspace/input"
    exec 4< "$workspace/input"
    configure_youtube_vpn "$destination" /helper
    if [[ $choice == disable ]]; then
      [[ $YOUTUBE_VPN_ENABLED == no ]] || die 'Explicit disable ignored.'
    else
      [[ $YOUTUBE_VPN_ENABLED == yes ]] || die 'Saved VPN must default to reuse, never silently disable.'
    fi
    [[ $(< "$destination") == saved-profile ]] || die 'Prompt damaged the saved VPN profile.'
  done
  printf '\n' > "$workspace/input"
  exec 4< "$workspace/input"
  configure_youtube_vpn "$workspace/missing.conf" /helper
  [[ $YOUTUBE_VPN_ENABLED == no ]] || die 'Fresh blank enabled VPN.'
  printf 'unexpected\n' > "$workspace/input"
  exec 4< "$workspace/input"
  if (configure_youtube_vpn "$destination" /helper) >/dev/null 2>&1; then die 'Accepted an invalid VPN choice.'; fi
)
vpn_prompt_cases
printf 'PASS: VPN reruns default to reuse and require explicit disabling\n'

update_unit=$(render_update_service)
for directive in 'Type=oneshot' 'User=root' 'Wants=network-online.target' 'After=network-online.target' \
  'ExecStart=/usr/bin/python3 /usr/local/lib/helltube/update-helltube.py' 'TimeoutStartSec=30min' 'UMask=0077'; do
  assert_contains "$update_unit" "$directive"
done
for forbidden in 'Restart=' 'Environment' 'LoadCredential=' '/opt/helltube/app' 'HOME=' \
  'ProtectSystem=' 'ReadWritePaths=' 'PrivateUsers=' 'NoNewPrivileges=' 'CapabilityBoundingSet='; do
  [[ $update_unit != *"$forbidden"* ]] || die "Updater must not contain: $forbidden"
done
update_timer=$(render_update_timer)
for directive in 'OnBootSec=2min' 'OnUnitInactiveSec=5min' 'RandomizedDelaySec=30s' \
  'Unit=helltube-update.service' 'WantedBy=timers.target'; do
  assert_contains "$update_timer" "$directive"
done
[[ $update_timer != *'OnUnitActiveSec='* && $update_timer != *'ExecStart='* ]] || die 'Timer must schedule after completion, not execute checkout code.'
printf 'PASS: updater runs the pinned root helper without secrets; timer schedules after completion\n'

update_path=$(render_update_path)
assert_contains "$update_path" 'PathChanged=/var/lib/helltube/worker-deployment.json'
assert_contains "$update_path" 'Unit=helltube-update.service'
assert_contains "$update_path" 'WantedBy=multi-user.target'

# shellcheck disable=SC2329
update_prompt_cases() (
  workspace=$(mktemp -d "$root/test/.bootstrap-update.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  exec 3> "$workspace/prompts"
  prompt() {
    local value
    printf '%s\n' "$2" >&3
    read -r value <&4 || die 'Test input closed.'
    printf -v "$1" '%s' "$value"
  }
  systemctl() {
    [[ $* == 'is-enabled --quiet helltube-update.timer' ]] || die 'Prompt must only inspect the timer enabled state.'
    return "$timer_status"
  }
  for timer_status in 0 1 4; do
    for choice in '' yes no; do
      printf '%s\n' "$choice" > "$workspace/input"
      exec 4< "$workspace/input"
      AUTO_UPDATE_ENABLED=unexpected
      configure_auto_update
      expected=$choice
      if [[ -z $expected ]]; then
        expected=no
        if [[ $timer_status == 0 ]]; then expected=yes; fi
      fi
      [[ $AUTO_UPDATE_ENABLED == "$expected" ]] || die 'Auto-update choice did not preserve or override the timer state.'
    done
  done
  for choice in maybe y disable; do
    printf '%s\n' "$choice" > "$workspace/input"
    exec 4< "$workspace/input"
    if (configure_auto_update) >/dev/null 2>&1; then die 'Accepted an invalid auto-update choice.'; fi
  done
  for warning in 'https://github.com/M-ax/helltube.git' 'main' 'trust' 'npm dependencies' 'brief restarts' 'Worker' 'separate' 'blank' 'no'; do
    assert_contains "$(< "$workspace/prompts")" "$warning"
  done
)
update_prompt_cases
printf 'PASS: auto-update fresh/disabled defaults stay off, enabled reruns preserve state, explicit yes/no override\n'

config=$(render_update_config $'/opt/Node "quoted"\\path\nnode' '/opt/npm $(touch should-not-run);tool')
python3 - "$config" <<'PY'
import json
import sys

assert json.loads(sys.argv[1]) == {
    "node": '/opt/Node "quoted"\\path\nnode',
    "npm": '/opt/npm $(touch should-not-run);tool',
}
PY
printf 'PASS: updater JSON contains only node/npm and safely quotes shell metacharacters\n'

# shellcheck disable=SC2329
build_account_cases() (
  local exists=no build_uid=200 groups=helltube-build home=/nonexistent shell=/usr/sbin/nologin created=no
  id() {
    case "$*" in
      helltube-build) [[ $exists == yes ]] ;;
      '-u helltube-build') printf '%s\n' "$build_uid" ;;
      '-u helltube') printf '1001\n' ;;
      '-Gn helltube-build') printf '%s\n' "$groups" ;;
      *) die 'Unexpected account lookup.' ;;
    esac
  }
  getent() {
    [[ $* == 'passwd helltube-build' ]] || die 'Unexpected account database lookup.'
    printf 'helltube-build:x:%s:200::%s:%s\n' "$build_uid" "$home" "$shell"
  }
  useradd() {
    [[ $* == '--system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin helltube-build' ]] || die 'Unsafe build account creation.'
    exists=yes
    created=yes
  }
  ensure_build_account
  [[ $created == yes ]] || die 'Missing build account was not created.'
  created=no
  ensure_build_account
  [[ $created == no ]] || die 'Existing build account was recreated.'
  for invalid in root runtime groups home shell; do
    build_uid=200 groups=helltube-build home=/nonexistent shell=/usr/sbin/nologin
    case $invalid in
      root) build_uid=0 ;;
      runtime) build_uid=1001 ;;
      groups) groups='helltube-build helltube sudo' ;;
      home) home=/var/lib/helltube ;;
      shell) shell=/bin/bash ;;
    esac
    if (ensure_build_account) >/dev/null 2>&1; then die "Accepted an unsafe build account: $invalid"; fi
  done
)
build_account_cases
printf 'PASS: build account is separate, unprivileged, nologin and has no supplementary groups\n'

deployment_lock_cases() (
  workspace=$(mktemp -d "$root/test/.bootstrap-lock.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  acquire_deployment_lock "$workspace/deploy.lock"
  if (exec 9>&-; acquire_deployment_lock "$workspace/deploy.lock"; touch "$workspace/changed") >/dev/null 2>&1; then
    die 'Concurrent deployment acquired the lock.'
  fi
  [[ ! -e $workspace/changed ]] || die 'Blocked deployment changed settings.'
  exec 9>&-
  acquire_deployment_lock "$workspace/deploy.lock"
  exec 9>&-
  if ln -s "$workspace/deploy.lock" "$workspace/link" 2>/dev/null && [[ -L $workspace/link ]]; then
    if (acquire_deployment_lock "$workspace/link") >/dev/null 2>&1; then die 'Accepted a symlinked deployment lock.'; fi
  fi
  if (acquire_deployment_lock "$workspace") >/dev/null 2>&1; then die 'Accepted a non-regular deployment lock.'; fi
)
deployment_lock_cases
printf 'PASS: deployment lock rejects overlap before changes and stays held until explicitly closed\n'

update_state_cases() (
  workspace=$(mktemp -d "$root/test/.bootstrap-state.XXXXXX")
  trap 'rm -rf -- "$workspace"' EXIT
  reset_update_state "$workspace/missing"
  [[ ! -e $workspace/missing ]] || die 'Bootstrap must not create updater state.'
  mkdir "$workspace/state" "$workspace/previous-app"
  printf 'keep' > "$workspace/state/other.json"
  printf 'keep' > "$workspace/previous-app/file"
  touch "$workspace/state/pending.json" "$workspace/state/deployed.json"
  reset_update_state "$workspace/state"
  [[ ! -e $workspace/state/pending.json && ! -e $workspace/state/deployed.json ]] || die 'Manual deployment did not reset updater records.'
  [[ $(< "$workspace/state/other.json") == keep && $(< "$workspace/previous-app/file") == keep ]] || die 'State reset removed unrelated files or previous-app.'
  mkdir "$workspace/state/deployed.json"
  reset_update_state "$workspace/state"
  [[ -d $workspace/state/deployed.json ]] || die 'State reset removed a non-regular record.'
  if ln -s "$workspace/state/other.json" "$workspace/state/pending.json" 2>/dev/null && [[ -L $workspace/state/pending.json ]]; then
    reset_update_state "$workspace/state"
    [[ -L $workspace/state/pending.json && $(< "$workspace/state/other.json") == keep ]] || die 'State reset followed or deleted a symlink.'
    ln -s "$workspace/state" "$workspace/state-link"
    if (reset_update_state "$workspace/state-link") >/dev/null 2>&1; then die 'Accepted a symlinked state directory.'; fi
    ln -s "$workspace/missing" "$workspace/dangling"
    if (reset_update_state "$workspace/dangling") >/dev/null 2>&1; then die 'Accepted a dangling state symlink.'; fi
  fi
  if (reset_update_state "$workspace/state/other.json") >/dev/null 2>&1; then die 'Accepted a non-directory state path.'; fi
)
update_state_cases
printf 'PASS: manual reset deletes only regular updater records, never symlinks or previous-app\n'

# shellcheck disable=SC2329
update_install_cases() (
  WORK_DIR=$(mktemp -d "$root/test/.bootstrap-units.XXXXXX")
  trap 'rm -rf -- "$WORK_DIR"' EXIT
  install() {
    [[ $# == 8 && $1 == -o && $2 == root && $3 == -g && $4 == root && $5 == -m && $6 == 644 ]] || die 'Wrong updater unit permissions.'
    [[ $7 == "$WORK_DIR/helltube-update.service" || $7 == "$WORK_DIR/helltube-update.timer" || $7 == "$WORK_DIR/helltube-update.path" ]] || die 'Unexpected updater unit source.'
    [[ $8 == "/etc/systemd/system/${7##*/}" && -s $7 ]] || die 'Wrong updater unit destination.'
    printf 'install %s\n' "${7##*/}" >> "$WORK_DIR/actions"
  }
  local failed_check=''
  systemctl() {
    printf '%s\n' "$*" >> "$WORK_DIR/actions"
    [[ $* != "$failed_check" ]]
  }
  for AUTO_UPDATE_ENABLED in yes no; do
    : > "$WORK_DIR/actions"
    install_update_units
    expected=$'install helltube-update.service\ninstall helltube-update.timer\ninstall helltube-update.path\ndaemon-reload\n'
    if [[ $AUTO_UPDATE_ENABLED == yes ]]; then
      expected+=$'enable --now helltube-update.timer helltube-update.path\nis-enabled --quiet helltube-update.timer\nis-active --quiet helltube-update.timer\nis-enabled --quiet helltube-update.path\nis-active --quiet helltube-update.path'
    else
      expected+='disable --now helltube-update.timer helltube-update.path'
    fi
    [[ $(< "$WORK_DIR/actions") == "$expected" ]] || die 'Updater units must install/reload before changing the timer/path state.'
  done
  AUTO_UPDATE_ENABLED=yes
  for failed_check in 'is-enabled --quiet helltube-update.timer' 'is-active --quiet helltube-update.timer' \
    'is-enabled --quiet helltube-update.path' 'is-active --quiet helltube-update.path'; do
    if (install_update_units) >/dev/null 2>&1; then die "Reported success despite failed $failed_check."; fi
  done
  AUTO_UPDATE_ENABLED=invalid
  : > "$WORK_DIR/actions"
  if (install_update_units) >/dev/null 2>&1; then die 'Accepted an invalid timer setting.'; fi
  [[ ! -s $WORK_DIR/actions ]] || die 'Invalid timer setting changed units.'
)
update_install_cases
printf 'PASS: unit installation enables/disables the timer and path together; never starts or stops the updater service\n'
printf 'PASS: enabled installations require each timer/path unit to be both enabled and active\n'

python3 - "$(declare -f main)" <<'PY'
import sys

main = sys.argv[1]
assert main.index("acquire_deployment_lock") < main.index("configure_auto_update") < main.index("install -d")
health = main.index('"https://$hostname/api/health"')
assert health < main.index("reset_update_state /opt/helltube/update-state") < main.index("install_update_units")
assert main.count("install_update_units") == 1
assert not any(line.lstrip().startswith("systemctl ") and "helltube-update" in line for line in main.splitlines())
assert '-f $source_dir/scripts/update-helltube.py' in main
assert 'install -o root -g root -m 755 "$source_dir/scripts/update-helltube.py" /usr/local/lib/helltube/update-helltube.py' in main
assert 'install -o root -g root -m 600 "$WORK_DIR/update.json" /etc/helltube/update.json' in main
assert 'render_update_config "$NODE_BIN" "$NPM_BIN"' in main
assert 'install -d -o root -g root -m 755 /usr/local/lib/helltube' in main
pin = main.index('install -o root -g root -m 755 "$source_dir/scripts/wireguard.py" /usr/local/lib/helltube/wireguard.py')
copy = main.index("rsync -a")
assert main.index('systemctl stop "$vpn_unit"') < copy < pin
assert '$YOUTUBE_VPN_ENABLED == yes' in main[copy:pin]
assert main.count("install_youtube_proxy_apparmor") == 1
assert 'if [[ $YOUTUBE_VPN_ENABLED == yes ]]; then\n        install_youtube_proxy_apparmor;\n        systemctl enable --now helltube-vpn.service helltube-youtube-proxy.service;' in main
assert "ensure_build_account" in main
PY
printf 'PASS: bootstrap locks before settings, pins trusted helpers and installs updater units only after HTTPS health\n'

deployment_rsync=$(declare -f main | sed -n '/^[[:space:]]*rsync /p')
for exclusion in .secrets cookies.txt youtube-cookies.txt youtube-wireguard.conf; do
  assert_contains "$deployment_rsync" "--exclude=$exclusion"
done
[[ $deployment_rsync == *"--exclude='*.conf'"* || $deployment_rsync == *'--exclude="*.conf"'* ||
  $deployment_rsync == *'--exclude=*.conf'* ]] || die 'Deployment must exclude provider-named WireGuard profiles.'
printf 'PASS: deployment rsync excludes secret directories and common cookie exports\n'

help=$(main --help)
for information in 'filesystem path' 'Netscape' 'youtube.com only' 'reuse/replace/disable' \
  '/etc/helltube/.secrets/youtube-cookies.txt' 'not an API key or pasted content' \
  'https://github.com/M-ax/helltube.git' 'main' 'npm dependencies' 'brief restarts' \
  '5 minutes' '2 minutes' '30 seconds' 'default no' 'enabled state' 'Worker' 'separate'; do
  assert_contains "$help" "$information"
done
printf 'PASS: help describes optional cookies, automatic update trust, timing and rerun defaults\n'

printf 'All bootstrap shell tests passed. No system packages, services or real credentials were touched.\n'
