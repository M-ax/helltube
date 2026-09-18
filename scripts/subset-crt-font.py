"""Regenerate the small CRT font with fontTools[woff] installed."""

from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

fonts = Path(__file__).resolve().parent.parent / "src" / "assets" / "fonts"
font = TTFont(fonts / "HackNerdFontMono-Regular.woff2")
options = subset.Options()
options.name_IDs = ["*"]
options.name_legacy = True
options.name_languages = ["*"]
subsetter = subset.Subsetter(options=options)
# Keep in sync with the subset's unicode-range in CrtScreen.svelte.
subsetter.populate(unicodes=[
    *range(0x250), *range(0x2000, 0x2070), *range(0x2190, 0x2200),
    *range(0x2500, 0x25A0), 0x25CF, 0xE0B0, 0xF115, 0xF120, 0xF303,
])
subsetter.subset(font)
font.flavor = "woff2"
font.save(fonts / "HackNerdFontMono-CRT.woff2")
