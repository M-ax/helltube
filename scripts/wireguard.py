#!/usr/bin/env python3
"""Root-only WireGuard namespace lifecycle; validate is usable without root.

Only the encrypted WireGuard UDP socket uses host routing. Endpoint hostnames
are resolved once on the host before setup (an intentional host-DNS exception).
All proxy DNS uses numeric profile resolvers through WireGuard. The parent must
bind the public runtime resolv.conf AND nsswitch.conf into tinyproxy's mount
namespace, and stop tinyproxy before up/down. This helper never starts a proxy.
"""

import base64
import binascii
from contextlib import contextmanager
from dataclasses import dataclass, field
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import signal
import socket
import stat
import subprocess
import sys


MAX_PROFILE_BYTES = 64 * 1024
CONFIG = "/etc/helltube/.secrets/youtube-wireguard.conf"
RUNTIME = "/run/helltube-vpn"
NETNS_DIRECTORY = "/run/netns"
NAMESPACE = "helltube-youtube"
WIREGUARD = "ht-wg0"
HOST_VETH = "ht-vpn-host"
PEER_VETH = "ht-vpn-peer"
HOST_IP = "169.254.77.1"
PEER_IP = "169.254.77.2"
TRANSPORT = ipaddress.ip_network("169.254.77.0/30")
MARKER = ".managed"
MARKER_CONTENT = b"helltube-wireguard-namespace-v1\n"
PUBLIC_FILES = ("resolv.conf", "nsswitch.conf")
NSSWITCH = b"passwd: files\ngroup: files\nshadow: files\nhosts: files dns\nnetworks: files\n"
COMMAND_ENV = {"PATH": "/usr/sbin:/usr/bin:/sbin:/bin", "LC_ALL": "C"}


class SafeError(Exception):
    """Messages must be constant diagnostics, never user or subprocess content."""


@dataclass(frozen=True, repr=False)
class Profile:
    private_key: str = field(repr=False)
    public_key: str = field(repr=False)
    preshared_key: str = field(repr=False)
    addresses: tuple
    dns: tuple
    allowed_ips: tuple
    endpoint_host: str
    endpoint_port: int
    mtu: int = 1420
    listen_port: int = 0
    keepalive: int = 0

    @property
    def ipv6(self):
        return any(address.version == 6 for address in self.addresses)


def invalid():
    raise SafeError("Invalid WireGuard profile; check the supported fields and values.")


def key(value):
    try:
        decoded = base64.b64decode(value, validate=True)
    except (ValueError, binascii.Error):
        invalid()
    if len(decoded) != 32 or base64.b64encode(decoded).decode("ascii") != value:
        invalid()
    return value


def number(value, minimum, maximum):
    if not re.fullmatch(r"[0-9]{1,5}", value):
        invalid()
    result = int(value)
    if not minimum <= result <= maximum:
        invalid()
    return result


def usable_ip(address):
    return not (
        address.is_unspecified or address.is_loopback or address.is_multicast
        or address.is_link_local
        or (address.version == 4 and (address in TRANSPORT or int(address) == 0xffffffff))
        or (address.version == 6 and address.ipv4_mapped is not None)
    )


def endpoint(value):
    if value.startswith("["):
        match = re.fullmatch(r"\[([0-9a-fA-F:]+)\]:([0-9]+)", value)
        if not match:
            invalid()
        try:
            address = ipaddress.IPv6Address(match[1])
        except ValueError:
            invalid()
        if not usable_ip(address):
            invalid()
        return str(address), number(match[2], 1, 65535)
    if value.count(":") != 1:
        invalid()
    host, port = value.rsplit(":", 1)
    try:
        address = ipaddress.IPv4Address(host)
    except ValueError:
        labels = host.removesuffix(".").split(".")
        if (len(host) > 253 or re.fullmatch(r"[0-9.]+", host)
                or any(not re.fullmatch(r"[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?", label)
                       for label in labels)):
            invalid()
    else:
        if not usable_ip(address):
            invalid()
        host = str(address)
    return host, number(port, 1, 65535)


