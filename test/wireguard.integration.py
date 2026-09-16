#!/usr/bin/env python3
"""Opt-in, offline Linux root test: python3 test/wireguard.integration.py --run.

Requires iproute2, util-linux, procps, WireGuard, nftables, tinyproxy and Python
3.10+. --tools-root DIR optionally uses extracted usr/bin, usr/sbin and
usr/lib/x86_64-linux-gnu tools, only in test subprocesses. No packages/services
are installed or started on the live host. Fresh mount/network/PID namespaces
and private tmpfs /run and /etc are mandatory; all children die with the PID
namespace. Native root-owned copies run every unit test, with skips forbidden.

Two synthetic peers use documentation IPv4/private IPv6 addresses and fresh
keys. A local HTTP/DNS server replaces the Internet. Tinyproxy runs as nobody
with the helper's DNS/NSS bind mounts. Tunnel-down tests also install hostile
fallback routes in the disposable namespace, proving nft drops their traffic.
This does not test systemd, Ubuntu 26.04 LXC policy, or a real VPN provider.
"""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import selectors
import shutil
import socket
import struct
import subprocess
import sys
import threading
import time


ROOT = Path(__file__).resolve().parents[1]
SCRATCH = Path("/run/helltube-wireguard-integration")
REMOTE = "ht-test-remote"
SERVER4 = "10.203.0.1"
CLIENT4 = "10.203.0.2"
SERVER6 = "fd42:203::1"
CLIENT6 = "fd42:203::2"
ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C",
       "PYTHONDONTWRITEBYTECODE": "1", "PYTHONUNBUFFERED": "1"}
sys.dont_write_bytecode = True


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run(arguments, data=None, timeout=20):
    result = subprocess.run([str(value) for value in arguments], input=data,
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, env=ENV)
    # Never include input, arguments, or a wg dump (which could contain keys).
    check(result.returncode == 0, "Integration command failed: " + str(arguments[0]))
    return result.stdout


def ns(arguments, name=REMOTE, **options):
    return run(["ip", "netns", "exec", name, *arguments], **options)


def load_helper():
    spec = importlib.util.spec_from_file_location("helltube_wireguard", ROOT / "scripts" / "wireguard.py")
    helper = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = helper
    spec.loader.exec_module(helper)
    # Only dependency discovery differs. The helper's real subprocess boundary,
    # fixed CONFIG/RUNTIME paths, parsing and lifecycle are entirely unchanged.
    helper.COMMAND_ENV = dict(ENV)
    return helper


def write(path, data, mode=0o644):
    path.write_bytes(data)
    path.chmod(mode)


def isolation_guard(parent, initial=False):
    check(sys.platform == "linux" and os.geteuid() == 0, "Linux root is required")
    previous = parent.split(",")
    check(len(previous) == 2, "Missing isolation provenance")
    current = [os.readlink("/proc/self/ns/" + name) for name in ("mnt", "net")]
    check(all(old != new for old, new in zip(previous, current)), "Refusing non-isolated execution")
    if initial:
        check(os.getpid() == 1, "A fresh PID namespace is required")
        links = json.loads(run(["ip", "-j", "link", "show"]))
        check([item["ifname"] for item in links] == ["lo"], "Refusing a populated network namespace")
    else:
        check((SCRATCH / "isolated").read_text() == parent, "Private runtime marker is missing")


def guard_tests():
    # These intentionally run before isolation and must exit without any writes.
    for arguments in ([], ["--run", "--child", "--parent", "fake-mount,fake-net"]):
        result = subprocess.run([sys.executable, str(Path(__file__).resolve()), *arguments],
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=ENV, timeout=5)
        check(result.returncode == 1, "Integration safety guard accepted an unisolated invocation")
        diagnostic = b"Explicit --run" if not arguments else b"fresh PID namespace"
        check(diagnostic in result.stderr, "Integration guard failed for an unexpected reason")
    print("PASS: opt-in and non-isolated child safety guards", flush=True)


