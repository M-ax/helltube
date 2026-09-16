#!/usr/bin/env python3
"""Poll the trusted main branch; never execute downloaded deployment code as root."""

import fcntl
import json
import os
from pathlib import Path
import pwd
import shutil
import signal
import stat
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid


REPOSITORY = "https://github.com/M-ax/helltube.git"
REF = "refs/heads/main"
ROOT = Path("/opt/helltube")
APP = ROOT / "app"
STATE = ROOT / "update-state"
CONFIG = Path("/etc/helltube/update.json")
LOCK = Path("/run/lock/helltube-deploy.lock")
SERVICE = "helltube.service"
ENV = {
    "PATH": "/usr/local/bin:/usr/bin:/bin",
    "LC_ALL": "C.UTF-8",
    "GIT_CONFIG_NOSYSTEM": "1",
    "GIT_CONFIG_GLOBAL": "/dev/null",
    "GIT_TERMINAL_PROMPT": "0",
}
GIT_OPTIONS = ["-c", "core.hooksPath=/dev/null", "-c", "protocol.allow=never",
               "-c", "protocol.https.allow=always"]
BUILD_SCRIPT = """\
umask 022
git -c init.defaultBranch=main init app
cd app
git -c core.hooksPath=/dev/null -c protocol.allow=never -c protocol.https.allow=always \\
  fetch --depth=1 --no-tags "$1" "$2"
test "$(git rev-parse --verify 'FETCH_HEAD^{commit}')" = "$3"
git -c core.hooksPath=/dev/null checkout --detach "$3"
"$4" ci --include=dev --no-audit --no-fund --engine-strict
"$4" test
"$4" run build
"""


class UpdateError(Exception):
    pass


def log(message):
    print(message, flush=True)


def run(arguments, *, timeout=120, capture=True, check=True):
    try:
        result = subprocess.run(arguments, env=ENV, stdin=subprocess.DEVNULL,
                                capture_output=capture, text=True, timeout=timeout)
    except subprocess.TimeoutExpired as error:
        raise UpdateError(f"{Path(arguments[0]).name} timed out.") from error
    if check and result.returncode:
        raise UpdateError(f"{Path(arguments[0]).name} failed (exit {result.returncode}).")
    return result


def trusted_directory(path):
    for directory in [*reversed(path.parents), path]:
        info = directory.lstat()
        if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0
                or (info.st_mode & 0o022 and not (directory != path and info.st_mode & stat.S_ISVTX))):
            raise UpdateError("Deployment directories must be root-owned and protected, without symlinks.")


def read_json(path):
    info = path.lstat()
    if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1
            or info.st_mode & 0o022 or info.st_size > 16384):
        raise UpdateError("Unsafe updater configuration or state file.")
    value = json.loads(path.read_text())
    if not isinstance(value, dict):
        raise UpdateError("Invalid updater configuration or state file.")
    return value


