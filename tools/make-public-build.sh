#!/usr/bin/env bash
# Produce a public-deployable static build. The default output is dist/.
set -euo pipefail

die() {
  echo "FATAL: $*" >&2
  exit 1
}

is_beneath() {
  local path=$1 base=$2
  [[ "$path" == "$base"/* ]]
}

if (( $# > 1 )); then
  die "usage: $0 [output-directory]"
fi
if (( $# == 1 )) && [[ -z "$1" ]]; then
  die 'output directory must not be empty'
fi

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$(cd "$script_dir/.." && pwd -P)
repo_parent=$(dirname "$repo_root")
user_home=$(cd ~ && pwd -P)
system_tmp=$(cd /tmp && pwd -P)
runtime_tmp=$system_tmp
# macOS places `mktemp -d` beneath this per-user OS directory. Derive it from
# getconf rather than trusting caller-controlled TMPDIR to widen the delete scope.
if detected_tmp=$(getconf DARWIN_USER_TEMP_DIR 2>/dev/null) \
  && [[ -n "$detected_tmp" && -d "$detected_tmp" ]]; then
  runtime_tmp=$(cd "$detected_tmp" && pwd -P)
fi

requested_output=${1-dist}
case "$requested_output" in
  *$'\n'*|*$'\r'*) die 'output directory must not contain line breaks' ;;
esac

if [[ "$requested_output" == /* ]]; then
  output_candidate=$requested_output
else
  output_candidate=$repo_root/$requested_output
fi

# A basename of . or .. makes the requested target a broad directory after
# normalisation. Resolve only through an existing parent so a typo cannot turn
# into an unexpected mkdir/rm target.
while [[ "$output_candidate" != / && "$output_candidate" == */ ]]; do
  output_candidate=${output_candidate%/}
done
output_name=$(basename "$output_candidate")
case "$output_name" in
  ''|.|..|/) die "unsafe output directory: $requested_output" ;;
esac
output_parent_input=$(dirname "$output_candidate")
[[ -d "$output_parent_input" ]] || die "cannot resolve output parent: $output_parent_input"
output_parent=$(cd "$output_parent_input" && pwd -P)
output_dir=$output_parent/$output_name

[[ ! -L "$output_dir" ]] || die "output directory must not be a symbolic link: $output_dir"
[[ ! -e "$output_dir" || -d "$output_dir" ]] || die "output path exists and is not a directory: $output_dir"

case "$output_dir" in
  /|"$user_home"|"$repo_root"|"$repo_parent")
    die "refusing broad output directory: $output_dir"
    ;;
esac

# Limit recursive deletion to an explicit build directory at repository root or
# a leaf below a system temporary root. This rejects repository internals,
# arbitrary user folders, mount roots, and ancestors of this checkout.
if [[ "$output_parent" == "$repo_root" ]]; then
  # Default macOS volumes are case-insensitive: `JS` can resolve to the tracked
  # `js/` directory. Compare a folded ASCII name so case variants cannot bypass
  # the protected-source denylist before the recursive cleanup below.
  output_name_folded=$(LC_ALL=C tr '[:upper:]' '[:lower:]' <<<"$output_name")
  case "$output_name_folded" in
    .claude|.git|.github|.vercel|assets|css|js|lib|licenses|node_modules|sounds|test-results|textures|tools|tests|videos)
      die "refusing repository source directory as build output: $output_dir"
      ;;
  esac
elif is_beneath "$output_dir" "$runtime_tmp" || is_beneath "$output_dir" "$system_tmp"; then
  :
else
  die "output must be a direct child of the repository or beneath a temporary directory: $output_dir"
fi

cd "$repo_root"
echo "building public output at: $output_dir"
rm -rf "$output_dir"
mkdir -p "$output_dir"

# runtime files only
cp index.html README.md LICENSE NOTICE THIRD_PARTY_NOTICES.md "$output_dir/"
cp -R css js lib assets textures LICENSES "$output_dir/"
rm -f "$output_dir/js/data-real.js"
mkdir -p "$output_dir/sounds"
cp sounds/.gitkeep "$output_dir/sounds/"

# Generated service output must remain local.
if find "$output_dir/sounds" -type f -name '*.mp3' | grep -q .; then
  echo 'FATAL: generated sound files leaked into the public bundle' >&2
  exit 1
fi
node --input-type=module --check < "$output_dir/js/data.js"
node --input-type=module --check < "$output_dir/js/ui.js"

echo "public build ready in $output_dir/ ($(du -sh "$output_dir" | cut -f1))"
