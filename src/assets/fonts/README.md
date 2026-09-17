# Hack Nerd Font Mono

`HackNerdFontMono-Regular.woff2` is the complete regular face of Hack Nerd Font
Mono, from Nerd Fonts v3.4.0 (Hack 3.003), losslessly converted from TTF to WOFF2
with fontTools. It is served locally; no font service or system installation is
required. The original glyph set, names, and license metadata are preserved.

- Source: https://github.com/ryanoasis/nerd-fonts/tree/v3.4.0/patched-fonts/Hack/Regular
- Original file: `HackNerdFontMono-Regular.ttf`
- Licenses: [HackNerdFont-LICENSE.md](HackNerdFont-LICENSE.md) and
  [NerdFonts-LICENSE.md](NerdFonts-LICENSE.md)

To regenerate from the original TTF with fontTools and Brotli installed:

```python
from fontTools.ttLib import TTFont

font = TTFont('HackNerdFontMono-Regular.ttf')
font.flavor = 'woff2'
font.save('HackNerdFontMono-Regular.woff2')
```
