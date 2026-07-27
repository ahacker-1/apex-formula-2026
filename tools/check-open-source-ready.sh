#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

required=(
  LICENSE NOTICE README.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md
  SUPPORT.md THIRD_PARTY_NOTICES.md ASSET_PROVENANCE.md TRADEMARKS.md
  LICENSES/three.js-MIT.txt .github/PULL_REQUEST_TEMPLATE.md
  .github/ISSUE_TEMPLATE/bug_report.yml
  .github/ISSUE_TEMPLATE/feature_request.yml
  .github/workflows/ci.yml package.json package-lock.json
)

for path in "${required[@]}"; do
  if [[ ! -s "$path" ]]; then
    echo "FATAL: required open-source file is missing or empty: $path" >&2
    exit 1
  fi
done

if ! grep -q 'Apache License' LICENSE || ! grep -q 'Version 2.0' LICENSE; then
  echo 'FATAL: LICENSE is not recognizable as Apache License 2.0' >&2
  exit 1
fi

if ! grep -q 'Copyright 2026 Avi Hacker, J.D.' NOTICE; then
  echo 'FATAL: NOTICE does not identify the project copyright owner' >&2
  exit 1
fi

forbidden='(^|/)(\.env($|\.)|\.vercel($|/)|\.vercel-dist($|/)|data-real\.js$|__pycache__($|/)|[^/]+\.pyc$|[^/]+\.mp3$)'
tracked_forbidden="$(git ls-files | grep -E "$forbidden" || true)"
if [[ -n "$tracked_forbidden" ]]; then
  echo 'FATAL: private, generated, or release-incompatible files are tracked:' >&2
  echo "$tracked_forbidden" >&2
  exit 1
fi

if git grep -nI -E 'apexf1_roster|CLASSIC roster|data-real\.js' -- \
  ':!tools/check-open-source-ready.sh' ':!tools/make-public-build.sh' ':!.gitignore'; then
  echo 'FATAL: private roster references remain in the public source tree' >&2
  exit 1
fi

if git grep -nI -E 'AKIA[0-9A-Z]{16}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY'; then
  echo 'FATAL: a credential-like token is present in a tracked file' >&2
  exit 1
fi

git diff --check HEAD
echo 'OPEN SOURCE READINESS: PASS'
