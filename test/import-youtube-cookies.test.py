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

    def test_effective_systemd_credential_is_checked_through_dbus(self):
        expected = ['youtube-cookies', str(importer.DESTINATION)]
        for kind, entries, allowed in [('a(ss)', [expected], True), ('a(ss)', [], False),
                                       ('a(ss)', [['youtube-cookies', '/wrong/path']], False),
                                       ('a(ss)', [expected, expected], False), ('as', [expected], False)]:
            result = subprocess.CompletedProcess([], 0, json.dumps({'type': kind, 'data': entries}).encode(), b'')
            with self.subTest(entries=entries), patch.object(importer.subprocess, 'run', return_value=result) as run:
                self.assertEqual(importer.credentials_configured(), allowed)
                self.assertEqual(run.call_args.args[0][0], '/usr/bin/busctl')
                self.assertIn('LoadCredential', run.call_args.args[0])

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
        self.secret_dir = self.root / '.secrets'
        self.secret_dir.mkdir(mode=0o700)
        self.destination = self.secret_dir / 'youtube-cookies.txt'
        self.previous = VALID.replace(b'synthetic', b'previous')
        self.destination.write_bytes(self.previous)
        self.destination.chmod(0o600)
        self.calls = []
        self.state = b'active\n'
        self.restart_codes = [0]
        for name, value in [('DESTINATION', self.destination), ('LOCK', str(self.root / 'deploy.lock'))]:
            patcher = patch.object(importer, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        original = importer.trusted_directory

        def trusted(directory, private=False):
            # /tmp is intentionally writable; only bypass that ancestor for this fixture.
            if directory == Path(tempfile.gettempdir()):
                return
            return original(directory, private)

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
        if arguments[0] == 'restart':
            return subprocess.CompletedProcess(arguments, self.restart_codes.pop(0), b'', b'')
        output = self.state if '--property=ActiveState' in arguments else ('youtube-cookies:' + str(self.destination)).encode()
        return subprocess.CompletedProcess(arguments, 0, output, b'')

    def test_atomic_import_and_restart(self):
        data = VALID + USER_AGENT
        importer.install(importer.validate(data))
        self.assertEqual(self.destination.read_bytes(), data)
        self.assertEqual(stat.S_IMODE(self.destination.stat().st_mode), 0o600)
        self.assertEqual(self.destination.stat().st_uid, 0)
        self.assertEqual(self.calls[-1], ('restart', 'helltube.service'))
        self.assertEqual(list(self.secret_dir.iterdir()), [self.destination])

    def test_unchanged_export_does_not_restart(self):
        importer.install(self.previous)
        self.assertFalse(any(call[0] == 'restart' for call in self.calls))

    def test_stopped_service_stays_stopped(self):
        self.state = b'inactive\n'
        importer.install(VALID)
        self.assertEqual(self.destination.read_bytes(), VALID)
        self.assertFalse(any(call[0] == 'restart' for call in self.calls))

    def test_failed_restart_restores_previous_export(self):
        self.restart_codes = [1, 0]
        self.previous += USER_AGENT.replace(b'153.', b'152.')
        self.destination.write_bytes(self.previous)
        with self.assertRaisesRegex(ValueError, 'previous cookies restored'):
            importer.install(VALID + USER_AGENT)
        self.assertEqual(self.destination.read_bytes(), self.previous)
        self.assertEqual(sum(call[0] == 'restart' for call in self.calls), 2)

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

    def test_disabled_credentials_preserve_existing_file(self):
        with patch.object(importer, 'credentials_configured', return_value=False):
            with self.assertRaisesRegex(ValueError, 'Enable YouTube cookies'):
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
