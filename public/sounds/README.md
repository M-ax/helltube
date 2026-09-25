# Reaction audio

`mw2-hitmarker.mp3` is the classic Call of Duty hit-marker sound, sourced from
https://github.com/jimppan/Hitmarker/blob/master/sound/hitmarker.mp3.
The original game audio belongs to its respective rights holders.

`metal-pipe.mp3` is the metal pipe falling meme sound, sourced from
https://github.com/pavlo-skobnikov/metal-pipe.nvim/blob/main/lua/metal-pipe/assets/metal-pipe-falling-sound.mp3.
The clip starts at the impact without leading silence and is played only when the pipe reaches the floor.

These files are served locally so reaction playback does not contact a third-party soundboard.

`csgo-flashbang-bounce.mp3` is CS:GO's `grenade_hit1.wav`, converted to MP3 from
https://github.com/sourcesounds/csgo/blob/master/sound/weapons/flashbang/grenade_hit1.wav.
It plays at each floor contact, with quieter subsequent bounces.

`csgo-flashbang-ring.mp3` uses the detonation and ringing from the CS:GO recording at
https://soundxpro.com/sounds/cs-go-flashbang
(https://soundxpro.com/cloud_download/sound_67bc200e8c9b8.mp3).
The opening throw/collisions are trimmed at 0.62 seconds; the ringing tail is extended
with a crossfade and fades over 3.75 seconds to match the whiteout.
Original Counter-Strike audio belongs to Valve.

`biden-one-word.mp3` and `biden-you-know-the-thing.mp3` are short, user-uploaded
Biden speech excerpts sourced from Voicemod Tuna:
- https://tuna.voicemod.net/sound/3ecbd337-ca1c-45ec-abe3-01246f2512af
  (audio: https://us-tuna-sounds-files.voicemod.net/3ecbd337-ca1c-45ec-abe3-01246f2512af-1771630657565.mp3)
- https://tuna.voicemod.net/sound/73335727-ab20-4392-9e1b-bd52c6288e69
  (audio: https://us-tuna-sounds-files.voicemod.net/73335727-ab20-4392-9e1b-bd52c6288e69-1775964939945.mp3)

Four additional Biden soundboard excerpts are sourced from SoundXPro:

| Local file | Clip | Source | Original audio |
| --- | --- | --- | --- |
| `biden-come-on-man.mp3` | Come on, man | [SoundXPro](https://soundxpro.com/sounds/come-on-man-joe-biden) | [MP3](https://soundxpro.com/cloud_download/sound_67bedcdeb0605.mp3) |
| `biden-chocolate-chip.mp3` | Chocolate chocolate chip | [SoundXPro](https://soundxpro.com/sounds/biden-chocolate-chip) | [MP3](https://soundxpro.com/cloud_download/sound_67bede1f5079d.mp3) |
| `biden-corn-pop.mp3` | Corn Pop | [SoundXPro](https://soundxpro.com/sounds/biden-cornpop) | [MP3](https://soundxpro.com/cloud_download/sound_67bff36c3f64f.mp3) |
| `biden-ice-cream.mp3` | I love ice cream | [SoundXPro](https://soundxpro.com/sounds/biden-ice-cream) | [MP3](https://soundxpro.com/cloud_download/sound_67bedb2174f52.mp3) |

These are soundboard excerpts used for the labeled parody reaction; they are not
voice synthesis or a new statement. Original recordings belong to their respective
rights holders. Local copies are normalized to -18 LUFS / -2 dBTP, encoded as mono
96 kbps MP3, and played at 80% of the viewer's volume. No words are reordered or added.
The event ID selects one of six clips per walk, beginning 600 ms after the shared timestamp.
Only the selected clip is downloaded and decoded, and every clip fits inside the 12-second walk.
Late events skip the line; muting, leaving, disabling reactions, or hiding the tab stops it.

`hank-jpeg.mp3` is the progressively distorted **Needs More JPEG** meme edit of
Hank Hill's JPEG / hot-dog line from King of the Hill, sourced from this
[public reupload](https://www.youtube.com/watch?v=j5nZhf8SjXw) of
[the original meme](https://www.youtube.com/watch?v=QEzhxP-pdos).
Hank's voice becomes increasingly crushed and noisy throughout the six-second clip.
The source audio receives a constant -18.37 dB gain adjustment (approximately
-18 LUFS overall), preserving the edit's rising distortion and relative loudness,
and is encoded as mono 96 kbps MP3 at 44.1 kHz.
Original audio belongs to its respective rights holders.
It plays with a 1.6× gain scaled by the viewer's volume, 600 ms after the shared
reaction timestamp. This is a 6 dB boost over the previous playback level; the
normalized clip retains headroom at full viewer volume.
Live frames are JPEG-encoded locally at progressively lower quality and resolution
during the same six-second timeline; normal video returns when it ends. No video is uploaded or transcoded
on the server. Repeated triggers replace the active effect and voice.

`intervention.mp3` contains the original shot and bolt sounds from the
[MW2 green-screen clip](https://www.youtube.com/watch?v=wJ_Igr3Y0Os),
normalized to -18 LUFS / -2 dBTP and encoded as mono 96 kbps MP3.
It follows the MLG overlay after its 600 ms entrance, at 80% of viewer volume.
Spray paint uses a locally synthesized high-frequency aerosol hiss, with no asset downloads.
