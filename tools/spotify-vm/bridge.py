#!/usr/bin/env python3
"""Restricted SSH command: control Spotify and send desktop RTP to the QEMU host.

No HTTP listener, passwords, arbitrary commands, or arbitrary media destinations.
Closing SSH, losing the heartbeat, or disabling sharing stops capture.
"""
import json
import fcntl
import os
from pathlib import Path
import re
import select
import signal
import subprocess
import sys
import time

os.environ.update(DISPLAY=":0", XAUTHORITY="/home/spotify/.Xauthority",
                  XDG_RUNTIME_DIR="/run/user/1000",
                  DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/1000/bus",
                  PULSE_SERVER="unix:/run/user/1000/pulse/native")
ARMED = Path.home() / ".config/helltube/sharing-enabled"
URI = re.compile(r"spotify:(track|album|playlist|artist|episode|show):[A-Za-z0-9]{22}\Z")


def player(*args, optional=False):
    result = subprocess.run(["playerctl", "--player=spotify", *args],
                            capture_output=True, text=True, timeout=5)
    if result.returncode and not optional:
        raise ValueError("Spotify is not ready. Sign in on the private desktop first.")
    return result.stdout.strip() if not result.returncode else ""


def status():
    state = player("status", optional=True)
    url = player("metadata", "xesam:url", optional=True)
    return {"enabled": ARMED.is_file(), "available": bool(state),
            "playback": state, "url": url[:300]}


def integer(value, maximum=65535):
    if type(value) is not int or not 0 < value <= maximum:
        raise ValueError("Invalid capture transport")
    return value


def destination(track):
    port = integer(track.get("port"))
    rtcp = integer(track.get("rtcpPort"))
    return f"rtp://10.0.2.2:{port}?rtcpport={rtcp}&pkt_size=1200"


def capture_args(video, audio):
    video_target, audio_target = destination(video), destination(audio)
    video_ssrc, audio_ssrc = [str(integer(track.get("ssrc"), 2147483647)) for track in (video, audio)]
    return ["ffmpeg", "-hide_banner", "-loglevel", "warning", "-nostdin",
            # Raw 720p frames are 3.5 MiB each; 512 queued frames can OOM the VM.
            "-thread_queue_size", "8", "-f", "x11grab", "-framerate", "30",
            "-video_size", "1280x720", "-i", ":0.0",
            # Read 20 ms of stereo s16 PCM per fragment, matching an Opus packet.
            "-thread_queue_size", "64", "-f", "pulse", "-sample_rate", "48000",
            "-channels", "2", "-fragment_size", "3840", "-i", "helltube.monitor",
            "-map", "0:v:0", "-an", "-c:v", "libx264", "-threads", "2",
            "-preset", "veryfast", "-tune", "zerolatency", "-profile:v", "baseline",
            "-level", "3.1", "-pix_fmt", "yuv420p", "-b:v", "2500k",
            "-maxrate", "3000k", "-bufsize", "1500k", "-g", "30",
            "-keyint_min", "30", "-sc_threshold", "0", "-f", "rtp",
            "-payload_type", "102", "-ssrc", video_ssrc, video_target,
            # Pulse's wall-clock latency corrections can move timestamps backward.
            # Count PCM samples instead, retaining the initial audio/video offset.
            "-map", "1:a:0", "-vn", "-af", "asetpts=N/SR/TB+STARTPTS",
            "-c:a", "libopus", "-b:a", "128k", "-ac", "2", "-ar", "48000",
            "-application", "lowdelay", "-frame_duration", "20", "-flush_packets", "1", "-f", "rtp",
            "-payload_type", "111", "-ssrc", audio_ssrc, audio_target]


class Bridge:
    def __init__(self):
        self.capture = None
        self.last_request = time.monotonic()

    def stop(self):
        process, self.capture = self.capture, None
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=2)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

    def request(self, message):
        action = message.get("action")
        self.last_request = time.monotonic()
        if action == "stop":
            self.stop()
            player("pause", optional=True)
            return {}
        current = status()
        if action == "status":
            if self.capture and (not current["enabled"] or not current["url"]):
                self.stop()
            return {**current, "capturing": self.capture is not None and self.capture.poll() is None}
        if not current["enabled"]:
            raise ValueError("Enable Helltube sharing on the private Spotify desktop first.")
        if action == "open":
            uri = message.get("uri", "")
            if not isinstance(uri, str) or not URI.fullmatch(uri):
                raise ValueError("Invalid Spotify URI")
            self.stop()
            player("open", uri)
            player("play")
            return {}
        if action == "capture":
            if not current["url"]:
                raise ValueError("Start Spotify playback on the private desktop first.")
            args = capture_args(message.get("video", {}), message.get("audio", {}))
            self.stop()
            # No media is recorded. Encoder diagnostics stay inside the VM.
            log = Path.home() / ".cache/helltube-capture.log"
            log.parent.mkdir(parents=True, exist_ok=True)
            with log.open("w") as output:
                self.capture = subprocess.Popen(args, stdin=subprocess.DEVNULL,
                                                stdout=subprocess.DEVNULL, stderr=output)
            return {}
        if action in ("play", "pause"):
            player(action)
            return {}
        raise ValueError("Unknown desktop action")

    def run(self):
        buffer = b""
        try:
            while True:
                if self.capture and (not ARMED.is_file() or time.monotonic() - self.last_request > 10):
                    self.stop()
                    player("pause", optional=True)
                readable, _, _ = select.select([sys.stdin], [], [], 0.5)
                if not readable:
                    continue
                chunk = os.read(sys.stdin.fileno(), 16384)
                if not chunk:
                    break
                buffer += chunk
                if len(buffer) > 65536:
                    break
                while b"\n" in buffer:
                    line, buffer = buffer.split(b"\n", 1)
                    if len(line) > 16384:
                        return
                    request_id = None
                    try:
                        message = json.loads(line)
                        request_id = message.get("id")
                        if not isinstance(request_id, str) or len(request_id) > 80:
                            raise ValueError("Invalid request ID")
                        data = self.request(message)
                        response = {"id": request_id, "data": data}
                    except (ValueError, AttributeError, TypeError, OSError, subprocess.SubprocessError) as error:
                        response = {"id": request_id, "error": str(error)[:300]}
                    print(json.dumps(response), flush=True)
        finally:
            was_capturing = self.capture is not None
            self.stop()
            if was_capturing:
                player("pause", optional=True)


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    with open("/run/user/1000/helltube-bridge.lock", "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        Bridge().run()
