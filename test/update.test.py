#!/usr/bin/env python3
"""Linux/root filesystem tests; systemd, GitHub and npm boundaries are mocked.

Uses an automatically removed native temporary directory to verify real POSIX
ownership, symlinks, permissions, locking and renames, including from WSL.
No installed services, users, deployment files or credentials are touched.
"""

from contextlib import ExitStack
import fcntl
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tarfile
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch


if sys.platform != "linux" or os.geteuid() != 0:
    sys.exit("Run with sudo python3 test/update.test.py on Linux; only temporary test files are modified.")

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("updater", Path(__file__).resolve().parents[1] / "scripts/update-helltube.py")
updater = importlib.util.module_from_spec(spec)
spec.loader.exec_module(updater)
REVISION = "a" * 40
OLD = "b" * 40


def artifact(directory, value="new"):
    directory.mkdir(exist_ok=True)
    for name in ("package.json", "package-lock.json", "server/main.js", "dist/index.html"):
        path = directory / name
        path.parent.mkdir(exist_ok=True)
        path.write_text(value)
    return directory


class UpdateTests(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.directory = Path(self.stack.enter_context(tempfile.TemporaryDirectory(prefix="helltube-update-test-")))
        self.app = artifact(self.directory / "app", "old")
        self.state = self.directory / "update-state"
        self.state.mkdir(mode=0o700)
        self.config = {"node": "/usr/local/bin/node", "npm": "/usr/local/bin/npm"}
        for name, value in {"ROOT": self.directory, "APP": self.app, "STATE": self.state,
                            "CONFIG": self.directory / "update.json", "LOCK": self.directory / "deploy.lock"}.items():
            self.stack.enter_context(patch.object(updater, name, value))
        self.log = self.stack.enter_context(patch.object(updater, "log"))

    def boundary(self):
        self.remote = self.stack.enter_context(patch.object(updater, "remote_revision", return_value=REVISION))
        self.active = self.stack.enter_context(patch.object(updater, "active", return_value=True))
        self.healthy = self.stack.enter_context(patch.object(updater, "healthy", return_value=True))
        self.wait = self.stack.enter_context(patch.object(updater, "wait_healthy"))
        self.build = self.stack.enter_context(patch.object(updater, "build_release",
            side_effect=lambda workspace, *_: artifact(workspace / "app")))
        self.calls = []

        def command(arguments, **_options):
            self.calls.append(arguments)
            if arguments == ["/usr/bin/systemctl", "stop", updater.SERVICE]:
                self.active.return_value = False
            if arguments == ["/usr/bin/systemctl", "start", updater.SERVICE]:
                self.active.return_value = True
            return SimpleNamespace(returncode=0, stdout="")

        self.run = self.stack.enter_context(patch.object(updater, "run", side_effect=command))

    def assert_old_untouched(self):
        self.assertEqual((self.app / "server/main.js").read_text(), "old")
        self.assertFalse((self.state / "pending.json").exists())
        self.assertEqual(list(self.directory.glob(".update-build-*")), [])
        self.assertEqual(self.calls, [])

    def test_success_builds_before_stopping_and_records_only_healthy_commit(self):
        self.boundary()
        def build(workspace, *_):
            self.assertEqual(self.calls, [])
            self.assertEqual((self.app / "server/main.js").read_text(), "old")
            return artifact(workspace / "app")
        self.build.side_effect = build
        updater.update(self.config)
        self.assertEqual((self.app / "server/main.js").read_text(), "new")
        self.assertEqual((self.state / "previous-app/server/main.js").read_text(), "old")
        self.assertEqual(json.loads((self.state / "deployed.json").read_text()), {"revision": REVISION})
        self.assertFalse((self.state / "pending.json").exists())
        self.assertEqual([call[1] for call in self.calls], ["stop", "start"])
        self.wait.assert_called_once()
        self.assertEqual(list(self.directory.glob(".update-build-*")), [])

    def test_unchanged_revision_does_not_build_or_restart(self):
        self.boundary()
        updater.write_state("deployed.json", {"revision": REVISION})
        updater.update(self.config)
        self.assert_old_untouched()
        self.build.assert_not_called()

    def test_stopped_backend_is_not_started_or_fetched(self):
        self.boundary()
        self.active.return_value = False
        updater.update(self.config)
        self.remote.assert_not_called()
        self.assert_old_untouched()

    def test_fetch_failure_leaves_old_code_and_allows_retry(self):
        self.boundary()
        self.remote.side_effect = updater.UpdateError("offline")
        with self.assertRaisesRegex(updater.UpdateError, "offline"):
            updater.update(self.config)
        self.assert_old_untouched()
        self.remote.side_effect = None
        updater.update(self.config)
        self.wait.assert_called_once()

    def test_failed_build_or_interruption_never_stops_backend(self):
        for failure in (updater.UpdateError("npm failed"), KeyboardInterrupt()):
            with self.subTest(failure=type(failure).__name__):
                self.boundary()
                self.build.side_effect = failure
                with self.assertRaises(type(failure)):
                    updater.update(self.config)
                self.assert_old_untouched()

    def test_unhealthy_existing_service_is_not_updated(self):
        self.boundary()
        self.healthy.return_value = False
        with self.assertRaisesRegex(updater.UpdateError, "Current backend is unhealthy"):
            updater.update(self.config)
        self.build.assert_not_called()
        self.assert_old_untouched()

    def test_service_stopped_during_build_is_not_restarted(self):
        self.boundary()
        self.active.side_effect = [True, False]
        with self.assertRaisesRegex(updater.UpdateError, "state changed"):
            updater.update(self.config)
        self.assert_old_untouched()

    def test_failed_artifact_validation_never_stops_service(self):
        self.boundary()
        def missing(workspace, *_):
            release = artifact(workspace / "app")
            (release / "dist/index.html").unlink()
            return release
        self.build.side_effect = missing
        with self.assertRaisesRegex(updater.UpdateError, "required application artifact"):
            updater.update(self.config)
        self.assert_old_untouched()

    def test_failed_health_stops_candidate_and_blocks_repeated_migrations(self):
        self.boundary()
        updater.write_state("deployed.json", {"revision": OLD})
        self.wait.side_effect = updater.UpdateError("unhealthy")
        with self.assertRaisesRegex(updater.UpdateError, "unhealthy"):
            updater.update(self.config)
        self.assertEqual([call[1] for call in self.calls], ["stop", "start", "stop"])
        self.assertEqual((self.app / "server/main.js").read_text(), "new")
        self.assertEqual((self.state / "previous-app/server/main.js").read_text(), "old")
        self.assertEqual(updater.read_json(self.state / "deployed.json")["revision"], OLD)
        self.assertEqual(updater.read_json(self.state / "pending.json")["phase"], "starting")
        with self.assertRaisesRegex(updater.UpdateError, "Updates blocked"):
            updater.update(self.config)
        self.build.assert_called_once()

    def test_start_failure_also_stops_candidate_without_code_rollback(self):
        self.boundary()
        original = self.run.side_effect
        def command(arguments, **options):
            result = original(arguments, **options)
            if arguments[1] == "start":
                raise updater.UpdateError("start failed")
            return result
        self.run.side_effect = command
        with self.assertRaisesRegex(updater.UpdateError, "start failed"):
            updater.update(self.config)
        self.assertEqual([call[1] for call in self.calls], ["stop", "start", "stop"])
        self.assertTrue((self.state / "pending.json").exists())
        self.assertEqual((self.app / "server/main.js").read_text(), "new")

    def test_stop_failure_does_not_move_code(self):
        self.boundary()
        self.run.side_effect = updater.UpdateError("stop failed")
        with self.assertRaisesRegex(updater.UpdateError, "stop failed"):
            updater.update(self.config)
        self.assertEqual((self.app / "server/main.js").read_text(), "old")
        self.assertFalse((self.state / "previous-app").exists())
        self.assertTrue((self.state / "pending.json").exists())

    def test_promotion_failure_restores_old_backend_before_candidate_start(self):
        self.boundary()
        replace = os.replace
        def move(source, destination):
            if Path(destination) == self.app and ".update-build-" in str(source):
                raise OSError("rename failed")
            return replace(source, destination)
        with patch.object(updater.os, "replace", side_effect=move):
            with self.assertRaisesRegex(OSError, "rename failed"):
                updater.update(self.config)
        self.assertEqual((self.app / "server/main.js").read_text(), "old")
        self.assertEqual([call[1] for call in self.calls], ["stop", "start"])
        self.wait.assert_not_called()
        self.assertTrue((self.state / "pending.json").exists())

    def test_only_one_previous_release_is_retained(self):
        self.boundary()
        artifact(self.state / "previous-app", "ancient")
        updater.update(self.config)
        self.assertEqual((self.state / "previous-app/server/main.js").read_text(), "old")

    def test_pending_marker_blocks_even_when_app_missing_after_interruption(self):
        self.boundary()
        updater.write_state("pending.json", {"revision": REVISION, "phase": "stopping"})
        self.app.rename(self.state / "previous-app")
        with self.assertRaisesRegex(updater.UpdateError, "Updates blocked"):
            updater.update(self.config)
        self.remote.assert_not_called()

    def test_real_lock_contention_skips_without_loading_config(self):
        with open(updater.LOCK, "w") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with patch.object(sys, "argv", ["updater"]), patch.object(updater, "load_config") as load:
                self.assertEqual(updater.main(), 0)
                load.assert_not_called()

    def test_lock_symlink_is_rejected_without_damaging_target(self):
        target = self.directory / "keep"
        target.write_text("keep")
        updater.LOCK.symlink_to(target)
        with patch.object(sys, "argv", ["updater"]):
            self.assertEqual(updater.main(), 1)
        self.assertEqual(target.read_text(), "keep")

    def test_state_is_private_and_atomic(self):
        updater.write_state("deployed.json", {"revision": OLD})
        updater.write_state("deployed.json", {"revision": REVISION})
        path = self.state / "deployed.json"
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        self.assertEqual(path.stat().st_uid, 0)
        self.assertEqual(updater.read_json(path), {"revision": REVISION})
        self.assertEqual(list(self.state.glob(".update-*")), [])

    def test_unsafe_state_and_directories_are_rejected(self):
        updater.write_state("deployed.json", {"revision": OLD})
        path = self.state / "deployed.json"
        path.chmod(0o666)
        with self.assertRaises(updater.UpdateError):
            updater.read_json(path)
        self.app.chmod(0o777)
        with self.assertRaises(updater.UpdateError):
            updater.trusted_directory(self.app)

    def test_directory_errors_identify_rejected_path_owner_and_mode(self):
        directory = self.directory / "node"
        directory.mkdir(mode=0o755)
        binary_directory = directory / "bin"
        binary_directory.mkdir(mode=0o755)
        for uid, mode in ((1001, 0o755), (0, 0o775), (0, 0o777)):
            with self.subTest(uid=uid, mode=oct(mode)):
                os.chown(directory, uid, uid)
                directory.chmod(mode)
                with self.assertRaises(updater.UpdateError) as raised:
                    updater.trusted_directory(binary_directory)
                message = str(raised.exception)
                self.assertIn(str(directory), message)
                self.assertIn(f"uid={uid}", message)
                self.assertIn(f"mode={mode:04o}", message)
                self.assertEqual(directory.stat().st_uid, uid)
                self.assertEqual(stat.S_IMODE(directory.stat().st_mode), mode)
        os.chown(directory, 0, 0)
        directory.chmod(0o755)
        link = self.directory / "node-link"
        link.symlink_to(directory, target_is_directory=True)
        with self.assertRaises(updater.UpdateError) as raised:
            updater.trusted_directory(link / "bin")
        self.assertIn(str(link), str(raised.exception))
        self.assertIn("without symlinks", str(raised.exception))

    def test_bootstrap_node_archive_is_usable_by_updater_and_unprivileged_users(self):
        script = Path(__file__).resolve().parents[1] / "scripts/bootstrap-ubuntu.sh"
        directories = ("bin", "lib", "lib/node_modules", "lib/node_modules/npm", "lib/node_modules/npm/bin")
        files = ("bin/node", "lib/node_modules/npm/bin/npm-cli.js")
        for mode in (0o755, 0o777):
            with self.subTest(archive_mode=oct(mode)):
                archive = self.directory / f"node-{mode:o}.tar.xz"
                destination = self.directory / f"node-{mode:o}"
                with tarfile.open(archive, "w:xz") as bundle:
                    for name in (*directories, *files, "bin/npm"):
                        member = tarfile.TarInfo("node-v24.0.0-linux-x64/" + name)
                        member.uid = member.gid = 1001
                        member.mode = mode
                        if name in directories:
                            member.type = tarfile.DIRTYPE
                            bundle.addfile(member)
                        elif name == "bin/npm":
                            member.type = tarfile.SYMTYPE
                            member.linkname = "../lib/node_modules/npm/bin/npm-cli.js"
                            bundle.addfile(member)
                        else:
                            content = b"#!/bin/sh\nexit 0\n"
                            member.size = len(content)
                            bundle.addfile(member, io.BytesIO(content))
                result = subprocess.run(["/bin/bash", "-c",
                    'source "$1"; extract_node_archive "$2" "$3"',
                    "node-extraction-test", str(script), str(archive), str(destination)],
                    env=updater.ENV, capture_output=True, text=True, timeout=15)
                self.assertEqual(result.returncode, 0, result.stderr)
                config = {name: str(destination / "bin" / name) for name in ("node", "npm")}
                updater.CONFIG.write_text(json.dumps(config))
                self.assertEqual(updater.load_config(), config)
                for name in (".", *directories, *files, "bin/npm"):
                    info = (destination / name).lstat()
                    self.assertEqual((info.st_uid, info.st_gid), (0, 0), name)
                    if not stat.S_ISLNK(info.st_mode):
                        self.assertEqual(stat.S_IMODE(info.st_mode), 0o755, name)
                self.assertEqual((destination / "bin/npm").readlink(), Path("../lib/node_modules/npm/bin/npm-cli.js"))

    def test_release_sealing_keeps_internal_links_strips_special_modes_and_git(self):
        release = artifact(self.directory / "candidate")
        (release / ".git").mkdir()
        binary = release / "tool"
        binary.write_text("tool")
        binary.chmod(0o6777)
        (release / "tool-link").symlink_to("tool")
        updater.seal_release(release)
        self.assertEqual(stat.S_IMODE(binary.stat().st_mode), 0o755)
        self.assertEqual(stat.S_IMODE((release / "server/main.js").stat().st_mode), 0o644)
        self.assertEqual(binary.stat().st_uid, 0)
        self.assertEqual((release / "tool-link").readlink(), Path("tool"))
        self.assertFalse((release / ".git").exists())

    def test_escaping_and_dangling_release_links_are_rejected(self):
        for target in ("../../outside", "/etc/passwd", "absent"):
            with self.subTest(target=target):
                release = artifact(self.directory / "candidate")
                link = release / "bad-link"
                link.symlink_to(target)
                try:
                    with self.assertRaisesRegex(updater.UpdateError, "unsafe symlink"):
                        updater.seal_release(release)
                finally:
                    link.unlink()

    def test_hard_links_and_fifos_are_rejected(self):
        release = artifact(self.directory / "candidate")
        os.link(release / "server/main.js", release / "hard-link")
        with self.assertRaisesRegex(updater.UpdateError, "hard link"):
            updater.seal_release(release)
        (release / "hard-link").unlink()
        os.mkfifo(release / "fifo")
        with self.assertRaisesRegex(updater.UpdateError, "special file"):
            updater.seal_release(release)

    def test_branch_tip_validation_and_fixed_repository(self):
        with patch.object(updater, "run", return_value=SimpleNamespace(stdout=f"{REVISION}\t{updater.REF}\n")) as run:
            self.assertEqual(updater.remote_revision(), REVISION)
            command = run.call_args.args[0]
            self.assertEqual(command[-2:], ["https://github.com/M-ax/helltube.git", "refs/heads/main"])
            self.assertIn("protocol.allow=never", command)
            for response in ("", f"{REVISION} HEAD", f"nope {updater.REF}", f"{REVISION} {updater.REF}\n{OLD} HEAD"):
                run.return_value.stdout = response
                with self.assertRaises(updater.UpdateError):
                    updater.remote_revision()

    def test_build_uses_separate_sandbox_no_secrets_and_exact_revision(self):
        def account(name):
            return SimpleNamespace(pw_uid=1234 if name == "helltube-build" else 1235, pw_gid=1234)
        workspace = self.directory / "build"
        workspace.mkdir()
        with patch.object(updater.pwd, "getpwnam", side_effect=account), patch.object(updater, "run") as run:
            self.assertEqual(updater.build_release(workspace, REVISION, self.config), workspace / "app")
            command = run.call_args.args[0]
            for option in ("--uid=helltube-build", "--property=NoNewPrivileges=yes", "--property=ProtectSystem=strict",
                           "--property=KillMode=control-group", "--property=CapabilityBoundingSet=",
                           "--property=InaccessiblePaths=/etc/helltube /var/lib/helltube", "--property=PrivateTmp=yes",
                           "--property=ReadWritePaths=" + str(workspace), "GIT_TERMINAL_PROMPT=0"):
                self.assertIn(option, command)
            self.assertIn("/usr/bin/env", command)
            self.assertIn("-i", command)
            self.assertFalse(any("LoadCredential" in arg or "EnvironmentFile" in arg for arg in command))
            self.assertEqual(command[-4:], [updater.REPOSITORY, updater.REF, REVISION, self.config["npm"]])
            self.assertIn("FETCH_HEAD^{commit}", updater.BUILD_SCRIPT)
            self.assertLess(updater.BUILD_SCRIPT.index('= "$3"'), updater.BUILD_SCRIPT.index('"$4" ci'))
            self.assertIn("--engine-strict", updater.BUILD_SCRIPT)
            self.assertIn('"$4" test', updater.BUILD_SCRIPT)
            self.assertIn('"$4" run build', updater.BUILD_SCRIPT)
            self.assertIn('"$4" prune --omit=dev --ignore-scripts --no-audit --no-fund --engine-strict', updater.BUILD_SCRIPT)
            self.assertEqual(workspace.stat().st_uid, 1234)

    def test_failed_build_stops_transient_service(self):
        account = SimpleNamespace(pw_uid=1234, pw_gid=1234)
        backend = SimpleNamespace(pw_uid=1235, pw_gid=1235)
        with patch.object(updater.pwd, "getpwnam", side_effect=[account, backend]), \
                patch.object(updater, "run", side_effect=[updater.UpdateError("timeout"), SimpleNamespace(returncode=0)]) as run:
            with self.assertRaisesRegex(updater.UpdateError, "timeout"):
                updater.build_release(self.directory, REVISION, self.config)
            command = run.call_args_list[-1].args[0]
            self.assertEqual(command[:2], ["/usr/bin/systemctl", "stop"])
            self.assertTrue(command[2].startswith("helltube-build-"))

    def test_real_build_shell_rejects_changed_tip_and_aborts_on_npm_failures(self):
        # Substitute only the Git/npm command boundaries; execute the exact
        # production shell to check quoting, errexit and command ordering.
        git = """git() {
  case "$*" in
    *' init app') mkdir app ;;
    'rev-parse --verify FETCH_HEAD^{commit}') printf '%s\\n' "$TEST_REVISION" ;;
  esac
}
"""
        for name, tip, failure, expected in (
                ("success", REVISION, "none", ["ci", "test", "run", "prune"]),
                ("racing-tip", OLD, "none", []),
                ("install-failed", REVISION, "ci", ["ci"]),
                ("tests-failed", REVISION, "test", ["ci", "test"]),
                ("build-failed", REVISION, "run", ["ci", "test", "run"]),
                ("prune-failed", REVISION, "prune", ["ci", "test", "run", "prune"])):
            with self.subTest(name=name):
                workspace = self.directory / name
                workspace.mkdir()
                npm = workspace / "npm fixture"
                npm.write_text('#!/bin/sh\nprintf "%s\\n" "$1" >> "$CALLS"\n[ "$1" != "$FAIL" ]\n')
                npm.chmod(0o755)
                calls = workspace / "calls"
                result = subprocess.run(["/bin/sh", "-eu", "-c", git + updater.BUILD_SCRIPT,
                                         "builder", updater.REPOSITORY, updater.REF, REVISION, str(npm)],
                    cwd=workspace, env={**updater.ENV, "TEST_REVISION": tip, "FAIL": failure, "CALLS": str(calls)},
                    capture_output=True, text=True, timeout=10)
                self.assertEqual(result.returncode == 0, name == "success", result.stderr)
                self.assertEqual(calls.read_text().splitlines() if calls.exists() else [], expected)

    def test_run_has_bounded_clean_environment_and_reports_failure(self):
        with patch.object(updater.subprocess, "run", return_value=SimpleNamespace(returncode=1)) as run:
            with self.assertRaisesRegex(updater.UpdateError, "git failed"):
                updater.run(["/usr/bin/git"], timeout=15)
            self.assertEqual(run.call_args.kwargs["env"], updater.ENV)
            self.assertEqual(run.call_args.kwargs["timeout"], 15)
            self.assertNotIn("EDGE_PROXY_SECRET", run.call_args.kwargs["env"])
            run.side_effect = subprocess.TimeoutExpired("git", 15)
            with self.assertRaisesRegex(updater.UpdateError, "timed out"):
                updater.run(["/usr/bin/git"], timeout=15)

    def test_health_requires_three_consecutive_successes(self):
        with patch.object(updater, "active", return_value=True), \
                patch.object(updater, "healthy", side_effect=[True, False, True, True, True]) as health, \
                patch.object(updater.time, "sleep"):
            updater.wait_healthy()
            self.assertEqual(health.call_count, 5)

    def test_health_bypasses_inherited_proxies_and_validates_response(self):
        with patch.object(updater.urllib.request, "build_opener") as build:
            response = build.return_value.open.return_value.__enter__.return_value
            response.status = 200
            response.read.return_value = b'{"ok":true}'
            self.assertTrue(updater.healthy())
            self.assertEqual(build.call_args.args[0].proxies, {})
            build.return_value.open.assert_called_with("http://127.0.0.1:3000/api/health", timeout=2)
            response.read.assert_called_with(8192)
            for body in (b'not JSON', b'[]', b'{"ok":false}', b'{"ok":"true"}'):
                response.read.return_value = body
                self.assertFalse(updater.healthy())

    def test_config_accepts_root_binaries_and_rejects_untrusted_paths(self):
        for name in ("node", "npm"):
            binary = self.directory / name
            binary.write_text("binary")
            binary.chmod(0o755)
        config = {name: str(self.directory / name) for name in ("node", "npm")}
        updater.CONFIG.write_text(json.dumps(config))
        self.assertEqual(updater.load_config(), config)
        (self.directory / "npm").chmod(0o777)
        with self.assertRaisesRegex(updater.UpdateError, "installed system-wide") as raised:
            updater.load_config()
        self.assertIn(str(self.directory / "npm"), str(raised.exception))
        self.assertIn("mode=0777", str(raised.exception))
        updater.CONFIG.write_text('{"node":"/missing"}')
        with self.assertRaises(updater.UpdateError):
            updater.load_config()
        updater.CONFIG.write_text('[]')
        with self.assertRaises(updater.UpdateError):
            updater.load_config()

    def test_health_failures_are_bounded(self):
        with patch.object(updater, "active", return_value=False), patch.object(updater.time, "sleep") as sleep:
            with self.assertRaisesRegex(updater.UpdateError, "health check"):
                updater.wait_healthy()
            self.assertEqual(sleep.call_count, 30)


if __name__ == "__main__":
    unittest.main()