def parse_profile(data):
    if not data or len(data) > MAX_PROFILE_BYTES:
        raise SafeError("WireGuard profile must be nonempty and at most 64 KiB.")
    try:
        text = data.decode("ascii").replace("\r\n", "\n")
    except UnicodeError:
        invalid()
    if re.search(r"[^\x09\x0a\x20-\x7e]", text):
        invalid()
    permitted = {
        "Interface": {"PrivateKey", "Address", "DNS", "MTU", "ListenPort"},
        "Peer": {"PublicKey", "PresharedKey", "Endpoint", "AllowedIPs", "PersistentKeepalive"},
    }
    repeated = {"Address", "DNS", "AllowedIPs"}
    sections = {}
    section = None
    for raw_line in text.split("\n"):
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue
        if line.startswith("["):
            if line not in ("[Interface]", "[Peer]"):
                invalid()
            section = line[1:-1]
            if section in sections or (not sections and section != "Interface"):
                invalid()
            sections[section] = {}
            continue
        if section is None or "=" not in line:
            invalid()
        name, value = (part.strip() for part in line.split("=", 1))
        if name not in permitted[section] or not value:
            raise SafeError("Unsupported or empty WireGuard field; hooks, Table and SaveConfig are forbidden.")
        values = sections[section]
        if name in values and name not in repeated:
            raise SafeError("Repeated scalar WireGuard field is not supported.")
        if name in repeated:
            parts = [part.strip() for part in value.split(",")]
            if not all(parts):
                invalid()
            values.setdefault(name, []).extend(parts)
        else:
            values[name] = value
    if set(sections) != {"Interface", "Peer"}:
        raise SafeError("Exactly one Interface and one Peer are required.")
    interface, peer = sections["Interface"], sections["Peer"]
    if (not {"PrivateKey", "Address", "DNS"} <= interface.keys()
            or not {"PublicKey", "Endpoint", "AllowedIPs"} <= peer.keys()):
        raise SafeError("Required WireGuard fields are missing.")
    try:
        if any("/" not in value for value in interface["Address"] + peer["AllowedIPs"]):
            invalid()
        addresses = tuple(ipaddress.ip_interface(value) for value in interface["Address"])
        allowed = tuple(dict.fromkeys(ipaddress.ip_network(value, strict=True) for value in peer["AllowedIPs"]))
        dns = tuple(dict.fromkeys(ipaddress.ip_address(value) for value in interface["DNS"]))
    except ValueError:
        invalid()
    if (not any(address.version == 4 for address in addresses)
            or len(addresses) != len(set(addresses))
            or any(not usable_ip(address.ip) or "%" in str(address)
                   or (address.version == 4 and address.network.overlaps(TRANSPORT))
                   for address in addresses)):
        invalid()
    if ipaddress.ip_network("0.0.0.0/0") not in allowed:
        raise SafeError("An IPv4 full tunnel (0.0.0.0/0) is required.")
    ipv6 = any(address.version == 6 for address in addresses)
    if ipv6 != (ipaddress.ip_network("::/0") in allowed):
        raise SafeError("IPv6 requires both an IPv6 interface address and ::/0.")
    if (not 1 <= len(dns) <= 3 or any(not usable_ip(address) or "%" in str(address)
                                     or (address.version == 6 and not ipv6)
                                     or address in [item.ip for item in addresses] for address in dns)):
        raise SafeError("DNS must contain one to three safe numeric tunnel resolvers.")
    host, port = endpoint(peer["Endpoint"])
    mtu = number(interface.get("MTU", "1420"), 1280 if ipv6 else 576, 9000)
    return Profile(
        key(interface["PrivateKey"]), key(peer["PublicKey"]),
        key(peer["PresharedKey"]) if "PresharedKey" in peer else "",
        addresses, dns, allowed, host, port, mtu,
        number(interface.get("ListenPort", "0"), 0, 65535),
        number(peer.get("PersistentKeepalive", "0"), 0, 65535),
    )


