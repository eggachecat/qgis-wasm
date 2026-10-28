#!/usr/bin/env bash
# One-command release from a machine that already has the toolchains: incremental build → static site branch → push.
# The CI equivalent is .github/workflows/pages.yml (needs a self-hosted runner).
#
#   scripts/release.sh [--no-build] [--no-push]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
BUILD=1; PUSH=1
for a in "$@"; do case "$a" in --no-build) BUILD=0;; --no-push) PUSH=0;; *) echo "unknown option $a" >&2; exit 2;; esac; done

[ -d "$ROOT/build/qgis/output/bin" ] || { echo "no bundle yet — run scripts/build-qgis.sh first" >&2; exit 1; }
if [ "$BUILD" = 1 ]; then scripts/build-qgis.sh build; fi
scripts/export-pages.sh gh-pages

if [ "$PUSH" = 1 ]; then
  git push origin main
  git push origin gh-pages
  echo "pushed: main $(git rev-parse --short main), gh-pages $(git rev-parse --short gh-pages)"
else
  echo "built gh-pages $(git rev-parse --short gh-pages) (not pushed)"
fi
