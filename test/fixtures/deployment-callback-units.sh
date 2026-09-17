#!/usr/bin/env bash
set -Eeuo pipefail

# Run only from deployment-callback.integration.js. Exercise the real installer
# using unique runtime-only units, with no production updater execution.
source "$1/scripts/bootstrap-ubuntu.sh"
WORK_DIR=$2/work
test_unit=$3
AUTO_UPDATE_ENABLED=$4
test_dir=$2
[[ $test_unit =~ ^helltube-callback-[a-zA-Z0-9]+$ && $test_dir == "/run/$test_unit" ]] || die 'Unsafe fixture path.'

install() {
  [[ $# == 8 && $8 == /etc/systemd/system/helltube-update.* ]] || die 'Unexpected fixture install.'
  local name=${8##*/}
  name=${name/helltube-update/$test_unit}
  sed -e "s@helltube-update@$test_unit@g" \
      -e "s@/var/lib/helltube@$test_dir/data@g" \
      -e "s@^ExecStart=.*@ExecStart=/usr/bin/touch $test_dir/triggered@" \
      -e 's/^OnBootSec=.*/OnBootSec=100years/' \
      -e 's/^OnUnitInactiveSec=.*/OnUnitInactiveSec=100years/' \
      "$7" > "$WORK_DIR/$name"
  command install -o root -g root -m 644 "$WORK_DIR/$name" "/run/systemd/system/$name"
}

systemctl() {
  local argument
  local -a arguments=()
  for argument in "$@"; do arguments+=("${argument//helltube-update/$test_unit}"); done
  if [[ $1 == enable || $1 == disable ]]; then
    command systemctl --runtime "${arguments[@]}"
  else
    command systemctl "${arguments[@]}"
  fi
}
install_update_units
