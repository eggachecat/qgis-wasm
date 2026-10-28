#!/usr/bin/env bash
# Stage the web layers into the built bundle directory (build/qgis/output/bin by default):
#   web/shell/*  → bin/        web/agent/* → bin/agent/
#   internal/web/* on top (a deployment overlay: brand.js, presets, extra page modules) unless --oss is given, or when
#   this checkout has no internal/ directory (the open-source tree)
# then drops the .br/.gz sidecars that are older than their file (serve.mjs ignores stale ones) and, with --compress,
# regenerates them (scripts/compress-bundle.mjs).
#
#   scripts/stage-web.sh [--oss | --internal] [--compress] [--dir build/qgis/output/bin]
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$ROOT/build/qgis/output/bin"; MODE=auto; COMPRESS=0
while [ $# -gt 0 ]; do case "$1" in --oss) MODE=oss;; --internal) MODE=internal;; --compress) COMPRESS=1;; --dir) BIN="$2"; shift;; *) echo "unknown option $1" >&2; exit 2;; esac; shift; done
[ -d "$BIN" ] || { echo "no bundle directory $BIN — run scripts/build-qgis.sh first" >&2; exit 1; }
if [ "$MODE" = auto ]; then if [ -d "$ROOT/internal/web" ]; then MODE=internal; else MODE=oss; fi; fi
if [ "$MODE" = internal ] && [ ! -d "$ROOT/internal/web" ]; then echo "no internal/ overlay in this checkout" >&2; exit 1; fi
if [ -d "$ROOT/web/shell" ]; then cp -r "$ROOT/web/shell/." "$BIN/"; else cp -r "$ROOT/web/minimal/." "$BIN/"; fi   # (the minimal branch has only web/minimal)
[ -d "$ROOT/web/agent" ] && mkdir -p "$BIN/agent" && cp -r "$ROOT/web/agent/." "$BIN/agent/"
if [ "$MODE" = internal ]; then cp -r "$ROOT/internal/web/." "$BIN/"; fi
# --oss on a checkout that has an overlay: drop what only the overlay ships (left over from an earlier internal staging)
if [ "$MODE" = oss ] && [ -d "$ROOT/internal/web" ]; then (cd "$ROOT/internal/web" && find . -type f) | while IFS= read -r f; do [ -e "$ROOT/web/shell/$f" ] || rm -f "$BIN/$f" "$BIN/$f.br" "$BIN/$f.gz"; done; fi
find "$BIN" -name '__pycache__' -type d -prune -exec rm -rf {} + 2>/dev/null || true
for side in "$BIN"/*.br "$BIN"/*.gz "$BIN"/*/*.br "$BIN"/*/*.gz; do [ -e "$side" ] && [ "${side%.*}" -nt "$side" ] && rm -f "$side"; done
[ "$COMPRESS" = 1 ] && node "$ROOT/scripts/compress-bundle.mjs" | tail -1
echo "staged web layers ($MODE) into $BIN"
