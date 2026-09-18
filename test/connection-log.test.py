import importlib.util
import json
import pathlib
import unittest

spec = importlib.util.spec_from_file_location("connection_log", pathlib.Path(__file__).resolve().parents[1] / "scripts/connection-log.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class ConnectionLogTest(unittest.TestCase):
    def test_nginx_error_preserves_cause_and_correlation_without_request_secrets(self):
        event = module.classify(b'<131>Sep 18 04:00:00 metal helltube_nginx: 5#5: *42 connect() failed (111: Connection refused) while connecting to upstream, client: 1.2.3.4, request: "GET /direct/secret?token=secret HTTP/1.1", upstream: "http://user:secret@host/", host: "secret"')
        self.assertEqual(event, {"event": "nginx.error", "severity": 3, "cause": "connection-refused", "errno": 111, "connection": 42})
        self.assertNotIn("secret", json.dumps(event))

    def test_proxy_connect_and_failures(self):
        for message, cause in [
            ('Request (file descriptor 7): CONNECT rr.googlevideo.com:443 HTTP/1.1', 'connect-request'),
            ('Established connection to host "secret" using file descriptor 8.', 'connection-established'),
            ('Could not resolve host secret: getaddrinfo failed', 'dns-failure'),
            ('read: Connection reset by peer secret', 'connection-reset'),
            ('Connection timed out secret', 'timeout'),
            ('unexpected raw cookie SID=secret', 'unclassified'),
        ]:
            event = module.classify(('<30>Sep 18 04:00:00 tinyproxy[123]: ' + message).encode())
            self.assertEqual(event['cause'], cause)
            self.assertEqual(event['pid'], 123)
            self.assertNotIn('secret', json.dumps(event))

    def test_untrusted_context_cannot_override_error_category(self):
        event = module.classify(b'<131>metal helltube_nginx: *8 upstream prematurely closed connection, request: "GET /connection-refused?secret HTTP/1.1"')
        self.assertEqual(event['cause'], 'upstream-closed')
        self.assertEqual(module.classify(b'cookie=secret'), {'event': 'connection-log.unrecognized'})
        self.assertEqual(module.classify(b'tinyproxy[' + b'9' * 5000 + b']: secret'), {'event': 'connection-log.unrecognized'})


if __name__ == '__main__':
    unittest.main()
