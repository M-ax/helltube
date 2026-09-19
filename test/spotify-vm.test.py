"""Run inside Linux: python3 -m unittest discover -s test -p 'spotify-vm.test.py'."""
import importlib.util
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import patch

path = Path(os.environ.get("HELLTUBE_BRIDGE_PATH", Path(__file__).resolve().parents[1] / "tools/spotify-vm/bridge.py"))
spec = importlib.util.spec_from_file_location("spotify_bridge", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_disabled_desktop_cannot_capture_or_open_spotify(self):
        with patch.object(bridge, "status", return_value={"enabled": False}), patch.object(bridge, "player") as player:
            for action in ("capture", "open", "play"):
                with self.assertRaisesRegex(ValueError, "Enable Helltube"):
                    bridge.Bridge().request({"action": action})
            player.assert_not_called()

    def test_login_screen_cannot_be_captured(self):
        with patch.object(bridge, "status", return_value={"enabled": True, "url": ""}), patch.object(bridge.subprocess, "Popen") as process:
            with self.assertRaisesRegex(ValueError, "Start Spotify playback"):
                bridge.Bridge().request({"action": "capture"})
            process.assert_not_called()

    def test_invalid_uris_never_reach_the_player(self):
        with patch.object(bridge, "status", return_value={"enabled": True}), patch.object(bridge, "player") as player:
            for uri in ("https://example.com", "spotify:track:x; touch /tmp/unwanted", "spotify:track:" + "a" * 22 + "\n", None):
                with self.assertRaisesRegex(ValueError, "Invalid Spotify URI"):
                    bridge.Bridge().request({"action": "open", "uri": uri})
            player.assert_not_called()

    def test_rtp_destinations_are_fixed_to_the_qemu_host(self):
        video = {"port": 40000, "rtcpPort": 40001, "ssrc": 42, "host": "evil.example"}
        audio = {"port": 40002, "rtcpPort": 40003, "ssrc": 43}
        args = bridge.capture_args(video, audio)
        destinations = [arg for arg in args if arg.startswith("rtp://")]
        self.assertEqual(destinations, ["rtp://10.0.2.2:40000?rtcpport=40001&pkt_size=1200", "rtp://10.0.2.2:40002?rtcpport=40003&pkt_size=1200"])
        for value in (-1, 0, 65536, True, "40000"):
            with self.assertRaises(ValueError):
                bridge.capture_args({**video, "port": value}, audio)

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for the audio timing regression")
    def test_audio_clock_remains_continuous_when_capture_timestamps_jump(self):
        args = bridge.capture_args({"port": 40000, "rtcpPort": 40001, "ssrc": 42},
                                   {"port": 40002, "rtcpPort": 40003, "ssrc": 43})
        start = args.index("1:a:0")
        audio = ["-map", "0:a:0", *args[start + 1:args.index("-f", start)]]
        # Simulate Pulse latency corrections that move time backward and forward.
        # framecrc reports encoded packet timing; it does not store audio.
        result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-copyts",
            "-f", "lavfi", "-i", "sine=sample_rate=48000:samples_per_frame=960:duration=1,"
            "asetpts=PTS+4/TB+0.08/TB*sin(N/960)", *audio, "-f", "framecrc", "-"],
            capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        packets = [[int(value.strip()) for value in line.split(",")[:4]]
                   for line in result.stdout.splitlines() if line and not line.startswith("#")]
        self.assertGreaterEqual(len(packets), 50)
        self.assertAlmostEqual(packets[0][2] / 48000, 4, delta=0.02,
                               msg="Keep the initial A/V offset, allowing Opus encoder delay")
        for previous, current in zip(packets, packets[1:]):
            self.assertEqual(current[2] - previous[2], previous[3], "No gaps or overlaps in encoded audio")
        self.assertTrue(all(packet[3] == 960 for packet in packets[:-1]), "20 ms Opus packets")


if __name__ == "__main__":
    unittest.main()
