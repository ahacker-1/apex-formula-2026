# Asset provenance

This inventory defines which non-code files are included in the Apache-2.0
project release and how they were created.

| Path | Origin | License status |
| --- | --- | --- |
| `assets/f1car-2026.glb` | Project-authored model generated from `tools/blender/build_car.py` | Apache-2.0 |
| `textures/*.png` | Original environment artwork created for this project | Apache-2.0 |
| `textures/hdri/*.hdr` | Original environment lighting created for this project | Apache-2.0 |
| `js/textures.js` output | Procedural Canvas textures generated at runtime by project code | Apache-2.0 |

The repository does not include third-party team logos, sponsor art, driver
likenesses, broadcast footage, map tiles, or generated sound-effect binaries.

## Optional local audio

`tools/gen-sounds.sh` and `tools/regen-clean-sounds.py` can create local audio
through ElevenLabs. Those outputs are not project release assets, are excluded
by `.gitignore`, and are governed by the account and service terms under which
they are generated. The application works without them through its synthesized
WebAudio fallback.

Contributors must update this file when adding a binary asset and must retain
source evidence outside the repository when a license or permission requires it.