def read_profile(source, private=False):
    before = os.lstat(source)
    if not stat.S_ISREG(before.st_mode):
        raise SafeError("Profile source must be a regular file, not a symlink.")
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
    flags |= getattr(os, "O_BINARY", 0) | getattr(os, "O_CLOEXEC", 0)
    fd = os.open(source, flags)
    try:
        info = os.fstat(fd)
        if (not stat.S_ISREG(info.st_mode)
                or (before.st_dev, before.st_ino) != (info.st_dev, info.st_ino)):
            raise SafeError("Profile source changed or is not a regular file.")
        if private and (info.st_uid != 0 or info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600):
            raise SafeError("Installed WireGuard profile must be root:root with mode 0600.")
        if info.st_size > MAX_PROFILE_BYTES:
            raise SafeError("WireGuard profile must be nonempty and at most 64 KiB.")
        chunks = []
        remaining = MAX_PROFILE_BYTES + 1
        while remaining:
            chunk = os.read(fd, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        return data, parse_profile(data)
    finally:
        os.close(fd)


def require_root(linux=False):
    if os.name != "posix" or os.geteuid() != 0 or (linux and sys.platform != "linux"):
        raise SafeError("This operation requires root on Linux (namespace operations need CAP_NET_ADMIN and CAP_SYS_ADMIN).")


@contextmanager
def trusted_directory(path, mode=None):
    """Walk directory FDs without symlinks; no untrusted ancestor can swap them."""
    parts = Path(os.path.abspath(path)).parts
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
    fd = os.open(parts[0], flags)
    try:
        for index, part in enumerate(parts):
            if index:
                child = os.open(part, flags, dir_fd=fd)
                os.close(fd)
                fd = child
            info = os.fstat(fd)
            final = index == len(parts) - 1
            if (info.st_uid != 0 or (info.st_mode & 0o022 and not (not final and info.st_mode & stat.S_ISVTX))
                    or (final and (info.st_gid != 0 or (mode is not None and stat.S_IMODE(info.st_mode) != mode)))):
                raise SafeError("Directory must be root-owned, protected, and have the required permissions.")
        yield fd
    finally:
        os.close(fd)


def file_info(directory, name):
    try:
        return os.stat(name, dir_fd=directory, follow_symlinks=False)
    except FileNotFoundError:
        return None


def check_target(directory, name):
    info = file_info(directory, name)
    if info is not None and (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_uid != 0):
        raise SafeError("Refusing an unsafe destination or runtime file.")


def atomic_write(directory, name, data, mode):
    check_target(directory, name)
    temporary = ".wireguard-" + secrets.token_hex(16)
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC,
                 0o600, dir_fd=directory)
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchown(stream.fileno(), 0, 0)
            os.fchmod(stream.fileno(), mode)
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        check_target(directory, name)
        os.replace(temporary, name, src_dir_fd=directory, dst_dir_fd=directory)
        # The rename is the commit point. A post-commit durability failure must
        # not claim that an import failed and preserved the previous profile.
        try:
            os.fsync(directory)
        except OSError:
            pass
    finally:
        if file_info(directory, temporary) is not None:
            os.unlink(temporary, dir_fd=directory)


def import_profile(source, destination):
    require_root()
    data, _ = read_profile(source)
    destination = Path(os.path.abspath(destination))
    with trusted_directory(destination.parent, 0o700) as directory:
        atomic_write(directory, destination.name, data, 0o600)


def run_command(arguments, data=None, purpose="network"):
    diagnostics = {
        "network": "Network operation failed; check CAP_NET_ADMIN and LXC network namespace permissions.",
        "namespace": "Network namespace operation failed; LXC needs CAP_SYS_ADMIN, CAP_NET_ADMIN and mount/network namespace support.",
        "wireguard": "WireGuard interface creation failed; check kernel WireGuard support and CAP_NET_ADMIN.",
        "firewall": "Namespace firewall failed; check nftables kernel support and CAP_NET_ADMIN.",
        "configuration": "WireGuard configuration failed; check the profile and kernel WireGuard support.",
    }
    try:
        result = subprocess.run(arguments, input=data, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                timeout=30, check=False, env=COMMAND_ENV)
    except FileNotFoundError:
        raise SafeError("Required tools are missing: iproute2, wireguard-tools, nftables and procps are required.") from None
    except (OSError, subprocess.SubprocessError):
        raise SafeError(diagnostics[purpose]) from None
    if result.returncode:
        raise SafeError(diagnostics[purpose])
    if arguments == ["ip", "-j", "netns", "list"] and not result.stdout.strip():
        # iproute2 can return success without JSON when /run/netns cannot be
        # opened. Verify absence/emptiness ourselves; never hide access errors.
        try:
            with os.scandir(NETNS_DIRECTORY) as entries:
                if next(entries, None) is None:
                    return b"[]"
        except FileNotFoundError:
            return b"[]"
        except OSError:
            pass
        raise SafeError("Cannot safely inspect existing network namespaces.")
    return result.stdout


