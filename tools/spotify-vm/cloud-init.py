#!/usr/bin/env python3
"""Render a cloud-init seed using public SSH keys only."""
import json
from pathlib import Path
import sys

root = Path(__file__).resolve().parent
admin_key, bridge_key, output = sys.argv[1:]

def public_key(filename):
    value = Path(filename).read_text().strip()
    if not value.startswith("ssh-ed25519 ") or "\n" in value:
        raise ValueError("Expected one Ed25519 public key")
    return value

config = {
    "hostname": "spotify-desktop",
    "manage_etc_hosts": True,
    "disable_root": False,
    "ssh_pwauth": False,
    "users": [
        {"name": "root", "lock_passwd": True, "ssh_authorized_keys": [public_key(admin_key)]},
        {"name": "spotify", "uid": 1000, "shell": "/bin/bash", "lock_passwd": True,
         "groups": ["audio", "video"], "ssh_authorized_keys": [
             'restrict,command="/usr/local/bin/helltube-spotify-bridge" ' + public_key(bridge_key)]},
    ],
    "write_files": [
        {"path": "/opt/helltube/install-guest.sh", "permissions": "0700",
         "content": (root / "install-guest.sh").read_text()},
        {"path": "/opt/helltube/bridge.py", "permissions": "0755",
         "content": (root / "bridge.py").read_text()},
        {"path": "/usr/local/bin/helltube-spotify-bridge", "permissions": "0755",
         "content": "#!/bin/sh\nexec python3 /opt/helltube/bridge.py\n"},
    ],
    "runcmd": [["bash", "-c", "/opt/helltube/install-guest.sh > /var/log/helltube-desktop-install.log 2>&1"]],
}
Path(output).write_text("#cloud-config\n" + json.dumps(config, indent=2) + "\n")
