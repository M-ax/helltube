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