def resolve_endpoint(profile):
    try:
        address = ipaddress.ip_address(profile.endpoint_host)
    except ValueError:
        try:
            answers = socket.getaddrinfo(profile.endpoint_host, profile.endpoint_port,
                                         socket.AF_UNSPEC, socket.SOCK_DGRAM, socket.IPPROTO_UDP)
        except OSError:
            raise SafeError("Endpoint hostname could not be resolved on the host.") from None
        address = None
        for family, _, _, _, sockaddr in answers:
            if family not in (socket.AF_INET, socket.AF_INET6):
                continue
            candidate = ipaddress.ip_address(sockaddr[0])
            if usable_ip(candidate) and "%" not in str(candidate):
                address = candidate
                break
        if address is None:
            raise SafeError("Endpoint hostname has no usable host-routed address.")
    if not usable_ip(address):
        raise SafeError("Endpoint has no usable host-routed address.")
    host = f"[{address}]" if address.version == 6 else str(address)
    return f"{host}:{profile.endpoint_port}"


def render_wireguard(profile, resolved_endpoint):
    lines = ["[Interface]", f"PrivateKey = {profile.private_key}", f"ListenPort = {profile.listen_port}",
             "[Peer]", f"PublicKey = {profile.public_key}"]
    if profile.preshared_key:
        lines.append(f"PresharedKey = {profile.preshared_key}")
    lines.extend((f"Endpoint = {resolved_endpoint}",
                  "AllowedIPs = " + ", ".join(str(network) for network in profile.allowed_ips),
                  f"PersistentKeepalive = {profile.keepalive}"))
    return ("\n".join(lines) + "\n").encode("ascii")


def render_firewall():
    return f"""table inet helltube_vpn {{
    chain input {{
        type filter hook input priority 0; policy drop;
        iifname "lo" accept
        iifname "{WIREGUARD}" ct state established,related accept
        iifname "{PEER_VETH}" ip saddr {HOST_IP} ip daddr {PEER_IP} tcp dport 8888 ct state new,established accept
    }}
    chain forward {{
        type filter hook forward priority 0; policy drop;
    }}
    chain output {{
        type filter hook output priority 0; policy drop;
        oifname "lo" accept
        oifname "{WIREGUARD}" accept
        oifname "{PEER_VETH}" ip saddr {PEER_IP} ip daddr {HOST_IP} tcp sport 8888 ct state established accept
    }}
}}
""".encode("ascii")


def json_command(arguments, runner):
    try:
        result = json.loads(runner(arguments))
    except (ValueError, UnicodeError):
        raise SafeError("Cannot safely inspect existing network resources.") from None
    if not isinstance(result, list) or any(not isinstance(item, dict) for item in result):
        raise SafeError("Cannot safely inspect existing network resources.")
    return result


def names(arguments, field_name, runner):
    items = json_command(arguments, runner)
    if any(not isinstance(item.get(field_name), str) for item in items):
        raise SafeError("Cannot safely inspect existing network resources.")
    return {item[field_name] for item in items}


def preflight(runner):
    if NAMESPACE in names(["ip", "-j", "netns", "list"], "name", runner):
        raise SafeError("Reserved namespace already exists without managed ownership; refusing to modify it.")
    if {WIREGUARD, HOST_VETH, PEER_VETH} & names(["ip", "-j", "link", "show"], "ifname", runner):
        raise SafeError("Reserved interface already exists without managed ownership; refusing to modify it.")
    for route in json_command(["ip", "-j", "-4", "route", "show", "table", "all"], runner):
        destination = route.get("dst", "default")
        if destination == "default":
            continue
        try:
            network = ipaddress.ip_network(destination, strict=False)
        except (TypeError, ValueError):
            raise SafeError("Cannot safely inspect host routes.") from None
        if network.prefixlen and network.overlaps(TRANSPORT):
            raise SafeError("Reserved proxy transport subnet overlaps an existing host route.")
    # An address with noprefixroute may not appear in the host route table.
    for link in json_command(["ip", "-j", "-4", "address", "show"], runner):
        for address in link.get("addr_info", []):
            try:
                network = ipaddress.ip_interface(f"{address['local']}/{address['prefixlen']}").network
            except (KeyError, TypeError, ValueError):
                raise SafeError("Cannot safely inspect host addresses.") from None
            if network.overlaps(TRANSPORT):
                raise SafeError("Reserved proxy transport subnet overlaps an existing host address.")


