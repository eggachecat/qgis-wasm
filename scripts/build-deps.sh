#!/usr/bin/env bash
# Build every third-party dependency (Qt 6 for WebAssembly, GDAL, PROJ, GEOS, QScintilla, ...) with vcpkg.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
source "$ROOT/scripts/env.sh"
cd "$ROOT"
"$VCPKG_ROOT/vcpkg" install \
  --x-install-root="$VCPKG_INSTALLED" \
  --triplet "$VCPKG_TRIPLET" \
  --overlay-triplets=build/vcpkg-triplets \
  --overlay-ports=build/vcpkg-ports "$@"
