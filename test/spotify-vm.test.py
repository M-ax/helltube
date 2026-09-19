"""Run with Python and FFmpeg: python -m unittest discover -s test -p 'spotify-vm.test.py'."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import unittest
from unittest.mock import Mock, patch

path = Path(os.environ.get("HELLTUBE_BRIDGE_PATH", Path(__file__).resolve().parents[1] / "tools/spotify-vm/bridge.py"))
spec = importlib.util.spec_from_file_location("spotify_bridge", path)
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class BridgeTests(unittest.TestCase):
    def test_spotify_track_controls_require_opt_in_and_never_stop_capture(self):
        with patch.object(bridge, "status", return_value={"enabled": True}), patch.object(bridge, "player") as player:
            session = bridge.Bridge()
            session.capture = process = Mock()
            for action in ("previous", "next"):
                session.request({"action": action})
                player.assert_called_with(action)
            process.terminate.assert_not_called()
        with patch.object(bridge, "status", return_value={"enabled": False}), patch.object(bridge, "player") as player:
            for action in ("previous", "next"):
                with self.assertRaisesRegex(ValueError, "Enable Helltube"):
                    bridge.Bridge().request({"action": action})
            player.assert_not_called()

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "FFmpeg is required for the video regression")
    def test_full_hd_encoding_and_larger_desktops_preserve_the_entire_frame(self):
        args = bridge.capture_args({"port": 40000, "rtcpPort": 40001, "ssrc": 42},
                                   {"port": 40002, "rtcpPort": 40003, "ssrc": 43})
        self.assertNotIn("-video_size", args[:args.index("-i")], "X11 must capture its full current desktop")
        start = args.index("0:v:0")
        video = ["-map", *args[start:args.index("-f", start)]]
        for size, expected in (("1920x1080", (1920, 1080)), ("2560x1440", (1920, 1080)), ("1280x1024", (1280, 1024))):
            result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                f"testsrc2=size={size}:rate=30:duration=0.1", *video, "-f", "h264", "-"], capture_output=True, timeout=15)
            self.assertEqual(result.returncode, 0, result.stderr)
            probe = subprocess.run(["ffprobe", "-v", "error", "-show_streams", "-of", "json", "-"],
                input=result.stdout, capture_output=True, timeout=10)
            stream = json.loads(probe.stdout)["streams"][0]
            self.assertEqual((stream["width"], stream["height"]), expected)
            self.assertEqual(stream["level"], 40)

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

    def test_track_handoff_preserves_capture_but_normal_open_and_disabled_sharing_do_not(self):
        current = {"enabled": True, "url": "spotify:track:" + "a" * 22}
        with patch.object(bridge, "status", return_value=current), patch.object(bridge, "player") as player:
            session = bridge.Bridge()
            process = session.capture = Mock()
            process.poll.return_value = None
            session.request({"action": "open", "uri": "spotify:track:" + "b" * 22, "keepCapture": True})
            self.assertIs(session.capture, process)
            process.terminate.assert_not_called()
            player.assert_any_call("open", "spotify:track:" + "b" * 22)
            current["enabled"] = False
            with self.assertRaisesRegex(ValueError, "Enable Helltube"):
                session.request({"action": "open", "uri": "spotify:track:" + "c" * 22, "keepCapture": True})
            session.request({"action": "status"})
            process.terminate.assert_called_once()
            current["enabled"] = True
            session.capture = process = Mock()
            process.poll.return_value = None
            session.request({"action": "open", "uri": "spotify:track:" + "d" * 22})
            process.terminate.assert_called_once()

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

    @unittest.skipUnless(shutil.which("ffmpeg"), "FFmpeg is required for the audio bitrate regression")
    def test_music_bitrate_is_high_quality_and_packets_fit_the_rtp_payload(self):
        args = bridge.capture_args({"port": 40000, "rtcpPort": 40001, "ssrc": 42},
                                   {"port": 40002, "rtcpPort": 40003, "ssrc": 43})
        start = args.index("1:a:0")
        audio = ["-map", "0:a:0", *args[start + 1:args.index("-f", start)]]
        result = subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
            "anoisesrc=sample_rate=48000:duration=2:seed=7,aformat=channel_layouts=stereo",
            *audio, "-f", "framecrc", "-"], capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        packets = [[int(value.strip()) for value in line.split(",")[:5]]
                   for line in result.stdout.splitlines() if line and not line.startswith("#")]
        bitrate = sum(packet[4] for packet in packets) * 8 / (sum(packet[3] for packet in packets) / 48000)
        self.assertGreater(bitrate, 256000)
        self.assertLess(bitrate, 360000)
        self.assertLessEqual(max(packet[4] for packet in packets), 1188, "Fit each Opus frame plus the 12-byte RTP header")


if __name__ == "__main__":
    unittest.main()