def configure_network(profile, resolved_endpoint, runner):
    runner(["ip", "netns", "add", NAMESPACE], purpose="namespace")
    # Filtering is committed atomically, before even loopback is brought up.
    runner(["ip", "netns", "exec", NAMESPACE, "nft", "-f", "-"],
           data=render_firewall(), purpose="firewall")
    runner(["ip", "netns", "exec", NAMESPACE, "sysctl", "-q", "-w",
            "net.ipv6.conf.all.accept_ra=0", "net.ipv6.conf.default.accept_ra=0",
            "net.ipv6.conf.all.autoconf=0", "net.ipv6.conf.default.autoconf=0"], purpose="namespace")
    # The WireGuard UDP socket retains its birth (host) namespace after moving.
    runner(["ip", "link", "add", WIREGUARD, "type", "wireguard"], purpose="wireguard")
    runner(["ip", "link", "set", WIREGUARD, "netns", NAMESPACE])
    runner(["ip", "link", "add", HOST_VETH, "type", "veth", "peer", "name", PEER_VETH])
    runner(["ip", "link", "set", PEER_VETH, "netns", NAMESPACE])
    runner(["ip", "link", "set", "dev", HOST_VETH, "addrgenmode", "none"])
    for name in (PEER_VETH, WIREGUARD):
        runner(["ip", "-n", NAMESPACE, "link", "set", "dev", name, "addrgenmode", "none"])
    runner(["ip", "netns", "exec", NAMESPACE, "wg", "setconf", WIREGUARD, "/dev/stdin"],
           data=render_wireguard(profile, resolved_endpoint), purpose="configuration")
    runner(["ip", "-n", NAMESPACE, "link", "set", "dev", WIREGUARD, "mtu", str(profile.mtu)])
    runner(["ip", "address", "add", HOST_IP + "/30", "dev", HOST_VETH])
    runner(["ip", "-n", NAMESPACE, "address", "add", PEER_IP + "/30", "dev", PEER_VETH])
    for address in profile.addresses:
        arguments = ["ip", "-n", NAMESPACE, "address", "add", str(address), "dev", WIREGUARD, "noprefixroute"]
        if address.version == 6:
            arguments.append("nodad")
        runner(arguments)
    runner(["ip", "-n", NAMESPACE, "link", "set", "lo", "up"])
    runner(["ip", "-n", NAMESPACE, "link", "set", WIREGUARD, "up"])
    runner(["ip", "-n", NAMESPACE, "-4", "route", "add", "default", "dev", WIREGUARD])
    if profile.ipv6:
        runner(["ip", "-n", NAMESPACE, "-6", "route", "add", "default", "dev", WIREGUARD])
    else:
        runner(["ip", "-n", NAMESPACE, "-6", "route", "add", "blackhole", "default"])
    # Expose proxy transport last; it is never an egress/default route.
    runner(["ip", "-n", NAMESPACE, "link", "set", PEER_VETH, "up"])
    runner(["ip", "link", "set", HOST_VETH, "up"])


def cleanup_network(runner):
    """Call only with a valid ownership marker. Retain named handles on failure."""
    errors = []

    def attempt(action):
        try:
            return action()
        except (SafeError, OSError):
            errors.append(True)
            return None

    namespaces = attempt(lambda: names(["ip", "-j", "netns", "list"], "name", runner))
    namespace_safe = False
    if namespaces is not None and NAMESPACE in namespaces:
        links = attempt(lambda: names(["ip", "-n", NAMESPACE, "-j", "link", "show"], "ifname", runner))
        if links is not None:
            count = len(errors)
            if WIREGUARD in links:
                attempt(lambda: runner(["ip", "-n", NAMESPACE, "link", "delete", "dev", WIREGUARD]))
            namespace_safe = count == len(errors)
    links = attempt(lambda: names(["ip", "-j", "link", "show"], "ifname", runner))
    if links is not None:
        for name in (HOST_VETH, PEER_VETH, WIREGUARD):
            # Deleting a host-side veth pair removes both names.
            current = attempt(lambda: names(["ip", "-j", "link", "show"], "ifname", runner))
            if current is not None and name in current:
                attempt(lambda: runner(["ip", "link", "delete", "dev", name]))
    if namespace_safe:
        attempt(lambda: runner(["ip", "netns", "delete", NAMESPACE], purpose="namespace"))
    if errors:
        raise SafeError("Managed cleanup is incomplete; stop the proxy and retry down with CAP_NET_ADMIN, CAP_SYS_ADMIN and namespace support restored.")


