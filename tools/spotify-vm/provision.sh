#!/usr/bin/env bash
# Run on metal as root, with two PUBLIC key paths. Existing VM disks are retained.
set -Eeuo pipefail
umask 077
[[ $EUID == 0 && $# == 2 ]] || { echo "Usage: sudo bash provision.sh admin.pub bridge.pub" >&2; exit 1; }
[[ -c /dev/kvm ]] || { echo '/dev/kvm is unavailable' >&2; exit 1; }
source_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
vm_dir=/var/lib/helltube-spotify-vm
export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y --no-install-recommends qemu-system-x86 qemu-utils cloud-image-utils curl python3 novnc websockify
id helltube-spotify-vm >/dev/null 2>&1 || useradd --system --home-dir "$vm_dir" --shell /usr/sbin/nologin helltube-spotify-vm
usermod -aG kvm helltube-spotify-vm
install -d -o helltube-spotify-vm -g helltube-spotify-vm -m 750 "$vm_dir"

if [[ ! -f $vm_dir/disk.qcow2 ]]; then
  image_url=https://cloud-images.ubuntu.com/noble/current
  image_name=noble-server-cloudimg-amd64.img
  curl -fL --retry 3 "$image_url/SHA256SUMS" -o "$vm_dir/SHA256SUMS"
  curl -fL --retry 3 "$image_url/$image_name" -o "$vm_dir/$image_name"
  (cd "$vm_dir"; awk '$2 == "*noble-server-cloudimg-amd64.img" || $2 == "noble-server-cloudimg-amd64.img"' SHA256SUMS | sha256sum --check --strict)
  qemu-img convert -f qcow2 -O qcow2 "$vm_dir/$image_name" "$vm_dir/disk.qcow2"
  qemu-img resize "$vm_dir/disk.qcow2" 30G
  python3 "$source_dir/cloud-init.py" "$1" "$2" "$vm_dir/user-data"
  printf 'instance-id: helltube-spotify-v1\nlocal-hostname: spotify-desktop\n' > "$vm_dir/meta-data"
  cloud-localds "$vm_dir/seed.img" "$vm_dir/user-data" "$vm_dir/meta-data"
fi
chown -R helltube-spotify-vm:helltube-spotify-vm "$vm_dir"
install -d -m 755 /usr/local/lib/helltube-spotify-vm
install -m 755 "$source_dir/poweroff.py" /usr/local/lib/helltube-spotify-vm/poweroff.py
cat > /etc/systemd/system/helltube-spotify-vm.service <<'EOF'
[Unit]
Description=Helltube Spotify desktop VM
After=network-online.target
Wants=network-online.target

[Service]
User=helltube-spotify-vm
Group=helltube-spotify-vm
SupplementaryGroups=kvm
WorkingDirectory=/var/lib/helltube-spotify-vm
ExecStart=/usr/bin/qemu-system-x86_64 -name helltube-spotify -machine q35,accel=kvm -cpu host -smp 4 -m 3072 -drive file=disk.qcow2,format=qcow2,if=virtio,discard=unmap -drive file=seed.img,format=raw,if=virtio,readonly=on -netdev user,id=net0,hostfwd=tcp:127.0.0.1:22022-:22 -device virtio-net-pci,netdev=net0 -device virtio-vga,xres=1280,yres=720 -vnc 127.0.0.1:91 -display none -serial file:serial.log -qmp unix:qmp.sock,server=on,wait=off -audiodev none,id=audio0 -device ich9-intel-hda -device hda-duplex,audiodev=audio0
ExecStop=/usr/bin/python3 /usr/local/lib/helltube-spotify-vm/poweroff.py
Restart=on-failure
RestartSec=5
TimeoutStopSec=45
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/var/lib/helltube-spotify-vm
ProtectHome=true
PrivateTmp=true
MemoryMax=4096M
CPUWeight=25

[Install]
WantedBy=multi-user.target
EOF
cat > /etc/systemd/system/helltube-spotify-console.service <<'EOF'
[Unit]
Description=Private browser console for the Spotify VM
After=helltube-spotify-vm.service
Requires=helltube-spotify-vm.service

[Service]
User=helltube-spotify-vm
ExecStart=/usr/bin/websockify --web=/usr/share/novnc 127.0.0.1:6081 127.0.0.1:5991
Restart=on-failure
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now helltube-spotify-vm.service helltube-spotify-console.service
echo 'VM started. Guest SSH: localhost:22022; private browser console: localhost:6081/vnc.html'
echo 'Desktop installation continues inside the VM; inspect /var/log/helltube-desktop-install.log in the guest.'
