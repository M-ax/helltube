#!/usr/bin/env python3
"""Run directly: python3 test/wireguard.test.py -v. No host network/system writes.

Only external network/process boundaries are doubled. POSIX ownership/import
and marker transactions use real files and are skipped unless running as root
on Linux, in a root-owned checkout with trusted ancestors. Every fixture stays
in this checkout and is removed by the test.
"""

import base64
from contextlib import redirect_stderr, redirect_stdout
import importlib.util
import io
import ipaddress
import json
import os
from pathlib import Path
import socket
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
sys.dont_write_bytecode = True
SPEC = importlib.util.spec_from_file_location("helltube_wireguard", ROOT / "scripts" / "wireguard.py")
wg = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = wg
SPEC.loader.exec_module(wg)
PRIVATE = base64.b64encode(bytes(range(32))).decode("ascii")
PUBLIC = base64.b64encode(bytes(range(32, 64))).decode("ascii")
PRESHARED = base64.b64encode(bytes(range(64, 96))).decode("ascii")
CAN_ROOT = sys.platform == "linux" and os.geteuid() == 0


def profile_text(ipv6=False):
    address = "10.8.0.2/32, fd12:3456::2/128" if ipv6 else "10.8.0.2/32"
    dns = "10.8.0.1, fd12:3456::1" if ipv6 else "10.8.0.1"
    allowed = "0.0.0.0/0, ::/0" if ipv6 else "0.0.0.0/0"
    return f"""# An entirely synthetic test profile
[Interface]
PrivateKey = {PRIVATE}
Address = {address}
DNS = {dns}
MTU = 1380
ListenPort = 51821
[Peer]
PublicKey = {PUBLIC}
PresharedKey = {PRESHARED}
Endpoint = 198.51.100.8:51820
AllowedIPs = {allowed}
PersistentKeepalive = 25
"""


def profile(ipv6=False):
    return wg.parse_profile(profile_text(ipv6).encode("ascii"))