def prepare(parent):
    isolation_guard(parent, initial=True)
    run(["mount", "--make-rprivate", "/"])
    for target in ("/run", "/etc"):
        run(["mount", "-t", "tmpfs", "-o", "mode=755,nosuid,nodev", "helltube-integration", target])
    SCRATCH.mkdir(mode=0o755)
    write(SCRATCH / "isolated", parent.encode())
    for name in ("scripts", "test"):
        (SCRATCH / name).mkdir(mode=0o755)
    for name in ("scripts/wireguard.py", "test/wireguard.test.py", "test/wireguard.integration.py"):
        shutil.copyfile(ROOT / name, SCRATCH / name)
        (SCRATCH / name).chmod(0o644)
    write(Path("/etc/passwd"), b"root:x:0:0:root:/root:/bin/sh\nnobody:x:65534:65534:nobody:/:/usr/sbin/nologin\n")
    write(Path("/etc/group"), b"root:x:0:\nnogroup:x:65534:\n")
    write(Path("/etc/hosts"), b"127.0.0.1 localhost\n::1 localhost\n")
    write(Path("/etc/resolv.conf"), b"nameserver 127.0.0.53\n")
    write(Path("/etc/nsswitch.conf"), b"passwd: files\ngroup: files\nhosts: files dns\n")
    Path("/etc/helltube").mkdir(mode=0o755)
    Path("/etc/helltube/.secrets").mkdir(mode=0o700)
    run(["ip", "link", "set", "lo", "up"])


def unit_tests():
    result = subprocess.run([sys.executable, str(SCRATCH / "test/wireguard.test.py"), "-v"],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=ENV, timeout=45)
    output = result.stdout.decode("utf-8", "replace")
    print(output, end="", flush=True)
    check(result.returncode == 0 and "skipped" not in output, "Native unit suite must pass without skips")
    print("PASS: native Linux root unit suite, no skipped tests", flush=True)


def keypair():
    private = run(["wg", "genkey"]).strip()
    public = run(["wg", "pubkey"], data=private + b"\n").strip()
    return private, public


def setup_remote(client_public, server_private):
    run(["ip", "netns", "add", REMOTE])
    run(["ip", "link", "add", "ht-test-host", "type", "veth", "peer", "name", "ht-test-peer"])
    run(["ip", "link", "set", "ht-test-peer", "netns", REMOTE])
    for prefix, name, address4, address6 in ((["ip"], "ht-test-host", "192.0.2.1/30", "fd42:192::1/64"),
                                          (["ip", "-n", REMOTE], "ht-test-peer", "192.0.2.2/30", "fd42:192::2/64")):
        run([*prefix, "link", "set", name, "addrgenmode", "none"])
        run([*prefix, "address", "add", address4, "dev", name])
        run([*prefix, "address", "add", address6, "dev", name, "nodad"])
        run([*prefix, "link", "set", name, "up"])
    ns(["ip", "link", "set", "lo", "up"])
    ns(["ip", "link", "add", "ht-test-wg", "type", "wireguard"])
    ns(["wg", "setconf", "ht-test-wg", "/dev/stdin"], data=(
        b"[Interface]\nPrivateKey = " + server_private + b"\nListenPort = 51820\n[Peer]\nPublicKey = "
        + client_public + f"\nAllowedIPs = {CLIENT4}/32, {CLIENT6}/128\n".encode()))
    ns(["ip", "address", "add", SERVER4 + "/32", "dev", "ht-test-wg"])
    ns(["ip", "address", "add", SERVER6 + "/128", "dev", "ht-test-wg", "nodad"])
    ns(["ip", "link", "set", "ht-test-wg", "up"])
    ns(["ip", "route", "add", CLIENT4 + "/32", "dev", "ht-test-wg"])
    ns(["ip", "-6", "route", "add", CLIENT6 + "/128", "dev", "ht-test-wg"])


