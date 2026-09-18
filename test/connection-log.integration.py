"""Offline Linux check using a real nginx and the syslog collector on private ports."""
import json
import os
import pathlib
import socket
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]


def port():
    with socket.socket() as sock:
        sock.bind(('127.0.0.1', 0))
        return sock.getsockname()[1]


with tempfile.TemporaryDirectory(prefix='helltube-log-test-') as temporary:
    directory = pathlib.Path(temporary)
    directory.chmod(0o755)
    receiver = socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM)
    receiver.bind(str(directory / 'syslog'))
    os.chmod(directory / 'syslog', 0o666)
    rendered = subprocess.check_output(['bash', '-c', 'source scripts/bootstrap-ubuntu.sh\nrender_nginx metal.example.net'], cwd=ROOT, text=True)
    definitions = rendered[:rendered.index('server {')]
    listen, refused = port(), port()
    config = directory / 'nginx.conf'
    config.write_text(f'''worker_processes 1;
pid {directory}/nginx.pid;
error_log stderr emerg;
events {{ worker_connections 32; }}
http {{
{definitions}
access_log {directory}/access.log helltube_connection;
error_log syslog:server=unix:{directory}/syslog,tag=helltube_nginx warn;
server {{
listen 127.0.0.1:{listen};
location = /api/health {{ return 200 'ok'; }}
location / {{ proxy_pass http://127.0.0.1:{refused}; }}
}}
}}
''')
    processes = []
    try:
        with (directory / 'journal.jsonl').open('w') as journal, (directory / 'nginx-start.log').open('w') as errors:
            processes.append(subprocess.Popen([sys.executable, '-c', 'import runpy,sys; runpy.run_path(sys.argv[1])["main"](int(sys.argv[2]))',
                str(ROOT / 'scripts/connection-log.py'), str(receiver.fileno())], pass_fds=(receiver.fileno(),), stdout=journal))
            processes.append(subprocess.Popen(['nginx', '-p', str(directory), '-c', str(config), '-g', 'daemon off;'], stderr=errors))
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            for attempt in range(100):
                try:
                    with opener.open(f'http://127.0.0.1:{listen}/api/health', timeout=1) as response:
                        assert response.status == 200
                    break
                except OSError:
                    if processes[-1].poll() is not None:
                        raise AssertionError('nginx failed to start; inspect the generated configuration')
                    time.sleep(.05)
            else:
                raise AssertionError('nginx health never became ready')
            request = urllib.request.Request(f'http://127.0.0.1:{listen}/api/private-secret?token=private-secret',
                headers={'Cookie': 'SID=private-secret', 'Authorization': 'Bearer private-secret', 'Referer': 'https://private-secret/'})
            try:
                opener.open(request, timeout=2)
                raise AssertionError('Expected a real upstream refusal')
            except urllib.error.HTTPError as error:
                assert error.code == 502
                error.close()
            for attempt in range(100):
                lines = (directory / 'journal.jsonl').read_text()
                if 'connection-refused' in lines:
                    break
                time.sleep(.05)
            entries = [json.loads(line) for line in lines.splitlines()]
            refused_event = next(e for e in entries if e.get('cause') == 'connection-refused')
            access = (directory / 'access.log').read_text()
            requests = [json.loads(line) for line in access.splitlines()]
            failed = next(e for e in requests if e['status'] == 502)
            assert failed['route'] == 'api'
            assert failed['upstreamStatus'] == '502'
            assert int(failed['connection']) == refused_event['connection']
            assert 'private-secret' not in access + lines
            print('PASS: real nginx 200/502, upstream timing, syslog correlation and credential redaction')
    finally:
        for process in reversed(processes):
            process.terminate()
            process.wait(timeout=5)
        receiver.close()