class NetworkBoundary:
    """Strict ip/nft/wg command boundary, tracking creation/moves/deletion.

    Unknown commands fail tests rather than silently succeeding. This does not
    claim to emulate packet filtering or verify Linux netlink/nft syntax.
    """

    def __init__(self, fail_at=None, fail_commands=()):
        self.calls = []
        self.host = {"lo", "eth0", "unrelated0"}
        self.namespaces = {"unrelated": {"lo", "other-wg"}}
        self.routes = [{"dst": "default", "gateway": "192.0.2.1"}, {"dst": "192.0.2.0/24"}]
        self.addresses = [{"ifname": "eth0", "addr_info": [{"local": "192.0.2.2", "prefixlen": 24}]}]
        self.fail_at = fail_at
        self.fail_commands = {tuple(command) for command in fail_commands}
        self.firewall = False

    def __call__(self, arguments, data=None, purpose="network"):
        arguments = list(arguments)
        self.calls.append((arguments, data, purpose))
        if len(self.calls) == self.fail_at or tuple(arguments) in self.fail_commands:
            raise wg.SafeError("Injected network boundary failure.")
        if arguments == ["ip", "-j", "netns", "list"]:
            return json.dumps([{"name": name} for name in self.namespaces]).encode()
        if arguments == ["ip", "-j", "link", "show"]:
            return json.dumps([{"ifname": name} for name in self.host]).encode()
        if arguments == ["ip", "-j", "-4", "route", "show", "table", "all"]:
            return json.dumps(self.routes).encode()
        if arguments == ["ip", "-j", "-4", "address", "show"]:
            return json.dumps(self.addresses).encode()
        if arguments[:3] == ["ip", "netns", "add"]:
            assert arguments == ["ip", "netns", "add", wg.NAMESPACE]
            assert wg.NAMESPACE not in self.namespaces
            self.namespaces[wg.NAMESPACE] = {"lo"}
        elif arguments[:3] == ["ip", "netns", "delete"]:
            assert arguments == ["ip", "netns", "delete", wg.NAMESPACE]
            assert wg.WIREGUARD not in self.namespaces[wg.NAMESPACE], "Delete the WG interface before unmounting its namespace"
            del self.namespaces[wg.NAMESPACE]
        elif arguments[:4] == ["ip", "netns", "exec", wg.NAMESPACE]:
            assert wg.NAMESPACE in self.namespaces
            command = arguments[4:]
            if command == ["nft", "-f", "-"]:
                assert data == wg.render_firewall()
                self.firewall = True
            elif command[0] == "sysctl":
                assert command == ["sysctl", "-q", "-w", "net.ipv6.conf.all.accept_ra=0",
                                   "net.ipv6.conf.default.accept_ra=0", "net.ipv6.conf.all.autoconf=0",
                                   "net.ipv6.conf.default.autoconf=0"]
            elif command == ["wg", "setconf", wg.WIREGUARD, "/dev/stdin"]:
                assert wg.WIREGUARD in self.namespaces[wg.NAMESPACE]
                assert data and PRIVATE.encode() in data
            else:
                raise AssertionError("Unexpected namespace command")
        elif arguments[:3] == ["ip", "link", "add"]:
            name = arguments[3]
            assert name not in self.host
            if name == wg.WIREGUARD:
                assert arguments == ["ip", "link", "add", name, "type", "wireguard"]
            else:
                assert arguments == ["ip", "link", "add", wg.HOST_VETH, "type", "veth", "peer", "name", wg.PEER_VETH]
                assert wg.PEER_VETH not in self.host
                self.host.add(wg.PEER_VETH)
            self.host.add(name)
        elif arguments[:3] == ["ip", "link", "set"] and "netns" in arguments:
            name = arguments[3]
            assert arguments == ["ip", "link", "set", name, "netns", wg.NAMESPACE]
            self.host.remove(name)
            self.namespaces[wg.NAMESPACE].add(name)
        elif arguments[:4] == ["ip", "link", "delete", "dev"]:
            name = arguments[4]
            assert len(arguments) == 5
            self.host.remove(name)
            if name in (wg.HOST_VETH, wg.PEER_VETH):
                other = wg.PEER_VETH if name == wg.HOST_VETH else wg.HOST_VETH
                self.host.discard(other)
                for links in self.namespaces.values():
                    links.discard(other)
        elif arguments[:3] == ["ip", "-n", wg.NAMESPACE]:
            command = arguments[3:]
            links = self.namespaces[wg.NAMESPACE]
            if command == ["-j", "link", "show"]:
                return json.dumps([{"ifname": name} for name in links]).encode()
            if command[:3] == ["link", "delete", "dev"]:
                assert len(command) == 4 and command[3] == wg.WIREGUARD
                links.remove(command[3])
            elif command[:2] == ["link", "set"]:
                name = command[3] if command[2] == "dev" else command[2]
                assert name in links
                assert (command[-2:] == ["addrgenmode", "none"] or command[-2:] == ["mtu", "1380"]
                        or command[-1:] == ["up"]), "Unexpected link operation"
                if command[-1] == "up":
                    assert self.firewall, "A link came up before filtering"
            elif command[:2] == ["address", "add"]:
                assert command[3:5] == ["dev", wg.PEER_VETH] or command[3:5] == ["dev", wg.WIREGUARD]
                address = ipaddress.ip_interface(command[2])
                if command[4] == wg.WIREGUARD:
                    assert command[5:] == (["noprefixroute", "nodad"] if address.version == 6 else ["noprefixroute"])
                else:
                    assert command == ["address", "add", wg.PEER_IP + "/30", "dev", wg.PEER_VETH]
            elif command in (["-4", "route", "add", "default", "dev", wg.WIREGUARD],
                              ["-6", "route", "add", "default", "dev", wg.WIREGUARD],
                              ["-6", "route", "add", "blackhole", "default"]):
                assert self.firewall
            else:
                raise AssertionError("Unexpected in-namespace ip command")
        elif arguments == ["ip", "link", "set", "dev", wg.HOST_VETH, "addrgenmode", "none"]:
            assert wg.HOST_VETH in self.host
        elif arguments == ["ip", "address", "add", wg.HOST_IP + "/30", "dev", wg.HOST_VETH]:
            assert wg.HOST_VETH in self.host
        elif arguments == ["ip", "link", "set", wg.HOST_VETH, "up"]:
            assert self.firewall and wg.HOST_VETH in self.host
        else:
            raise AssertionError("Unexpected host network command")
        return b""


