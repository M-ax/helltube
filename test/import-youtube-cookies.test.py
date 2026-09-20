"""Offline validation tests; no server paths or services are accessed."""
import importlib.util
from pathlib import Path
import sys
import os
import stat
import subprocess
import tempfile
import json
import unittest
from types import SimpleNamespace
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location('cookie_importer', Path(__file__).resolve().parents[1] / 'scripts' / 'import-youtube-cookies.py')
importer = importlib.util.module_from_spec(spec)
spec.loader.exec_module(importer)
VALID = b'# Netscape HTTP Cookie File\n#HttpOnly_.youtube.com\tTRUE\t/\tTRUE\t2147483647\tSID\tsynthetic\n'
USER_AGENT = b'# Helltube-User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/153.0.0.0 Safari/537.36\n'


class CookieImportTests(unittest.TestCase):
    @unittest.skipUnless(sys.platform == 'linux', 'Executable receiver needs Linux')
    def test_installed_receiver_starts_with_its_shebang(self):
        with tempfile.TemporaryDirectory() as directory:
            executable = Path(directory) / 'helltube-import-cookies'
            executable.write_bytes(Path(importer.__file__).read_bytes())
            executable.chmod(0o700)
            result = subprocess.run([str(executable)], input=b'private-session', capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b'')
            self.assertEqual(result.stderr, b'Cookie import failed. Check configuration, permissions and service state.\n')

    def test_effective_live_cookie_path_is_checked_through_dbus(self):
        expected = f'YTDLP_COOKIES_FILE={importer.DESTINATION}'
        for kind, entries, allowed in [('as', [expected], True), ('as', [], False),
                                       ('as', ['YTDLP_COOKIES_FILE=/run/credentials/helltube.service/youtube-cookies'], False),
                                       ('as', [expected, expected], False), ('a(ss)', [expected], False)]:
            result = subprocess.CompletedProcess([], 0, json.dumps({'type': kind, 'data': entries}).encode(), b'')
            with self.subTest(entries=entries), patch.object(importer.subprocess, 'run', return_value=result) as run:
                self.assertEqual(importer.credentials_configured(), allowed)
                self.assertEqual(run.call_args.args[0][0], '/usr/bin/busctl')
                self.assertIn('Environment', run.call_args.args[0])

    def test_running_process_must_have_migrated_from_the_credential_snapshot(self):
        result = subprocess.CompletedProcess([], 0, b'ActiveState=active\nMainPID=123\n', b'')
        for environment, allowed in [(f'YTDLP_COOKIES_FILE={importer.DESTINATION}\0'.encode(), True),
                                     (b'YTDLP_COOKIES_FILE=/run/credentials/helltube.service/youtube-cookies\0', False),
                                     (b'UNRELATED=private\0', False)]:
            with self.subTest(allowed=allowed), patch.object(importer, 'systemctl', return_value=result), \
                    patch.object(Path, 'read_bytes', return_value=environment) as read:
                self.assertEqual(importer.running_credentials_configured(), allowed)
                read.assert_called_once()

    def test_service_state_checks_are_read_only_and_fail_closed(self):
        for state, pid, allowed in [('inactive', '0', True), ('failed', '0', True), ('inactive', '123', False),
                                    ('activating', '123', False), ('deactivating', '123', False), ('active', '0', False)]:
            result = subprocess.CompletedProcess([], 0, f'ActiveState={state}\nMainPID={pid}\n'.encode(), b'')
            with self.subTest(state=state, pid=pid), patch.object(importer, 'systemctl', return_value=result) as run, \
                    patch.object(Path, 'read_bytes') as read:
                self.assertEqual(importer.running_credentials_configured(), allowed)
                self.assertEqual(run.call_args.args[0], 'show')
                read.assert_not_called()

    def test_valid_export(self):
        self.assertEqual(importer.validate(VALID), VALID)
        self.assertEqual(importer.validate(VALID.replace(b'\n', b'\r\n')), VALID.replace(b'\n', b'\r\n'))

    def test_user_agent_comment_is_preserved_and_compatible_with_netscape(self):
        from http.cookiejar import MozillaCookieJar
        data = VALID.replace(b'\n', b'\n' + USER_AGENT, 1)
        self.assertEqual(importer.validate(data), data)
        self.assertEqual(importer.validate(data.replace(b'\n', b'\r\n')), data.replace(b'\n', b'\r\n'))
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / 'cookies.txt'
            source.write_bytes(data)
            jar = MozillaCookieJar(str(source))
            jar.load()
            self.assertEqual([(cookie.name, cookie.value) for cookie in jar], [('SID', 'synthetic')])

    def test_invalid_or_duplicate_user_agent(self):
        for comment in [USER_AGENT + USER_AGENT, b'# Helltube-User-Agent: \n', b'# Helltube-User-Agent:no-space\n',
                        b'# Helltube-User-Agent: x\rInjected: secret\n', b'# Helltube-User-Agent: x\tx\n',
                        b'# Helltube-User-Agent: ' + b'x' * 1025 + b'\n', b'# Helltube-User-Agent: x\xc3\xa9\n']:
            with self.subTest(comment=comment[:50]), self.assertRaises(ValueError):
                importer.validate(VALID + comment)

    def test_invalid_exports(self):
        for data in [b'', b'x' * importer.LIMIT, VALID.replace(b'youtube.com', b'google.com'),
                     VALID.replace(b'youtube.com', b'youtube.com.attacker.test'),
                     VALID.replace(b'youtube.com', b'bad_.youtube.com'), VALID.replace(b'TRUE', b'FALSE', 1),
                     VALID.replace(b'SID', b'VISITOR_INFO1_LIVE'), VALID.replace(b'2147483647', b'1'),
                     VALID.replace(b'synthetic', b'value\tinjected'), VALID.replace(b'synthetic', b'value\x00'),
                     VALID.replace(b'HTTP Cookie File', b'Invalid')]:
            with self.subTest(data=data[:70]), self.assertRaises((ValueError, UnicodeError)):
                importer.validate(data)

    def test_stdin_failures_are_redacted(self):
        import io
        from contextlib import redirect_stderr
        stderr = io.StringIO()
        with patch.object(sys, 'argv', ['importer']), patch.object(sys, 'stdin', io.TextIOWrapper(io.BytesIO(b'private-session'))), redirect_stderr(stderr):
            self.assertEqual(importer.main(), 1)
        self.assertNotIn('private-session', stderr.getvalue())


