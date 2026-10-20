# DMDB branding

Source artwork (SVG). Only the PNG icons in `../extension/icons/` ship with the extension.

- `dmdb.svg` - icon on transparent background (indigo chat bubble, database stack, search lens)
- `dmdb-light-tile.svg` / `dmdb-dark-tile.svg` - rounded-square app tiles
- `dmdb-16.svg` - same icon with heavier separators; used only for the 16 px toolbar PNG, where thin lines blur away
- `dmdb-monochrome.svg` - single colour (`currentColor`) variant
- `dmdb-original.svg` - the first version, where the database stack was painted over and only
  the top disc showed. Kept for reference; `dmdb.svg` fixes it by outlining the discs.

Regenerate the PNGs (needs ImageMagick):

    for s in 32 48 128; do magick -background none -density 1024 branding/dmdb.svg -filter Lanczos -resize ${s}x${s} extension/icons/dmdb-$s.png; done
    magick -background none -density 1024 branding/dmdb-16.svg -filter Lanczos -resize 16x16 extension/icons/dmdb-16.png

These are original artwork, not Instagram or Meta marks.