def install_profile(helper, client_private, server_public, ipv6):
    addresses = CLIENT4 + "/32" + (", " + CLIENT6 + "/128" if ipv6 else "")
    allowed = "0.0.0.0/0, ::/0" if ipv6 else "0.0.0.0/0"
    data = (b"[Interface]\nPrivateKey = " + client_private + f"\nAddress = {addresses}\nDNS = {SERVER4}\n".encode()
            + b"[Peer]\nPublicKey = " + server_public
            + f"\nEndpoint = 192.0.2.2:51820\nAllowedIPs = {allowed}\nPersistentKeepalive = 1\n".encode())
    source = SCRATCH / "synthetic.conf"
    write(source, data, 0o600)
    check(helper.main(["import", str(source), helper.CONFIG]) == 0, "Real import failed")
    source.unlink()


def dns_answer(query):
    check(len(query) >= 12, "Invalid synthetic DNS request")
    offset, labels = 12, []
    while query[offset]:
        length = query[offset]
        labels.append(query[offset + 1:offset + 1 + length].decode("ascii"))
        offset += length + 1
    end = offset + 5
    kind, family = struct.unpack("!HH", query[offset + 1:end])
    name = ".".join(labels)
    records = {("v4.wireguard.test", 1): socket.inet_pton(socket.AF_INET, SERVER4),
               ("v6.wireguard.test", 28): socket.inet_pton(socket.AF_INET6, SERVER6)}
    address = records.get((name, kind)) if family == 1 else None
    answer = b""
    if address:
        answer = b"\xc0\x0c" + struct.pack("!HHIH", kind, 1, 0, len(address)) + address
    header = query[:2] + struct.pack("!HHHHH", 0x8180, 1, int(bool(address)), 0, 0)
    return header + query[12:end] + answer, name


def peer_worker(parent):
    isolation_guard(parent)
    selector = selectors.DefaultSelector()
    events = {"ipv4": 0, "ipv6": 0, "dns": []}
    for family, address, label in ((socket.AF_INET, SERVER4, "ipv4"), (socket.AF_INET6, SERVER6, "ipv6")):
        listener = socket.socket(family, socket.SOCK_STREAM)
        listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        listener.bind((address, 443))
        listener.listen(16)
        selector.register(listener, selectors.EVENT_READ, label)
    resolver = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    resolver.bind((SERVER4, 53))
    selector.register(resolver, selectors.EVENT_READ, "dns")
    write(SCRATCH / "peer-ready", b"ready")
    while True:
        for selected, _ in selector.select():
            if selected.data == "dns":
                query, source = selected.fileobj.recvfrom(4096)
                answer, name = dns_answer(query)
                resolver.sendto(answer, source)
                events["dns"].append([name, source[0]])
            else:
                connection, _ = selected.fileobj.accept()
                with connection:
                    connection.settimeout(3)
                    connection.recv(4096)
                    body = ("synthetic-" + selected.data).encode()
                    connection.sendall(b"HTTP/1.1 200 OK\r\nConnection: close\r\nContent-Length: "
                                       + str(len(body)).encode() + b"\r\n\r\n" + body)
                events[selected.data] += 1
            temporary = SCRATCH / "events.tmp"
            write(temporary, json.dumps(events).encode())
            temporary.replace(SCRATCH / "events.json")


def proxy_worker(parent):
    isolation_guard(parent)
    for name in ("resolv.conf", "nsswitch.conf"):
        run(["mount", "--bind", "/run/helltube-vpn/" + name, "/etc/" + name])
        run(["mount", "-o", "remount,bind,ro", "/etc/" + name])
    os.setgroups([])
    os.setgid(65534)
    os.setuid(65534)
    os.execvpe("tinyproxy", ["tinyproxy", "-d", "-c", str(SCRATCH / "tinyproxy.conf")], ENV)


def spawn_worker(mode, name, parent):
    return subprocess.Popen(["ip", "netns", "exec", name, sys.executable,
                             str(SCRATCH / "test/wireguard.integration.py"), "--" + mode,
                             "--parent", parent], stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, env=ENV)


