#!/usr/bin/python3 -I
"""Fixed-purpose, root-owned SSH receiver. Cookie data is read only from stdin."""
import os
import json
from pathlib import Path
import re
import stat
import subprocess
import sys
import tempfile
import time

DESTINATION = Path('/etc/helltube-cookies/youtube-cookies.txt')
LOCK = '/run/lock/helltube-deploy.lock'
LIMIT = 1048576
USER_AGENT_MARKER = '# Helltube-User-Agent:'


def validate(data):
    if not data or len(data) >= LIMIT:
        raise ValueError('Invalid export size.')
    text = data.decode('utf-8')
    lines = text.split('\n')
    if lines[0].rstrip('\r') not in ('# Netscape HTTP Cookie File', '# HTTP Cookie File'):
        raise ValueError('Invalid export header.')
    authenticated = False
    user_agent = None
    count = 0
    for raw in lines[1:]:
        line = raw.removesuffix('\r')
        if re.search(r'[\x00-\x08\x0b-\x1f\x7f]', line):
            raise ValueError('Invalid export characters.')
        if line.startswith(USER_AGENT_MARKER):
            value = line[len(USER_AGENT_MARKER) + 1:]
            if (user_agent is not None or not line.startswith(USER_AGENT_MARKER + ' ') or
                    not re.fullmatch(r'[\x20-\x7e]{1,1024}', value) or value != value.strip()):
                raise ValueError('Invalid browser user agent.')
            user_agent = value
            continue
        if not line or (line.startswith('#') and not line.startswith('#HttpOnly_')):
            continue
        fields = line.removeprefix('#HttpOnly_').split('\t')
        if len(fields) != 7:
            raise ValueError('Invalid cookie record.')
        domain, subdomains, cookie_path, secure, expires, name, value = fields
        host = domain.removeprefix('.').lower()
        labels = host.split('.')
        if (len(host) > 253 or not (host == 'youtube.com' or host.endswith('.youtube.com')) or
                any(len(label) > 63 or not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]*[a-z0-9])?', label) for label in labels) or
                subdomains not in ('TRUE', 'FALSE') or (subdomains == 'TRUE') != domain.startswith('.') or
                not cookie_path.startswith('/') or secure not in ('TRUE', 'FALSE') or
                not re.fullmatch(r'[0-9]+', expires) or
                not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name)):
            raise ValueError('Invalid YouTube cookie record.')
        count += 1
        if name in ('SID', '__Secure-1PSID', '__Secure-3PSID') and value and (int(expires) == 0 or int(expires) > time.time()):
            authenticated = True
    if not count or not authenticated:
        raise ValueError('No current YouTube account cookie.')
    return data


def systemctl(*arguments):
    return subprocess.run(['/usr/bin/systemctl', *arguments], capture_output=True, timeout=10,
                          env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'}, check=False)


def credentials_configured():
    # Only the managed live-file configuration opts in. Never restart an older
    # installation that still consumes a systemd credential snapshot.
    result = subprocess.run(['/usr/bin/busctl', '--json=short', 'get-property', 'org.freedesktop.systemd1',
                             '/org/freedesktop/systemd1/unit/helltube_2eservice',
                             'org.freedesktop.systemd1.Service', 'Environment'],
                            capture_output=True, timeout=10, check=False,
                            env={'PATH': '/usr/sbin:/usr/bin:/sbin:/bin', 'LC_ALL': 'C'})
    if result.returncode:
        return False
    data = json.loads(result.stdout)
    if data.get('type') != 'as' or not isinstance(data.get('data'), list):
        return False
    paths = [entry for entry in data['data'] if isinstance(entry, str) and entry.startswith('YTDLP_COOKIES_FILE=')]
    return paths == [f'YTDLP_COOKIES_FILE={DESTINATION}']


def running_credentials_configured():
    result = systemctl('show', 'helltube.service', '--property=ActiveState', '--property=MainPID')
    if result.returncode:
        return False
    properties = dict(line.split('=', 1) for line in result.stdout.decode().splitlines() if '=' in line)
    if properties.get('ActiveState') in ('inactive', 'failed'):
        return properties.get('MainPID') == '0'
    pid = properties.get('MainPID', '')
    if properties.get('ActiveState') != 'active' or not pid.isdecimal() or int(pid) <= 0:
        return False
    # daemon-reload does not change an existing process's environment. Refuse
    # to claim a live refresh until that process has migrated from the snapshot.
    environment = Path(f'/proc/{pid}/environ').read_bytes().split(b'\0')
    paths = [entry for entry in environment if entry.startswith(b'YTDLP_COOKIES_FILE=')]
    return paths == [f'YTDLP_COOKIES_FILE={DESTINATION}'.encode()]


def trusted_directory(directory, gid=None):
    info = directory.lstat()
    if (not stat.S_ISDIR(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o022 or
            (gid is not None and (info.st_gid != gid or stat.S_IMODE(info.st_mode) != 0o750))):
        raise ValueError('Unsafe destination directory.')


def replace(data, gid):
    fd, temporary = tempfile.mkstemp(prefix='.youtube-cookies-', dir=DESTINATION.parent)
    try:
        with os.fdopen(fd, 'wb') as target:
            target.write(data)
            target.flush()
            os.fchown(target.fileno(), 0, gid)
            os.fchmod(target.fileno(), 0o640)
            os.fsync(target.fileno())
        os.replace(temporary, DESTINATION)
        directory_fd = os.open(DESTINATION.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)


def install(data):
    import fcntl
    import grp
    if os.geteuid() != 0:
        raise ValueError('Run the installed importer through sudo.')
    # Check all ancestors before creating any privileged file.
    for directory in reversed(DESTINATION.parent.parents):
        trusted_directory(directory)
    gid = grp.getgrnam('helltube').gr_gid
    if gid == 0:
        raise ValueError('The Helltube group must not be root.')
    trusted_directory(DESTINATION.parent, gid=gid)
    fd = os.open(LOCK, os.O_WRONLY | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
    with os.fdopen(fd, 'wb') as lock:
        info = os.fstat(lock.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_mode & 0o077 or info.st_nlink != 1:
            raise ValueError('Unsafe deployment lock.')
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if not credentials_configured() or not running_credentials_configured():
            raise ValueError('Enable live YouTube cookies with the updated Helltube bootstrap first.')
        info = DESTINATION.lstat()
        if (not stat.S_ISREG(info.st_mode) or info.st_uid != 0 or info.st_gid != gid or
                stat.S_IMODE(info.st_mode) != 0o640 or info.st_nlink != 1 or info.st_size >= LIMIT):
            raise ValueError('Unsafe existing cookie file.')
        previous = DESTINATION.read_bytes()
        if previous == data:
            return
        replace(data, gid)


def main():
    try:
        if len(sys.argv) != 1:
            raise ValueError('No arguments accepted.')
        os.umask(0o077)
        install(validate(sys.stdin.buffer.read(LIMIT)))
        print('YouTube cookies installed.')
        return 0
    except Exception:
        # Even parser/subprocess errors must never echo input or raw diagnostics.
        print('Cookie import failed. Check configuration, permissions and service state.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