class ProfileTests(unittest.TestCase):
    def assert_invalid(self, text):
        with self.assertRaises(wg.SafeError) as context:
            wg.parse_profile(text.encode("ascii") if isinstance(text, str) else text)
        for secret in (PRIVATE, PUBLIC, PRESHARED, "secret-sentinel"):
            self.assertNotIn(secret, str(context.exception))

    def test_ipv4_and_ipv6_profiles(self):
        for ipv6 in (False, True):
            with self.subTest(ipv6=ipv6):
                parsed = profile(ipv6)
                self.assertEqual(parsed.ipv6, ipv6)
                self.assertEqual(parsed.mtu, 1380)
                self.assertEqual(parsed.listen_port, 51821)
                self.assertEqual(parsed.keepalive, 25)
                self.assertEqual(parsed.private_key, PRIVATE)
                self.assertNotIn(PRIVATE, repr(parsed))

    def test_comments_crlf_whitespace_and_repeated_lists(self):
        text = profile_text(True).replace("DNS = 10.8.0.1, fd12:3456::1", "DNS = 10.8.0.1\nDNS = fd12:3456::1 # comment")
        text = text.replace("Address = 10.8.0.2/32, fd12:3456::2/128", "Address = 10.8.0.2/32\nAddress = fd12:3456::2/128")
        text = text.replace("AllowedIPs = 0.0.0.0/0, ::/0", "AllowedIPs = 0.0.0.0/0\nAllowedIPs = ::/0, 0.0.0.0/0")
        parsed = wg.parse_profile(text.replace("\n", "\r\n").encode())
        self.assertEqual(parsed.addresses, profile(True).addresses)
        self.assertEqual(parsed.dns, profile(True).dns)
        self.assertEqual(parsed.allowed_ips, profile(True).allowed_ips)

    def test_optional_fields_have_safe_defaults(self):
        text = profile_text()
        for line in ("MTU = 1380\n", "ListenPort = 51821\n", f"PresharedKey = {PRESHARED}\n", "PersistentKeepalive = 25\n"):
            text = text.replace(line, "")
        parsed = wg.parse_profile(text.encode())
        self.assertEqual((parsed.mtu, parsed.listen_port, parsed.keepalive, parsed.preshared_key), (1420, 0, 0, ""))

    def test_unknown_vendor_shell_fields_and_scalars_rejected(self):
        for field in ("PreUp", "PostUp", "PreDown", "PostDown", "SaveConfig", "Table", "FwMark", "Jc", "S1", "DNSLeakProtection"):
            with self.subTest(field=field):
                self.assert_invalid(profile_text().replace("[Peer]", f"{field} = secret-sentinel\n[Peer]"))
        for field, value in (("PrivateKey", PRIVATE), ("MTU", "1380"), ("ListenPort", "0")):
            self.assert_invalid(profile_text().replace("[Peer]", f"{field} = {value}\n[Peer]"))
        for field, value in (("PublicKey", PUBLIC), ("PresharedKey", PRESHARED), ("Endpoint", "example.org:1"), ("PersistentKeepalive", "1")):
            self.assert_invalid(profile_text() + f"{field} = {value}\n")

    def test_exactly_one_ordered_interface_and_peer_required(self):
        for text in (profile_text() + "[Peer]\n", profile_text() + "[Interface]\n", "[Peer]\n" + profile_text(),
                     profile_text().replace("[Peer]", "[Unknown]"), profile_text().split("[Peer]")[0],
                     "DNS = 10.8.0.1\n" + profile_text()):
            self.assert_invalid(text)
        for line in (f"PrivateKey = {PRIVATE}\n", "Address = 10.8.0.2/32\n", "DNS = 10.8.0.1\n",
                     f"PublicKey = {PUBLIC}\n", "Endpoint = 198.51.100.8:51820\n", "AllowedIPs = 0.0.0.0/0\n"):
            self.assert_invalid(profile_text().replace(line, ""))

    def test_keys_and_control_characters_rejected(self):
        for value in ("secret-sentinel", PRIVATE[:-1], PRIVATE + "=", "!" * 44,
                      base64.b64encode(b"x" * 31).decode(), base64.b64encode(b"x" * 33).decode()):
            self.assert_invalid(profile_text().replace(PRIVATE, value))
        for suffix in (b"\x00", b"\r", b"\x1b", b"\x7f", b"\xff", b"\x0b"):
            self.assert_invalid(profile_text().encode() + b"# secret-sentinel" + suffix)

    def test_addresses_allowed_ips_and_full_tunnel(self):
        for value in ("bad/32", "10.8.0.2", "10.8.0.2/33", "127.0.0.1/8", "169.254.77.3/32", "10.8.0.2/0", "0.0.0.0/32", "224.0.0.1/32", "10.8.0.2/32,", "10.8.0.2/32, 10.8.0.2/32"):
            self.assert_invalid(profile_text().replace("Address = 10.8.0.2/32", "Address = " + value))
        for value in ("10.0.0.0/8", "0.0.0.0", "0.0.0.1/0", "0.0.0.0/0, bad", "0.0.0.0/0, ::/0", "0.0.0.0/0,"):
            self.assert_invalid(profile_text().replace("AllowedIPs = 0.0.0.0/0", "AllowedIPs = " + value))
        self.assert_invalid(profile_text(True).replace("0.0.0.0/0, ::/0", "0.0.0.0/0"))

    def test_dns_rejects_clear_transport_and_local_resolvers(self):
        for value in ("localhost", "resolver.example.org", "127.0.0.53", "0.0.0.0", "224.0.0.1", "169.254.1.1", "169.254.77.1", "169.254.77.2", "255.255.255.255", "10.8.0.2", "10.8.0.1,", "1.1.1.1, 8.8.8.8, 9.9.9.9, 10.8.0.1", "::1", "::", "ff02::1", "fe80::1", "fe80::1%lo", "::ffff:127.0.0.1", "::ffff:169.254.77.1"):
            with self.subTest(dns=value):
                self.assert_invalid(profile_text(True).replace("DNS = 10.8.0.1, fd12:3456::1", "DNS = " + value))
        self.assert_invalid(profile_text().replace("DNS = 10.8.0.1", "DNS = 2606:4700:4700::1111"))

    def test_endpoints_and_ports(self):
        for value, host in (("vpn.example.org:51820", "vpn.example.org"), ("vpn.example.org.:1", "vpn.example.org."),
                            ("[2001:db8::8]:65535", "2001:db8::8"), ("10.0.0.1:53", "10.0.0.1")):
            parsed = wg.parse_profile(profile_text().replace("198.51.100.8:51820", value).encode())
            self.assertEqual(parsed.endpoint_host, host)
        for value in ("vpn.example.org:0", "vpn.example.org:65536", "vpn.example.org:-1", "-bad.example:10", "bad_.example:10", "a..b:10", "a" * 64 + ".org:10", "https://example.org:10", "example.org;id:10", "example.org:10;id", "127.0.0.1:10", "127.1:10", "169.254.77.1:10", "[::1]:10", "[fe80::1%eth0]:10", "2001:db8::1:10"):
            self.assert_invalid(profile_text().replace("198.51.100.8:51820", value))
        for old, value in (("MTU = 1380", "MTU = 575"), ("MTU = 1380", "MTU = 9001"),
                           ("ListenPort = 51821", "ListenPort = 65536"), ("PersistentKeepalive = 25", "PersistentKeepalive = -1")):
            self.assert_invalid(profile_text().replace(old, value))
        self.assert_invalid(profile_text(True).replace("MTU = 1380", "MTU = 1279"))

    def test_maximum_size_is_inclusive(self):
        data = profile_text().encode()
        padded = data + b"#" + b"x" * (wg.MAX_PROFILE_BYTES - len(data) - 1)
        self.assertEqual(len(padded), 65536)
        wg.parse_profile(padded)
        self.assert_invalid(padded + b"x")
        self.assert_invalid(b"")


class FileTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix=".wireguard-test-", dir=ROOT / "test")
        self.addCleanup(self.temporary.cleanup)
        self.workspace = Path(self.temporary.name)
        self.source = self.workspace / "secret-sentinel.conf"
        self.source.write_bytes(profile_text().encode())

    def test_read_snapshot_and_validate_do_not_modify_source(self):
        original = self.source.read_bytes()
        before = self.source.stat()
        data, parsed = wg.read_profile(self.source)
        self.assertEqual(data, original)
        self.assertEqual(parsed.private_key, PRIVATE)
        stdout, stderr = io.StringIO(), io.StringIO()
        with redirect_stdout(stdout), redirect_stderr(stderr):
            self.assertEqual(wg.main(["validate", str(self.source)]), 0)
        self.assertEqual(self.source.read_bytes(), original)
        self.assertEqual(self.source.stat().st_mtime_ns, before.st_mtime_ns)
        self.assertEqual(set(self.workspace.iterdir()), {self.source})
        self.assertEqual(stderr.getvalue(), "")
        self.assertNotIn(PRIVATE, stdout.getvalue())

    def test_cli_malformed_oversized_missing_and_usage_do_not_leak(self):
        for data in (b"secret-sentinel", profile_text().encode() + b"#" + b"x" * 65536, b"\xffsecret-sentinel"):
            self.source.write_bytes(data)
            result = subprocess.run([sys.executable, str(ROOT / "scripts" / "wireguard.py"), "validate", str(self.source)],
                                    capture_output=True, text=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, "")
            for forbidden in ("secret-sentinel", PRIVATE, "Traceback", str(self.source)):
                self.assertNotIn(forbidden, result.stderr)
        for arguments in (["validate", str(self.workspace / "secret-sentinel-missing")], ["secret-sentinel", PRIVATE]):
            output = io.StringIO()
            with redirect_stderr(output):
                self.assertEqual(wg.main(arguments), 1)
            self.assertNotIn("secret-sentinel", output.getvalue())
            self.assertNotIn(PRIVATE, output.getvalue())

    def test_source_directory_and_symlink_rejected(self):
        with self.assertRaises(wg.SafeError):
            wg.read_profile(self.workspace)
        link = self.workspace / "profile-link"
        try:
            link.symlink_to(self.source)
        except OSError as error:
            self.skipTest("Creating symlinks requires platform privileges: " + type(error).__name__)
        with self.assertRaises(wg.SafeError):
            wg.read_profile(link)

    @unittest.skipUnless(os.name == "posix", "POSIX FIFO test")
    def test_fifo_is_rejected_without_opening_it(self):
        fifo = self.workspace / "fifo"
        os.mkfifo(fifo)
        with self.assertRaises(wg.SafeError):
            wg.read_profile(fifo)

    def test_read_rejects_oversized_regular_file(self):
        self.source.write_bytes(b"#" * (wg.MAX_PROFILE_BYTES + 1))
        with self.assertRaises(wg.SafeError):
            wg.read_profile(self.source)

    def test_read_accepts_exact_size_limit(self):
        data = profile_text().encode()
        data += b"#" + b"x" * (wg.MAX_PROFILE_BYTES - len(data) - 1)
        self.source.write_bytes(data)
        actual, parsed = wg.read_profile(self.source)
        self.assertEqual(actual, data)
        self.assertEqual(parsed.private_key, PRIVATE)