def stop(process):
    if process.poll() is None:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    process.stderr.close()


def wait_for(predicate, process):
    deadline = time.monotonic() + 8
    while time.monotonic() < deadline:
        check(process.poll() is None, "Synthetic server/proxy exited during startup")
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError("Synthetic server/proxy did not become ready")


def proxy_ready():
    try:
        with socket.create_connection(("169.254.77.2", 8888), timeout=0.2):
            return True
    except OSError:
        return False


def request(target, expected=None):
    # Connecting to the proxy itself MUST succeed even in negative egress tests.
    with socket.create_connection(("169.254.77.2", 8888), timeout=2) as connection:
        connection.settimeout(2)
        connection.sendall(f"CONNECT {target}:443 HTTP/1.1\r\nHost: {target}:443\r\n\r\n".encode())
        response = b""
        try:
            while b"\r\n\r\n" not in response and len(response) < 8192:
                part = connection.recv(4096)
                if not part:
                    break
                response += part
        except (TimeoutError, ConnectionResetError):
            check(expected is None, "Positive CONNECT timed out")
            return
        success = response.startswith((b"HTTP/1.0 200 ", b"HTTP/1.1 200 "))
        if expected is None:
            check(not success, "Proxy unexpectedly connected without WireGuard egress")
            return
        check(success, "Positive CONNECT was rejected")
        connection.sendall(b"GET / HTTP/1.1\r\nHost: synthetic.test\r\nConnection: close\r\n\r\n")
        response = b""
        while True:
            part = connection.recv(4096)
            if not part:
                break
            response += part
        check(expected in response, "CONNECT did not reach the synthetic endpoint")


def host_state():
    routes = []
    for version in ("-4", "-6"):
        entries = json.loads(run(["ip", "-j", version, "route", "show", "table", "all"]))
        routes.append([entry for entry in entries if entry.get("dev") != "ht-vpn-host"])
    return routes, run(["nft", "list", "ruleset"]).decode(), Path("/etc/resolv.conf").read_text(), Path("/etc/nsswitch.conf").read_text()


def assert_host_state(baseline):
    for name, expected, actual in zip(("routes", "firewall", "DNS", "NSS"), baseline, host_state()):
        check(expected == actual, "Isolated host " + name + " changed: expected " + json.dumps(expected)
              + "; actual " + json.dumps(actual))


class LoopbackProbe:
    def __enter__(self):
        self.server = socket.socket()
        self.server.bind(("127.0.0.1", 0))
        self.server.listen(8)
        self.server.settimeout(0.1)
        self.done = threading.Event()
        self.thread = threading.Thread(target=self.serve)
        self.thread.start()
        self.verify()
        return self

    def serve(self):
        while not self.done.is_set():
            try:
                connection, _ = self.server.accept()
            except TimeoutError:
                continue
            with connection:
                connection.sendall(b"host-loopback-unaffected")

    def verify(self):
        with socket.create_connection(self.server.getsockname(), timeout=2) as connection:
            check(connection.recv(128) == b"host-loopback-unaffected", "Host loopback was affected")

    def __exit__(self, *error):
        self.done.set()
        self.thread.join(timeout=2)
        self.server.close()


