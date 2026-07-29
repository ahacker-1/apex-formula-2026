# Third-party notices

## Three.js

The files under `lib/` are vendored from Three.js r160, including its examples
and add-ons.

- Project: <https://threejs.org/>
- Source: <https://github.com/mrdoob/three.js/tree/r160>
- License: MIT
- Copyright: 2010-2023 three.js authors

The full license text is in [`LICENSES/three.js-MIT.txt`](LICENSES/three.js-MIT.txt).

## Playwright

Playwright is installed as a development-only dependency for browser regression
testing. It is not bundled into the deployed game.

- Project: <https://playwright.dev/>
- Source: <https://github.com/microsoft/playwright>
- License: Apache License 2.0

No ElevenLabs-generated audio is included in the open-source repository. The
optional sound-generation tools call an external service; output created with
them is governed by the applicable user account and service terms.