class NetworkTests(unittest.TestCase):
    def assert_clean(self, boundary):
        self.assertEqual(boundary.host, {"lo", "eth0", "unrelated0"})
        self.assertEqual(boundary.namespaces, {"unrelated": {"lo", "other-wg"}})

    def test_firewall_has_only_expected_accept_rules(self):
        text = wg.render_firewall().decode()
        self.assertEqual(text.count("policy drop;"), 3)
        rules = {line.strip() for line in text.splitlines() if "accept" in line}
        self.assertEqual(rules, {
            'iifname "lo" accept', 'oifname "lo" accept',
            'iifname "ht-wg0" ct state established,related accept', 'oifname "ht-wg0" accept',
            'iifname "ht-vpn-peer" ip saddr 169.254.77.1 ip daddr 169.254.77.2 tcp dport 8888 ct state new,established accept',
            'oifname "ht-vpn-peer" ip saddr 169.254.77.2 ip daddr 169.254.77.1 tcp sport 8888 ct state established accept',
        })
        self.assertNotIn("flush", text)

    def test_order_host_birth_stdin_and_no_host_route_or_firewall_mutations(self):
        boundary = NetworkBoundary()
        wg.preflight(boundary)
        wg.configure_network(profile(), "198.51.100.8:51820", boundary)
        commands = [call[0] for call in boundary.calls]
        firewall = commands.index(["ip", "netns", "exec", wg.NAMESPACE, "nft", "-f", "-"])
        create = commands.index(["ip", "link", "add", wg.WIREGUARD, "type", "wireguard"])
        move = commands.index(["ip", "link", "set", wg.WIREGUARD, "netns", wg.NAMESPACE])
        self.assertLess(firewall, create)
        self.assertLess(create, move)
        for arguments, data, _ in boundary.calls:
            self.assertNotIn(PRIVATE, " ".join(arguments))
            self.assertNotIn(PRESHARED, " ".join(arguments))
            if arguments[-1] == "up":
                self.assertGreater(commands.index(arguments), firewall)
            if "route" in arguments and "add" in arguments:
                self.assertEqual(arguments[:3], ["ip", "-n", wg.NAMESPACE])
                self.assertNotIn(wg.PEER_VETH, arguments)
                self.assertNotIn(wg.HOST_VETH, arguments)
            if "sysctl" in arguments or "nft" in arguments:
                self.assertEqual(arguments[:4], ["ip", "netns", "exec", wg.NAMESPACE])
            if "setconf" in arguments:
                self.assertEqual(arguments[-1], "/dev/stdin")
                self.assertIn(PRIVATE.encode(), data)
                for forbidden in (b"Address", b"DNS", b"MTU", b"PostUp"):
                    self.assertNotIn(forbidden, data)
        self.assertIn(["ip", "-n", wg.NAMESPACE, "-6", "route", "add", "blackhole", "default"], commands)
        for name, prefix in ((wg.HOST_VETH, ["ip"]), (wg.PEER_VETH, ["ip", "-n", wg.NAMESPACE]), (wg.WIREGUARD, ["ip", "-n", wg.NAMESPACE])):
            disable = commands.index(prefix + ["link", "set", "dev", name, "addrgenmode", "none"])
            enable = commands.index(prefix + ["link", "set", name, "up"])
            self.assertLess(disable, enable)
        self.assertEqual(commands[-1], ["ip", "link", "set", wg.HOST_VETH, "up"])

    def test_dual_stack_routes_and_addresses(self):
        boundary = NetworkBoundary()
        wg.configure_network(profile(True), "[2001:db8::8]:51820", boundary)
        commands = [call[0] for call in boundary.calls]
        self.assertIn(["ip", "-n", wg.NAMESPACE, "-6", "route", "add", "default", "dev", wg.WIREGUARD], commands)
        self.assertIn(["ip", "-n", wg.NAMESPACE, "address", "add", "fd12:3456::2/128", "dev", wg.WIREGUARD, "noprefixroute", "nodad"], commands)
        self.assertFalse(any("blackhole" in command for command in commands))

    def test_preflight_refuses_unowned_names_and_transport_overlap(self):
        for name in (wg.HOST_VETH, wg.PEER_VETH, wg.WIREGUARD, wg.NAMESPACE):
            boundary = NetworkBoundary()
            if name == wg.NAMESPACE:
                boundary.namespaces[name] = {"lo"}
            else:
                boundary.host.add(name)
            with self.assertRaises(wg.SafeError):
                wg.preflight(boundary)
            self.assertTrue(all("-j" in call[0] for call in boundary.calls))
        for destination in ("169.254.77.0/30", "169.254.0.0/16", "169.254.77.1/32", "128.0.0.0/1", "secret-sentinel"):
            boundary = NetworkBoundary()
            boundary.routes.append({"dst": destination, "table": "123"})
            with self.assertRaises(wg.SafeError):
                wg.preflight(boundary)
        boundary = NetworkBoundary()
        boundary.addresses.append({"addr_info": [{"local": wg.HOST_IP, "prefixlen": 30}]})
        with self.assertRaises(wg.SafeError):
            wg.preflight(boundary)

    def test_malformed_network_inspection_is_not_treated_as_empty(self):
        for output in (b"not-json secret-sentinel", b"{}", b"[1]", b"[{}]", b'[{"name": 1}]'):
            with self.assertRaises(wg.SafeError) as context:
                wg.preflight(lambda arguments: output)
            self.assertNotIn("secret-sentinel", str(context.exception))

    def test_cleanup_handles_failure_after_every_setup_command(self):
        complete = NetworkBoundary()
        wg.configure_network(profile(), "198.51.100.8:51820", complete)
        for index in range(1, len(complete.calls) + 1):
            with self.subTest(command=index):
                boundary = NetworkBoundary(fail_at=index)
                with self.assertRaises(wg.SafeError):
                    wg.configure_network(profile(), "198.51.100.8:51820", boundary)
                wg.cleanup_network(boundary)
                self.assert_clean(boundary)
                wg.cleanup_network(boundary)
                self.assert_clean(boundary)

    def test_cleanup_preserves_named_namespace_on_wg_deletion_failure(self):
        command = ["ip", "-n", wg.NAMESPACE, "link", "delete", "dev", wg.WIREGUARD]
        boundary = NetworkBoundary(fail_commands=[command])
        wg.configure_network(profile(), "198.51.100.8:51820", boundary)
        with self.assertRaises(wg.SafeError):
            wg.cleanup_network(boundary)
        self.assertIn(wg.NAMESPACE, boundary.namespaces)
        self.assertNotIn(wg.HOST_VETH, boundary.host)
        self.assertIn(wg.WIREGUARD, boundary.namespaces[wg.NAMESPACE])
        boundary.fail_commands.clear()
        wg.cleanup_network(boundary)
        self.assert_clean(boundary)

    def test_cleanup_continues_after_host_deletion_failure(self):
        command = ["ip", "link", "delete", "dev", wg.HOST_VETH]
        boundary = NetworkBoundary(fail_commands=[command])
        wg.configure_network(profile(), "198.51.100.8:51820", boundary)
        with self.assertRaises(wg.SafeError):
            wg.cleanup_network(boundary)
        self.assertNotIn(wg.NAMESPACE, boundary.namespaces)
        boundary.fail_commands.clear()
        wg.cleanup_network(boundary)
        self.assert_clean(boundary)

    def test_cleanup_inspection_failure_keeps_namespace_handle_for_retry(self):
        for command in (["ip", "-j", "netns", "list"], ["ip", "-n", wg.NAMESPACE, "-j", "link", "show"]):
            boundary = NetworkBoundary(fail_commands=[command])
            wg.configure_network(profile(), "198.51.100.8:51820", boundary)
            with self.assertRaises(wg.SafeError):
                wg.cleanup_network(boundary)
            self.assertIn(wg.NAMESPACE, boundary.namespaces)
            self.assertNotIn(wg.HOST_VETH, boundary.host)
            boundary.fail_commands.clear()
            wg.cleanup_network(boundary)
            self.assert_clean(boundary)

    def test_endpoint_resolution_uses_host_once_and_only_numeric_wg_value(self):
        parsed = wg.parse_profile(profile_text().replace("198.51.100.8", "vpn.example.org").encode())
        answers = [(socket.AF_INET6, socket.SOCK_DGRAM, socket.IPPROTO_UDP, "", ("2001:db8::8", 51820, 0, 0))]
        with patch.object(wg.socket, "getaddrinfo", return_value=answers) as resolver:
            result = wg.resolve_endpoint(parsed)
        resolver.assert_called_once_with("vpn.example.org", 51820, socket.AF_UNSPEC, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        self.assertEqual(result, "[2001:db8::8]:51820")
        rendered = wg.render_wireguard(parsed, result)
        self.assertNotIn(b"vpn.example.org", rendered)
        self.assertIn(b"Endpoint = [2001:db8::8]:51820", rendered)
        with patch.object(wg.socket, "getaddrinfo", side_effect=AssertionError("Numeric endpoints must not invoke DNS")):
            self.assertEqual(wg.resolve_endpoint(profile()), "198.51.100.8:51820")

    def test_bad_resolver_results_and_errors_are_safe(self):
        parsed = wg.parse_profile(profile_text().replace("198.51.100.8", "vpn.example.org").encode())
        for address in ("127.0.0.1", "169.254.77.1", "224.0.0.1", "0.0.0.0"):
            answers = [(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_UDP, "", (address, 51820))]
            with patch.object(wg.socket, "getaddrinfo", return_value=answers), self.assertRaises(wg.SafeError):
                wg.resolve_endpoint(parsed)
        with patch.object(wg.socket, "getaddrinfo", side_effect=socket.gaierror("secret-sentinel")):
            with self.assertRaises(wg.SafeError) as context:
                wg.resolve_endpoint(parsed)
            self.assertNotIn("secret-sentinel", str(context.exception))

    def test_command_boundary_captures_output_and_never_reports_secrets(self):
        for purpose, diagnostic in (("namespace", "CAP_SYS_ADMIN"), ("wireguard", "kernel WireGuard"), ("firewall", "CAP_NET_ADMIN"), ("configuration", "configuration")):
            result = subprocess.CompletedProcess(["wg"], 1, PRIVATE.encode(), PRESHARED.encode())
            with patch.object(wg.subprocess, "run", return_value=result) as process:
                with self.assertRaises(wg.SafeError) as context:
                    wg.run_command(["wg", "setconf", wg.WIREGUARD, "/dev/stdin"], data=PRIVATE.encode(), purpose=purpose)
            self.assertIn(diagnostic, str(context.exception))
            self.assertNotIn(PRIVATE, str(context.exception))
            self.assertNotIn(PRESHARED, str(context.exception))
            options = process.call_args.kwargs
            self.assertEqual(options["stdout"], subprocess.PIPE)
            self.assertEqual(options["stderr"], subprocess.PIPE)
            self.assertEqual(options["input"], PRIVATE.encode())
            self.assertEqual(options["env"], wg.COMMAND_ENV)
            self.assertFalse(options.get("shell", False))
        for failure in (FileNotFoundError("secret-sentinel"), subprocess.TimeoutExpired(PRIVATE, 30, stderr=PRESHARED)):
            with patch.object(wg.subprocess, "run", side_effect=failure), self.assertRaises(wg.SafeError) as context:
                wg.run_command(["ip", "-j", "link", "show"])
            self.assertNotIn("secret-sentinel", str(context.exception))
            self.assertNotIn(PRIVATE, str(context.exception))


@unittest.skipUnless(CAN_ROOT, "Real root-owned POSIX file operations require Linux root")
class RootFileTests(unittest.TestCase):
    def setUp(self):
        FileTests.setUp(self)
        os.chmod(self.workspace, 0o700)
        self.private = self.workspace / "private"
        self.private.mkdir(mode=0o700)
        self.destination = self.private / "installed.conf"
        self.destination.write_bytes(b"previous secret")
        self.destination.chmod(0o600)
        self.runtime = self.workspace / "runtime"
        # Redirect fixed paths only; no platform, ownership or file API mocks.
        self.original_config, self.original_runtime = wg.CONFIG, wg.RUNTIME
        wg.CONFIG, wg.RUNTIME = str(self.destination), str(self.runtime)
        self.addCleanup(self.restore_paths)

    def restore_paths(self):
        wg.CONFIG, wg.RUNTIME = self.original_config, self.original_runtime

    def test_import_atomic_replacement_and_private_permissions(self):
        with self.destination.open("rb") as previous:
            wg.import_profile(self.source, self.destination)
            self.assertEqual(previous.read(), b"previous secret")
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())
        info = self.destination.stat()
        self.assertEqual((info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)), (0, 0, 0o600))
        self.assertEqual(list(self.private.iterdir()), [self.destination])
        wg.import_profile(self.destination, self.destination)
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())

    def test_invalid_import_preserves_existing_secret(self):
        for data in (b"secret-sentinel", b"x" * 65537, profile_text().replace("DNS = 10.8.0.1", "DNS = 127.0.0.53").encode()):
            self.source.write_bytes(data)
            with self.assertRaises(wg.SafeError):
                wg.import_profile(self.source, self.destination)
            self.assertEqual(self.destination.read_bytes(), b"previous secret")
            self.assertEqual(list(self.private.iterdir()), [self.destination])

    def test_import_refuses_source_and_destination_symlinks(self):
        source_link = self.workspace / "source-link"
        source_link.symlink_to(self.source)
        with self.assertRaises(wg.SafeError):
            wg.import_profile(source_link, self.destination)
        self.assertEqual(self.destination.read_bytes(), b"previous secret")
        self.destination.unlink()
        self.destination.symlink_to(self.source)
        with self.assertRaises(wg.SafeError):
            wg.import_profile(self.source, self.destination)
        self.assertTrue(self.destination.is_symlink())
        self.assertEqual(self.source.read_bytes(), profile_text().encode())

    def test_import_requires_existing_private_trusted_directory(self):
        with self.assertRaises(OSError):
            wg.import_profile(self.source, self.workspace / "missing" / "profile")
        self.assertFalse((self.workspace / "missing").exists())
        self.private.chmod(0o755)
        with self.assertRaises(wg.SafeError):
            wg.import_profile(self.source, self.destination)
        self.assertEqual(self.destination.read_bytes(), b"previous secret")
        self.private.chmod(0o700)
        alias = self.workspace / "alias"
        alias.symlink_to(self.private, target_is_directory=True)
        with self.assertRaises(OSError):
            wg.import_profile(self.source, alias / "installed.conf")

    def test_import_rejects_hardlink_destination_and_wrong_owner_directory(self):
        linked = self.private / "hardlink"
        os.link(self.destination, linked)
        with self.assertRaises(wg.SafeError):
            wg.import_profile(self.source, self.destination)
        self.assertEqual(linked.read_bytes(), b"previous secret")
        linked.unlink()
        os.chown(self.private, 65534, 65534)
        try:
            with self.assertRaises(wg.SafeError):
                wg.import_profile(self.source, self.destination)
            self.assertEqual(self.destination.read_bytes(), b"previous secret")
        finally:
            os.chown(self.private, 0, 0)

    def test_installed_profile_permissions_are_checked(self):
        wg.import_profile(self.source, self.destination)
        self.destination.chmod(0o644)
        boundary = NetworkBoundary()
        with self.assertRaises(wg.SafeError):
            wg.up(boundary)
        self.assertEqual(boundary.calls, [])

    def test_lifecycle_real_marker_metadata_and_idempotent_down(self):
        wg.import_profile(self.source, self.destination)
        boundary = NetworkBoundary()
        wg.up(boundary)
        self.assertEqual(stat.S_IMODE(self.runtime.stat().st_mode), 0o755)
        self.assertEqual({entry.name for entry in self.runtime.iterdir()}, {wg.MARKER, *wg.PUBLIC_FILES})
        self.assertEqual((self.runtime / "resolv.conf").read_bytes(), b"nameserver 10.8.0.1\n")
        self.assertEqual((self.runtime / "nsswitch.conf").read_bytes(), wg.NSSWITCH)
        self.assertIn(b"hosts: files dns\n", wg.NSSWITCH)
        self.assertNotIn(b"resolve", wg.NSSWITCH)
        for entry in self.runtime.iterdir():
            info = entry.stat()
            self.assertEqual((info.st_uid, info.st_gid), (0, 0))
            self.assertEqual(stat.S_IMODE(info.st_mode), 0o600 if entry.name == wg.MARKER else 0o644)
            for secret in (PRIVATE, PUBLIC, PRESHARED):
                self.assertNotIn(secret.encode(), entry.read_bytes())
        wg.up(boundary)
        wg.down(boundary)
        wg.down(boundary)
        self.assertEqual(list(self.runtime.iterdir()), [])
        NetworkTests.assert_clean(self, boundary)
        self.assertEqual(self.destination.read_bytes(), self.source.read_bytes())

    def test_up_failure_rolls_back_resources_and_marker(self):
        wg.import_profile(self.source, self.destination)
        complete = NetworkBoundary()
        wg.preflight(complete)
        wg.configure_network(profile(), "198.51.100.8:51820", complete)
        for index in range(5, len(complete.calls) + 1):
            with self.subTest(command=index):
                boundary = NetworkBoundary(fail_at=index)
                with self.assertRaises(wg.SafeError):
                    wg.up(boundary)
                NetworkTests.assert_clean(self, boundary)
                self.assertEqual(list(self.runtime.iterdir()), [])

    def test_unowned_collision_does_not_create_marker_or_remove_resource(self):
        wg.import_profile(self.source, self.destination)
        boundary = NetworkBoundary()
        boundary.namespaces[wg.NAMESPACE] = {"lo", "foreign0"}
        with self.assertRaises(wg.SafeError):
            wg.up(boundary)
        self.assertEqual(boundary.namespaces[wg.NAMESPACE], {"lo", "foreign0"})
        self.assertEqual(list(self.runtime.iterdir()), [])
        wg.down(boundary)
        self.assertEqual(boundary.namespaces[wg.NAMESPACE], {"lo", "foreign0"})

    def test_cleanup_failure_retains_marker_for_retry(self):
        wg.import_profile(self.source, self.destination)
        boundary = NetworkBoundary()
        wg.up(boundary)
        boundary.fail_commands.add(("ip", "-n", wg.NAMESPACE, "link", "delete", "dev", wg.WIREGUARD))
        with self.assertRaises(wg.SafeError):
            wg.down(boundary)
        self.assertEqual((self.runtime / wg.MARKER).read_bytes(), wg.MARKER_CONTENT)
        boundary.fail_commands.clear()
        wg.down(boundary)
        self.assertEqual(list(self.runtime.iterdir()), [])
        NetworkTests.assert_clean(self, boundary)

    def test_cleanup_recovers_public_temporaries_without_removing_foreign_files(self):
        wg.import_profile(self.source, self.destination)
        boundary = NetworkBoundary()
        wg.up(boundary)
        temporary = self.runtime / (".wireguard-" + "a" * 32)
        temporary.write_bytes(b"nameserver 10.8.0.1\n")
        foreign = self.runtime / "not-owned"
        foreign.write_bytes(b"unrelated")
        wg.down(boundary)
        NetworkTests.assert_clean(self, boundary)
        self.assertEqual(list(self.runtime.iterdir()), [foreign])
        self.assertEqual(foreign.read_bytes(), b"unrelated")
        calls = len(boundary.calls)
        with self.assertRaises(wg.SafeError):
            wg.up(boundary)
        self.assertEqual(len(boundary.calls), calls)

    def test_runtime_lock_refuses_concurrent_lifecycle(self):
        wg.import_profile(self.source, self.destination)
        boundary = NetworkBoundary()
        with wg.runtime_directory(create=True):
            with self.assertRaises(wg.SafeError):
                wg.up(boundary)
        self.assertEqual(boundary.calls, [])

    def test_down_without_marker_never_touches_network(self):
        boundary = NetworkBoundary()
        boundary.host.add(wg.HOST_VETH)
        wg.down(boundary)
        self.assertEqual(boundary.calls, [])
        self.runtime.mkdir(mode=0o755)
        wg.down(boundary)
        self.assertEqual(boundary.calls, [])

    def test_invalid_or_symlinked_marker_never_authorizes_cleanup(self):
        self.runtime.mkdir(mode=0o755)
        marker = self.runtime / wg.MARKER
        marker.write_bytes(b"untrusted")
        marker.chmod(0o600)
        boundary = NetworkBoundary()
        with self.assertRaises(wg.SafeError):
            wg.down(boundary)
        self.assertEqual(boundary.calls, [])
        marker.unlink()
        marker.symlink_to(self.source)
        with self.assertRaises(wg.SafeError):
            wg.down(boundary)
        self.assertEqual(boundary.calls, [])


if __name__ == "__main__":
    unittest.main()