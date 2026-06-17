# Assets & Credits

All assets in Bronze Age are free for any use (CC0 / public domain) or generated procedurally. This file tracks every external asset and its source.

## Phase 0

No external asset files yet. Everything on screen is drawn procedurally:

- **Terrain tiles** — solid-colour isometric diamonds drawn with the Canvas 2D API. Palette is hand-picked hex values in `src/render/colors.ts` (original, no licence required).
- **Fonts** — the HUD uses the system monospace stack (`ui-monospace`, SF Mono, Menlo, Consolas). No bundled font files.

## Phase 6 — Audio (slice "audio")

No external audio files. **Every sound effect is synthesised procedurally at
runtime** with the WebAudio API (oscillators + filtered noise) in
`src/audio/SoundBank.ts` — original work, CC0. This was a deliberate choice over
sampled `.wav` packs: zero binary assets to license, a tiny footprint, and a
retro aesthetic that matches the procedural placeholder art. The synth sits
behind a single `play(name)` interface, so swapping in real CC0 samples later is
a drop-in change with no call-site edits.

Covered: unit select, move/attack/build orders, building placement, UI clicks,
bow-fire, melee impact, unit death, building collapse, train/build-complete
chimes, and victory/defeat stings.

## Planned sources (CC0 / public domain)

When real art and audio are added in later phases, prefer these CC0 sources and credit each file here:

- **Kenney.nl** — CC0 game art (isometric tiles, RTS units, UI). https://kenney.nl/assets
- **OpenGameArt.org** — filter by CC0 licence. https://opengameart.org
- **freesound.org** — filter by CC0 licence for SFX. https://freesound.org
- **Sonniss GDC Game Audio bundles** — royalty-free SFX. https://sonniss.com/gameaudiogdc

> Rule: anything committed to this repo must be CC0 or otherwise license-clean, with the source recorded above.
