#!/usr/bin/env bash
# Produce a public-deployable static build in dist/.
set -euo pipefail
cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

# runtime files only
cp index.html README.md LICENSE NOTICE THIRD_PARTY_NOTICES.md dist/
cp -R css js lib assets textures dist/
rm -f dist/js/data-real.js
mkdir -p dist/sounds
cp sounds/.gitkeep dist/sounds/

# Generated service output must remain local.
if find dist/sounds -type f -name '*.mp3' | grep -q .; then
  echo 'FATAL: generated sound files leaked into the public bundle' >&2
  exit 1
fi
node --input-type=module --check < dist/js/data.js
node --input-type=module --check < dist/js/ui.js

echo "public build ready in dist/ ($(du -sh dist | cut -f1))"
