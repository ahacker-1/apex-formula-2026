#!/usr/bin/env bash
# Exercise custom-output builds and destructive-path guards without touching dist/.
set -euo pipefail

die() {
  echo "BUILD SCRIPT VALIDATION: FAIL: $*" >&2
  exit 1
}

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/.." && pwd -P)
repo_parent=$(dirname "$repo_root")
user_home=$(cd ~ && pwd -P)
build_script=$script_dir/make-public-build.sh

fingerprint_dir() {
  local dir=$1
  if [[ ! -d "$dir" ]]; then
    echo absent
    return
  fi
  (
    cd "$dir"
    find . -type f -print | LC_ALL=C sort | while IFS= read -r file; do
      shasum -a 256 "$file"
    done
  ) | shasum -a 256 | awk '{print $1}'
}

scratch=$(mktemp -d /tmp/apex-build-validation.XXXXXX)
cleanup() {
  rm -rf "$scratch"
}
trap cleanup EXIT

dist_before=$(fingerprint_dir "$repo_root/dist")
output_dir="$scratch/public output"
mkdir -p "$output_dir"
touch "$output_dir/stale-file"
"$build_script" "$output_dir" >"$scratch/build.log"
[[ ! -e "$output_dir/stale-file" ]] || die 'stale custom-output content survived rebuild'

for required in \
  index.html README.md LICENSE NOTICE THIRD_PARTY_NOTICES.md \
  LICENSES/three.js-MIT.txt css js lib assets textures sounds/.gitkeep; do
  [[ -e "$output_dir/$required" ]] || die "missing runtime output: $required"
done
[[ ! -e "$output_dir/js/data-real.js" ]] || die 'private roster leaked into custom output'
[[ ! -e "$output_dir/.env.local" ]] || die 'local environment file leaked into custom output'
[[ ! -e "$output_dir/.vercel" ]] || die 'Vercel project metadata leaked into custom output'
if find "$output_dir/sounds" -type f -name '*.mp3' | grep -q .; then
  die 'generated MP3 leaked into custom output'
fi

dist_after=$(fingerprint_dir "$repo_root/dist")
[[ "$dist_after" == "$dist_before" ]] || die 'dist changed during custom-output validation'

expect_rejected() {
  local label=$1
  shift
  local log=$scratch/reject-$label.log
  set +e
  (
    # If a guard regresses, stop at rm before the requested path can be touched.
    rm() {
      echo '__UNSAFE_RM_CALLED__' >&2
      return 97
    }
    export -f rm
    "$build_script" "$@"
  ) >"$log" 2>&1
  local status=$?
  set -e
  [[ $status -ne 0 ]] || die "unsafe target was accepted: $label"
  if grep -q '__UNSAFE_RM_CALLED__' "$log"; then
    die "unsafe target reached recursive deletion: $label"
  fi
}

expect_rejected empty ''
expect_rejected root /
expect_rejected home "$user_home"
expect_rejected repo "$repo_root"
expect_rejected repo-parent "$repo_parent"
expect_rejected dot .
expect_rejected dot-dot ..
expect_rejected unresolved "$scratch/missing-parent/output"
expect_rejected source-dir js
expect_rejected source-dir-case JS
expect_rejected source-license-dir LICENSES
expect_rejected source-license-dir-case licenses
expect_rejected extra-argument "$scratch/one" "$scratch/two"

mkdir -p "$scratch/real-output"
ln -s "$scratch/real-output" "$scratch/symlink-output"
expect_rejected symlink "$scratch/symlink-output"

echo 'BUILD SCRIPT VALIDATION: PASS'