@unittest.skipUnless(sys.platform == 'linux' and os.geteuid() == 0, 'POSIX transaction tests need a root-owned Linux fixture')
class ImportTransactionTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='helltube-cookie-test-')
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name)
        self.secret_dir = self.root / 'cookies'
        self.secret_dir.mkdir(mode=0o750)
        self.secret_dir.chmod(0o750)
        self.gid = 65534
        os.chown(self.secret_dir, 0, self.gid)
        self.destination = self.secret_dir / 'youtube-cookies.txt'
        self.previous = VALID.replace(b'synthetic', b'previous')
        self.destination.write_bytes(self.previous)
        self.destination.chmod(0o640)
        os.chown(self.destination, 0, self.gid)
        self.calls = []
        self.state = b'ActiveState=inactive\nMainPID=0\n'
        import grp
        patcher = patch.object(grp, 'getgrnam', return_value=SimpleNamespace(gr_gid=self.gid))
        patcher.start()
        self.addCleanup(patcher.stop)
        for name, value in [('DESTINATION', self.destination), ('LOCK', str(self.root / 'deploy.lock'))]:
            patcher = patch.object(importer, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        original = importer.trusted_directory

        def trusted(directory, gid=None):
            # /tmp is intentionally writable; only bypass that ancestor for this fixture.
            if directory == Path(tempfile.gettempdir()):
                return
            return original(directory, gid)

        patcher = patch.object(importer, 'trusted_directory', trusted)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(importer, 'systemctl', self.systemctl)
        patcher.start()
        self.addCleanup(patcher.stop)
        patcher = patch.object(importer, 'credentials_configured', return_value=True)
        patcher.start()
        self.addCleanup(patcher.stop)

    def systemctl(self, *arguments):
        self.calls.append(arguments)
        self.assertEqual(arguments[0], 'show', 'Cookie refresh must never change service state')
        return subprocess.CompletedProcess(arguments, 0, self.state, b'')

    def test_atomic_import_without_restart(self):
        data = VALID + USER_AGENT
        importer.install(importer.validate(data))
        self.assertEqual(self.destination.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o640)
        self.assertEqual(self.destination.stat().st_uid, 0)
        self.assertEqual(self.destination.stat().st_gid, self.gid)
        self.assertTrue(all(call[0] == 'show' for call in self.calls))
        self.assertEqual(list(self.secret_dir.iterdir()), [self.destination])

    def test_unchanged_export_does_not_restart(self):
        inode = self.destination.stat().st_ino
        importer.install(self.previous)
        self.assertEqual(self.destination.stat().st_ino, inode)

    def test_stopped_service_stays_stopped(self):
        for state in ('inactive', 'failed'):
            self.state = f'ActiveState={state}\nMainPID=0\n'.encode()
            importer.install(VALID)
            self.assertEqual(self.destination.read_bytes(), VALID)

    def test_failed_atomic_replace_preserves_previous_export(self):
        with patch.object(importer.os, 'replace', side_effect=OSError('fixture failure')):
            with self.assertRaises(OSError):
                importer.install(VALID + USER_AGENT)
        self.assertEqual(self.destination.read_bytes(), self.previous)
        self.assertEqual(list(self.secret_dir.iterdir()), [self.destination])

    def test_an_open_reader_keeps_its_snapshot_across_refresh(self):
        with self.destination.open('rb') as existing:
            importer.install(VALID + USER_AGENT)
            self.assertEqual(existing.read(), self.previous)
            self.assertEqual(self.destination.read_bytes(), VALID + USER_AGENT)

    def test_migrated_running_service_refreshes_without_restart(self):
        process = subprocess.Popen([sys.executable, '-I', '-c', 'import time; time.sleep(30)'],
                                   env={**os.environ, 'YTDLP_COOKIES_FILE': str(self.destination)})
        try:
            self.state = f'ActiveState=active\nMainPID={process.pid}\n'.encode()
            importer.install(VALID + USER_AGENT)
            self.assertEqual(self.destination.read_bytes(), VALID + USER_AGENT)
            self.assertIsNone(process.poll())
        finally:
            process.terminate()
            process.wait(timeout=5)

    def test_legacy_running_process_is_not_silently_left_with_stale_cookies(self):
        with patch.object(importer, 'running_credentials_configured', return_value=False):
            with self.assertRaisesRegex(ValueError, 'Enable live YouTube cookies'):
                importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), self.previous)

    def test_group_cannot_overwrite_or_read_other_secrets(self):
        unrelated = self.secret_dir / 'unrelated'
        unrelated.write_bytes(b'private')
        unrelated.chmod(0o600)
        # Traverse the fixture as an unprivileged backend account/group.
        self.root.chmod(0o755)
        code = '''import os, sys
from pathlib import Path
os.setgroups([])
os.setgid(int(sys.argv[2]))
os.setuid(65534)
p = Path(sys.argv[1])
assert p.read_bytes()
for operation in (lambda: p.write_bytes(b'bad'), lambda: p.unlink(),
                  lambda: (p.parent / 'unrelated').read_bytes()):
    try: operation()
    except PermissionError: pass
    else: raise AssertionError('unexpected credential access')
'''
        importer.install(VALID)
        subprocess.run([sys.executable, '-I', '-c', code, str(self.destination), str(self.gid)], check=True)

    def test_symlink_destination_is_rejected(self):
        self.destination.unlink()
        target = self.root / 'unrelated'
        target.write_bytes(b'untouched')
        self.destination.symlink_to(target)
        with self.assertRaisesRegex(ValueError, 'Unsafe existing'):
            importer.install(VALID)
        self.assertEqual(target.read_bytes(), b'untouched')

    def test_world_readable_directory_is_rejected(self):
        self.secret_dir.chmod(0o755)
        with self.assertRaisesRegex(ValueError, 'Unsafe destination'):
            importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), self.previous)

    def test_unsafe_file_permissions_and_hard_links_are_rejected(self):
        for mode in (0o600, 0o660, 0o644):
            self.destination.chmod(mode)
            with self.assertRaisesRegex(ValueError, 'Unsafe existing'):
                importer.install(VALID)
        self.destination.chmod(0o640)
        os.link(self.destination, self.root / 'alias')
        with self.assertRaisesRegex(ValueError, 'Unsafe existing'):
            importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), self.previous)

    def test_disabled_credentials_preserve_existing_file(self):
        with patch.object(importer, 'credentials_configured', return_value=False):
            with self.assertRaisesRegex(ValueError, 'Enable live YouTube cookies'):
                importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), self.previous)

    def test_deployment_lock_prevents_overlap(self):
        import fcntl
        with open(importer.LOCK, 'wb') as lock:
            os.chmod(importer.LOCK, 0o600)
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
            with self.assertRaises(BlockingIOError):
                importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), self.previous)


if __name__ == '__main__':
    unittest.main()