@contextmanager
def runtime_directory(create=False):
    import fcntl

    path = Path(RUNTIME)
    with trusted_directory(path.parent) as parent:
        if file_info(parent, path.name) is None:
            if not create:
                yield None
                return
            os.mkdir(path.name, 0o755, dir_fd=parent)
            os.chmod(path.name, 0o755, dir_fd=parent, follow_symlinks=False)
    with trusted_directory(path, 0o755) as directory:
        try:
            fcntl.flock(directory, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except OSError:
            raise SafeError("Another WireGuard lifecycle operation is in progress.") from None
        yield directory


def owned(directory):
    info = file_info(directory, MARKER)
    if info is None:
        return False
    check_target(directory, MARKER)
    if info.st_gid != 0 or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size != len(MARKER_CONTENT):
        raise SafeError("Invalid namespace ownership marker; refusing managed cleanup.")
    fd = os.open(MARKER, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC, dir_fd=directory)
    try:
        if os.read(fd, len(MARKER_CONTENT) + 1) != MARKER_CONTENT:
            raise SafeError("Invalid namespace ownership marker; refusing managed cleanup.")
    finally:
        os.close(fd)
    return True


def cleanup_owned(directory, runner):
    if not owned(directory):
        return
    cleanup_network(runner)
    # A SIGKILL may leave an atomic-write temporary containing only public
    # metadata. A valid marker owns these too; unrelated files are never removed.
    temporaries = [name for name in os.listdir(directory) if re.fullmatch(r"\.wireguard-[0-9a-f]{32}", name)]
    for name in (*PUBLIC_FILES, *temporaries, MARKER):
        check_target(directory, name)
        if file_info(directory, name) is not None:
            os.unlink(name, dir_fd=directory)


def up(runner=run_command):
    require_root(linux=True)
    # Check the installed secret's ancestry as well as its own ownership/mode.
    with trusted_directory(Path(CONFIG).parent, 0o700):
        _, profile = read_profile(CONFIG, private=True)
    resolved_endpoint = resolve_endpoint(profile)
    with runtime_directory(create=True) as directory:
        if owned(directory):
            cleanup_owned(directory, runner)
        if os.listdir(directory):
            raise SafeError("Unmanaged runtime metadata exists; refusing to replace it.")
        preflight(runner)
        atomic_write(directory, MARKER, MARKER_CONTENT, 0o600)
        try:
            resolvers = "".join(f"nameserver {address}\n" for address in profile.dns).encode("ascii")
            atomic_write(directory, "resolv.conf", resolvers, 0o644)
            atomic_write(directory, "nsswitch.conf", NSSWITCH, 0o644)
            configure_network(profile, resolved_endpoint, runner)
        except BaseException:
            cleanup_owned(directory, runner)
            raise


def down(runner=run_command):
    require_root(linux=True)
    with runtime_directory() as directory:
        if directory is not None:
            cleanup_owned(directory, runner)


def interrupted(signum, frame):
    # Raise through the setup transaction so SIGTERM/SIGINT also clean up.
    raise SafeError("WireGuard operation interrupted; retry down if cleanup was interrupted.")


def main(argv=None):
    arguments = sys.argv[1:] if argv is None else argv
    try:
        if len(arguments) == 3 and arguments[0] == "import":
            import_profile(arguments[1], arguments[2])
        elif len(arguments) == 2 and arguments[0] == "validate":
            read_profile(arguments[1])
        elif arguments == ["up"]:
            up()
        elif arguments == ["down"]:
            down()
        else:
            raise SafeError("Usage: wireguard.py import SOURCE DEST | validate SOURCE | up | down")
    except SafeError as error:
        print("WireGuard: " + str(error), file=sys.stderr)
        return 1
    except (Exception, KeyboardInterrupt):
        # Never print a traceback, source data, path, or external command output.
        print("WireGuard: operation failed safely; check file permissions and system prerequisites.", file=sys.stderr)
        return 1
    print("WireGuard: operation completed.")
    return 0


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    sys.exit(main())