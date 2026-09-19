#!/usr/bin/env python3
"""Ask the guest to shut down, then wait before systemd stops QEMU."""
import json
import socket
import time

deadline = time.monotonic() + 40
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(5)
    connection.connect("/var/lib/helltube-spotify-vm/qmp.sock")
    reader = connection.makefile("rb")
    reader.readline()
    for command in ("qmp_capabilities", "system_powerdown"):
        connection.sendall(json.dumps({"execute": command}).encode() + b"\n")
        while True:
            message = json.loads(reader.readline())
            if "error" in message:
                raise RuntimeError(message["error"])
            if "return" in message:
                break
    connection.settimeout(max(1, deadline - time.monotonic()))
    try:
        while time.monotonic() < deadline and reader.readline():
            pass
    except TimeoutError:
        pass  # systemd's stop timeout provides the final fallback.