def write_state(name, value):
    fd, temporary = tempfile.mkstemp(prefix=".update-", dir=STATE)
    try:
        with os.fdopen(fd, "w") as stream:
            json.dump(value, stream)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, STATE / name)
        directory = os.open(STATE, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def load_config():
    trusted_directory(CONFIG.parent)
    config = read_json(CONFIG)
    if not isinstance(config, dict) or set(config) != {"node", "npm"}:
        raise UpdateError("Rerun the bootstrap to configure the updater's Node and npm paths.")
    for binary in config.values():
        if (not isinstance(binary, str) or not binary.startswith("/")
                or any(character.isspace() for character in binary)
                or not Path(binary).is_file() or not os.access(binary, os.X_OK)):
            raise UpdateError("Configured Node/npm is unavailable; rerun the bootstrap.")
        resolved = Path(binary).resolve(strict=True)
        trusted_directory(resolved.parent)
        info = resolved.stat()
        if info.st_uid != 0 or info.st_mode & 0o022:
            raise UpdateError("Node/npm must be installed system-wide by root.")
    return config


def active():
    return run(["/usr/bin/systemctl", "is-active", "--quiet", SERVICE], check=False).returncode == 0


def healthy():
    try:
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
        with opener.open("http://127.0.0.1:3000/api/health", timeout=2) as response:
            return response.status == 200 and json.loads(response.read(8192)).get("ok") is True
    except (OSError, ValueError, AttributeError, urllib.error.URLError):
        return False


def wait_healthy():
    consecutive = 0
    for _ in range(30):
        consecutive = consecutive + 1 if active() and healthy() else 0
        if consecutive == 3:
            return
        time.sleep(1)
    raise UpdateError("Updated backend failed its health check; inspect journalctl -u helltube.")


def remote_revision():
    result = run(["/usr/bin/git", *GIT_OPTIONS, "ls-remote", "--exit-code", REPOSITORY, REF], timeout=180)
    fields = result.stdout.strip().split()
    if (len(fields) != 2 or fields[1] != REF or len(fields[0]) != 40
            or any(character not in "0123456789abcdef" for character in fields[0])):
        raise UpdateError("GitHub did not return an unambiguous main branch commit.")
    return fields[0]


def build_release(workspace, revision, config):
    account = pwd.getpwnam("helltube-build")
    if account.pw_uid == 0 or account.pw_uid == pwd.getpwnam("helltube").pw_uid:
        raise UpdateError("The build account must be separate from root and the backend.")
    os.chown(workspace, account.pw_uid, account.pw_gid)
    unit = "helltube-build-" + uuid.uuid4().hex
    path = str(Path(config["node"]).parent) + ":" + ENV["PATH"]
    arguments = [
        "/usr/bin/systemd-run", "--quiet", "--wait", "--pipe", "--collect", "--service-type=exec",
        "--unit=" + unit, "--uid=helltube-build", "--gid=helltube-build",
        "--property=RuntimeMaxSec=20min", "--property=TimeoutStopSec=15s",
        "--property=KillMode=control-group", "--property=NoNewPrivileges=yes",
        "--property=CapabilityBoundingSet=", "--property=ProtectSystem=strict",
        "--property=ProtectHome=yes", "--property=PrivateTmp=yes", "--property=PrivateDevices=yes",
        "--property=RestrictSUIDSGID=yes",
        "--property=InaccessiblePaths=/etc/helltube /var/lib/helltube",
        "--property=ReadWritePaths=" + str(workspace), "--working-directory=" + str(workspace),
        "/usr/bin/env", "-i", "PATH=" + path, "LC_ALL=C.UTF-8", "CI=true",
        "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0",
        "npm_config_cache=" + str(workspace / "npm-cache"),
        "/bin/sh", "-eu", "-c", BUILD_SCRIPT, "helltube-build", REPOSITORY, REF, revision, config["npm"],
    ]
    try:
        run(arguments, timeout=22 * 60, capture=False)
    except BaseException:
        # A transient unit is independent of the waiting systemd-run client.
        run(["/usr/bin/systemctl", "stop", unit], check=False, timeout=45)
        raise
    return workspace / "app"


def seal_release(release):
    if release.is_symlink() or not release.is_dir():
        raise UpdateError("Build did not produce an application directory.")
    for required in ("package.json", "package-lock.json", "server/main.js", "dist/index.html"):
        path = release / required
        if path.is_symlink() or not path.is_file():
            raise UpdateError("Build is missing a required application artifact.")
    # The build unit has exited (including its children). Reject filesystem tricks
    # before changing ownership; npm's relative, in-tree .bin links are allowed.
    for directory, directories, files in os.walk(release, followlinks=False):
        for name in [".", *directories, *files]:
            path = Path(directory) / name
            info = path.lstat()
            if stat.S_ISLNK(info.st_mode):
                target = Path(os.readlink(path))
                try:
                    safe = not target.is_absolute() and path.resolve(strict=True).is_relative_to(release)
                except (OSError, RuntimeError):
                    safe = False
                if not safe:
                    raise UpdateError("Build contains an unsafe symlink.")
            elif not (stat.S_ISDIR(info.st_mode) or stat.S_ISREG(info.st_mode) and info.st_nlink == 1):
                raise UpdateError("Build contains a special file or hard link.")
    metadata = release / ".git"
    if metadata.exists():
        if metadata.is_symlink() or not metadata.is_dir():
            raise UpdateError("Build contains unsafe Git metadata.")
        shutil.rmtree(metadata)
    for directory, directories, files in os.walk(release, followlinks=False):
        for name in [".", *directories, *files]:
            path = Path(directory) / name
            info = path.lstat()
            os.chown(path, 0, 0, follow_symlinks=False)
            if not stat.S_ISLNK(info.st_mode):
                os.chmod(path, 0o755 if stat.S_ISDIR(info.st_mode) or info.st_mode & 0o111 else 0o644)


def activate(release, revision):
    previous = STATE / "previous-app"
    moved = installed = started = stopped = False
    write_state("pending.json", {"revision": revision, "phase": "stopping"})
    try:
        run(["/usr/bin/systemctl", "stop", SERVICE])
        stopped = True
        if active():
            raise UpdateError("Backend did not stop; refusing to replace running code.")
        if previous.exists() or previous.is_symlink():
            trusted_directory(previous)
            shutil.rmtree(previous)
        os.replace(APP, previous)
        moved = True
        os.replace(release, APP)
        installed = True
        write_state("pending.json", {"revision": revision, "phase": "starting"})
        # Once startup is attempted the database may have migrated. Never roll
        # back code or restore stale data automatically after this point.
        started = True
        run(["/usr/bin/systemctl", "start", SERVICE])
        wait_healthy()
        write_state("deployed.json", {"revision": revision})
        (STATE / "pending.json").unlink()
        log(f"Deployed {revision}; backend is healthy.")
    except BaseException:
        if started:
            run(["/usr/bin/systemctl", "stop", SERVICE])
            log("Backend stopped after an unsuccessful cutover. Previous code is in update-state/previous-app; data has NOT been rolled back.")
        elif stopped:
            if installed:
                os.replace(APP, release)
            if moved:
                os.replace(previous, APP)
            run(["/usr/bin/systemctl", "start", SERVICE])
            log("Previous backend restored before candidate startup.")
        raise


def update(config):
    trusted_directory(ROOT)
    STATE.mkdir(mode=0o700, exist_ok=True)
    trusted_directory(STATE)
    os.chmod(STATE, 0o700)
    if (STATE / "pending.json").exists() or (STATE / "pending.json").is_symlink():
        raise UpdateError("Updates blocked by an interrupted/failed cutover. Inspect the journal and rerun a trusted bootstrap to recover.")
    trusted_directory(APP)
    if not active():
        log("Backend is stopped; leaving it stopped and skipping updates.")
        return
    revision = remote_revision()
    deployed = STATE / "deployed.json"
    if deployed.exists() and read_json(deployed).get("revision") == revision:
        log(f"Already running {revision}; no restart needed.")
        return
    if not healthy():
        raise UpdateError("Current backend is unhealthy; refusing automatic deployment.")
    log(f"Preparing {revision} from {REPOSITORY} ({REF}); current backend stays online during the build.")
    workspace = Path(tempfile.mkdtemp(prefix=".update-build-", dir=ROOT))
    try:
        release = build_release(workspace, revision, config)
        seal_release(release)
        if not active() or not healthy():
            raise UpdateError("Backend state changed during the build; refusing cutover.")
        activate(release, revision)
    finally:
        shutil.rmtree(workspace)


def interrupted(_signal, _frame):
    raise UpdateError("Update interrupted.")


def main():
    if sys.argv[1:] == ["--help"]:
        print("Usage: sudo systemctl start helltube-update.service\n"
              "Poll M-ax/helltube main, build/test in isolation, then restart the managed backend.\n"
              "Logs: journalctl -u helltube-update. Setup/recovery: rerun the trusted Ubuntu bootstrap.")
        return 0
    if sys.argv[1:] or os.geteuid() != 0 or sys.platform != "linux":
        print("Run the installed updater as root on Linux, without arguments.", file=sys.stderr)
        return 1
    os.umask(0o077)
    signal.signal(signal.SIGTERM, interrupted)
    signal.signal(signal.SIGINT, interrupted)
    try:
        # /run/lock can be a sticky shared directory. Never follow a precreated
        # link or truncate an existing file before verifying its owner/type.
        fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd, "w") as lock:
            info = os.fstat(lock.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_nlink != 1:
                raise UpdateError("Unsafe deployment lock file.")
            try:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                log("Another bootstrap/update holds the deployment lock; skipping.")
                return 0
            update(load_config())
        return 0
    except (UpdateError, OSError, ValueError, KeyError) as error:
        print(f"Update failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())