def assert_network(helper, ipv6):
    firewall = json.loads(ns(["nft", "-j", "list", "ruleset"], helper.NAMESPACE))["nftables"]
    chains = [item["chain"] for item in firewall if "chain" in item]
    check({chain["hook"] for chain in chains} == {"input", "output", "forward"}, "Missing firewall chains")
    check(all(chain["policy"] == "drop" for chain in chains), "Firewall must default-drop")
    for version in ("-4", "-6"):
        routes = json.loads(run(["ip", "-n", helper.NAMESPACE, "-j", version, "route", "show"]))
        defaults = [route for route in routes if route.get("dst") == "default"]
        check(len(defaults) == 1, "Expected exactly one namespace default per family")
        if version == "-6" and not ipv6:
            check(defaults[0].get("type") == "blackhole", "IPv4-only profile lacks IPv6 blackhole")
        else:
            check(defaults[0].get("dev") == helper.WIREGUARD, "Default route is not WireGuard-only")
    for prefix, name in ((["ip"], helper.HOST_VETH), (["ip", "-n", helper.NAMESPACE], helper.PEER_VETH)):
        addresses = json.loads(run([*prefix, "-j", "-6", "address", "show", "dev", name]))
        check(all(not item["addr_info"] for item in addresses), "Transport veth gained IPv6 addresses")
    check(Path("/etc/resolv.conf").read_bytes() == b"nameserver 127.0.0.53\n", "Proxy DNS mount leaked to host")
    print("PASS: real nft default-drop chains, WG-only routes, transport IPv6 disabled", flush=True)


def hostile_fallback(helper):
    # This is deliberately MORE permissive routing than the helper installs.
    # Static veth neighbours make IPv6 failure evidence about nft, not NDP.
    forwarding = {name: run(["sysctl", "-n", name]).decode().strip()
                  for name in ("net.ipv4.ip_forward", "net.ipv6.conf.all.forwarding")}
    run(["sysctl", "-q", "-w", "net.ipv4.ip_forward=1", "net.ipv6.conf.all.forwarding=1"])
    run(["ip", "route", "add", SERVER4 + "/32", "via", "192.0.2.2"])
    run(["ip", "-6", "route", "add", SERVER6 + "/128", "via", "fd42:192::2"])
    ns(["ip", "route", "add", "169.254.77.0/30", "via", "192.0.2.1"])
    ns(["ip", "-6", "route", "add", "fd42:77::/64", "via", "fd42:192::1"])
    run(["ip", "address", "add", "fd42:77::1/64", "dev", helper.HOST_VETH, "nodad"])
    run(["ip", "-n", helper.NAMESPACE, "address", "add", "fd42:77::2/64", "dev", helper.PEER_VETH, "nodad"])
    host = json.loads(run(["ip", "-j", "link", "show", "dev", helper.HOST_VETH]))[0]["address"]
    peer = json.loads(run(["ip", "-n", helper.NAMESPACE, "-j", "link", "show", "dev", helper.PEER_VETH]))[0]["address"]
    run(["ip", "-6", "neigh", "replace", "fd42:77::2", "lladdr", peer, "nud", "permanent", "dev", helper.HOST_VETH])
    run(["ip", "-n", helper.NAMESPACE, "-6", "neigh", "replace", "fd42:77::1", "lladdr", host,
         "nud", "permanent", "dev", helper.PEER_VETH])
    for version, address, gateway in (("-4", SERVER4 + "/32", helper.HOST_IP), ("-6", SERVER6 + "/128", "fd42:77::1")):
        run(["ip", "-n", helper.NAMESPACE, version, "route", "add", address, "via", gateway, "dev", helper.PEER_VETH])
    rules = ["table inet ht_test_observe {", "counter attempts4 {}", "counter attempts6 {}",
             "counter leaks4 {}", "counter leaks6 {}"]
    for name, priority in (("attempts", -10), ("leaks", 10)):
        rules += [f"chain {name} {{ type filter hook output priority {priority}; policy accept;",
                  f'oifname "{helper.PEER_VETH}" ip daddr {SERVER4} tcp dport 443 counter name {name}4',
                  f'oifname "{helper.PEER_VETH}" ip6 daddr {SERVER6} tcp dport 443 counter name {name}6', "}"]
    ns(["nft", "-f", "-"], helper.NAMESPACE, data=("\n".join([*rules, "}"]) + "\n").encode())
    # Both endpoints remain reachable from the isolated host without the tunnel.
    for address in (SERVER4, SERVER6):
        with socket.create_connection((address, 443), timeout=2) as connection:
            connection.sendall(b"GET / HTTP/1.0\r\n\r\n")
            check(b"200 OK" in connection.recv(4096), "Synthetic fallback endpoint is unavailable")
    request(SERVER4)
    request("[" + SERVER6 + "]")
    counters = json.loads(ns(["nft", "-j", "list", "counters", "table", "inet", "ht_test_observe"], helper.NAMESPACE))
    counts = {item["counter"]["name"]: item["counter"]["packets"] for item in counters["nftables"] if "counter" in item}
    check(counts["attempts4"] > 0 and counts["attempts6"] > 0, "Fallback tests did not exercise both IPv4 and IPv6 output")
    check(counts["leaks4"] == counts["leaks6"] == 0, "Cleartext traffic escaped through the veth")
    print("PASS: hostile veth fallback nft counters: " + json.dumps(counts, sort_keys=True), flush=True)
    run(["ip", "route", "delete", SERVER4 + "/32", "via", "192.0.2.2"])
    run(["ip", "-6", "route", "delete", SERVER6 + "/128", "via", "fd42:192::2"])
    ns(["ip", "route", "delete", "169.254.77.0/30", "via", "192.0.2.1"])
    ns(["ip", "-6", "route", "delete", "fd42:77::/64", "via", "fd42:192::1"])
    # Router mode also adds a kernel IPv6 subnet-anycast route; restore it by
    # restoring our test setting, not by ignoring it in the host-state check.
    run(["sysctl", "-q", "-w", *(name + "=" + value for name, value in forwarding.items())])


def integration(parent):
    helper = load_helper()
    client_private, client_public = keypair()
    server_private, server_public = keypair()
    setup_remote(client_public, server_private)
    worker = spawn_worker("peer-worker", REMOTE, parent)
    proxy = None
    try:
        wait_for(lambda: (SCRATCH / "peer-ready").exists(), worker)
        proxy_dir = Path("/run/helltube-youtube-proxy")
        proxy_dir.mkdir(mode=0o750)
        os.chown(proxy_dir, 65534, 65534)
        write(SCRATCH / "tinyproxy.conf", b"""Port 8888
Listen 169.254.77.2
Allow 169.254.77.1
ConnectPort 443
Timeout 120
MaxClients 32
LogFile "/dev/null"
LogLevel Critical
PidFile "/run/helltube-youtube-proxy/tinyproxy.pid"
DisableViaHeader Yes
""")
        baseline = host_state()
        with LoopbackProbe() as loopback:
            for ipv6 in (False, True):
                install_profile(helper, client_private, server_public, ipv6)
                check(helper.main(["up"]) == 0, "Real helper up failed")
                assert_network(helper, ipv6)
                proxy = spawn_worker("proxy-worker", helper.NAMESPACE, parent)
                wait_for(proxy_ready, proxy)
                request(SERVER4, b"synthetic-ipv4")
                request("v4.wireguard.test", b"synthetic-ipv4")
                if ipv6:
                    request("[" + SERVER6 + "]", b"synthetic-ipv6")
                    request("v6.wireguard.test", b"synthetic-ipv6")
                else:
                    request("[" + SERVER6 + "]")
                handshakes = ns(["wg", "show", helper.WIREGUARD, "latest-handshakes"], helper.NAMESPACE)
                check(int(handshakes.split()[1]) > 0, "No real WireGuard handshake")
                events = json.loads((SCRATCH / "events.json").read_bytes())
                check(["v4.wireguard.test", CLIENT4] in events["dns"], "DNS did not traverse WireGuard from its tunnel address")
                if ipv6:
                    check(["v6.wireguard.test", CLIENT4] in events["dns"], "IPv6 hostname did not use the bound tunnel resolver")
                assert_host_state(baseline)
                loopback.verify()
                print("PASS: real handshake, unprivileged tinyproxy CONNECT and bound DNS/NSS (" +
                      ("dual-stack" if ipv6 else "IPv4-only; IPv6 blocked") + ")", flush=True)
                run(["ip", "-n", helper.NAMESPACE, "link", "set", helper.WIREGUARD, "down"])
                request(SERVER4)
                request("[" + SERVER6 + "]")
                request("v4.wireguard.test")
                after = json.loads((SCRATCH / "events.json").read_bytes())
                check(after == events, "Tunnel-down traffic reached the synthetic HTTP/DNS endpoint")
                check(proxy.poll() is None and worker.poll() is None, "Negative test lost its proxy or endpoint")
                assert_host_state(baseline)
                loopback.verify()
                print("PASS: tunnel down blocks IPv4/IPv6 CONNECT and DNS; proxy transport and host loopback stay usable", flush=True)
                if ipv6:
                    hostile_fallback(helper)
                stop(proxy)
                proxy = None
                check(helper.main(["down"]) == helper.main(["down"]) == 0, "Real idempotent down failed")
                check(not Path("/run/netns/" + helper.NAMESPACE).exists(), "Managed namespace handle leaked")
                links = json.loads(run(["ip", "-j", "link", "show"]))
                check(not {helper.HOST_VETH, helper.PEER_VETH, helper.WIREGUARD} & {item["ifname"] for item in links},
                      "Managed interface leaked")
                check(not list(Path(helper.RUNTIME).iterdir()), "Managed runtime files leaked")
                loopback.verify()
                assert_host_state(baseline)
                print("PASS: real idempotent cleanup removes only managed resources", flush=True)
    finally:
        if proxy is not None:
            stop(proxy)
        helper.down()
        stop(worker)
        run(["ip", "link", "delete", "ht-test-host"])
        run(["ip", "netns", "delete", REMOTE])
    print("PASS: offline WireGuard integration complete; private files/mounts vanish with the test namespaces", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", action="store_true", help="Opt in to disposable root network tests")
    parser.add_argument("--tools-root", type=Path, help="Optional extracted Linux tool root (not installed)")
    parser.add_argument("--unit-only", action="store_true", help="Only run native unit tests inside isolation")
    parser.add_argument("--child", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--peer-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--proxy-worker", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--parent", default="", help=argparse.SUPPRESS)
    options = parser.parse_args()
    if options.tools_root:
        root = options.tools_root.resolve()
        ENV["PATH"] = str(root / "usr/bin") + ":" + str(root / "usr/sbin") + ":" + ENV["PATH"]
        ENV["LD_LIBRARY_PATH"] = str(root / "usr/lib/x86_64-linux-gnu")
    elif options.child or options.peer_worker or options.proxy_worker:
        for name in ("PATH", "LD_LIBRARY_PATH"):
            if name in os.environ:
                ENV[name] = os.environ[name]
    if options.peer_worker:
        peer_worker(options.parent)
    elif options.proxy_worker:
        proxy_worker(options.parent)
    elif options.child:
        check(options.run, "Explicit --run is required")
        prepare(options.parent)
        unit_tests()
        if not options.unit_only:
            integration(options.parent)
    else:
        check(options.run, "Explicit --run is required; no system changes were made")
        check(sys.platform == "linux" and os.geteuid() == 0, "Run as Linux root; do not use live namespaces")
        guard_tests()
        parent = ",".join(os.readlink("/proc/self/ns/" + name) for name in ("mnt", "net"))
        command = ["unshare", "--mount", "--net", "--pid", "--fork", "--kill-child", "--mount-proc",
                   "--propagation", "private", sys.executable, str(Path(__file__).resolve()),
                   "--run", "--child", "--parent", parent]
        if options.unit_only:
            command.append("--unit-only")
        result = subprocess.run(command, env=ENV, timeout=150)
        return result.returncode
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (AssertionError, OSError, subprocess.SubprocessError) as error:
        print("FAIL: " + (str(error) if isinstance(error, AssertionError) else type(error).__name__), file=sys.stderr)
        sys.exit(1)