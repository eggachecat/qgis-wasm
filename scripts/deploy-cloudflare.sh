#!/usr/bin/env bash
# Publish the built bundle to Cloudflare Pages, with members larger than Pages' 25 MiB per-file limit on an R2 bucket.
#
#   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… scripts/deploy-cloudflare.sh
#   CF_PAGES_PROJECT=qgis-wasm CF_R2_BUCKET=qgis-wasm-assets \
#   CF_ASSET_BASE=https://assets.example.com CF_R2_FILES=qgis.wasm scripts/deploy-cloudflare.sh
#
# One-time setup (dashboard): enable R2, create the bucket, connect <CF_ASSET_BASE> as the bucket's custom domain,
# add the Pages project's custom domain, and set the bucket CORS to allow GET/HEAD from the Pages origin.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$ROOT"
: "${CLOUDFLARE_API_TOKEN:?set CLOUDFLARE_API_TOKEN (Pages:Edit + Workers R2 Storage:Edit)}"
: "${CLOUDFLARE_ACCOUNT_ID:?set CLOUDFLARE_ACCOUNT_ID}"
PROJECT=${CF_PAGES_PROJECT:-qgis-wasm}
BUCKET=${CF_R2_BUCKET:-qgis-wasm-assets}
: "${CF_ASSET_BASE:?set CF_ASSET_BASE to the bucket custom domain, e.g. https://assets.example.com}"
ASSET_BASE=${CF_ASSET_BASE%/}
R2_FILES=${CF_R2_FILES:-qgis.wasm}
BIN="$ROOT/build/qgis/output/bin"
[ -f "$BIN/qgis.wasm" ] || { echo "no build in $BIN — run scripts/build-qgis.sh first" >&2; exit 1; }
[ -d "$BIN/agent" ] || scripts/stage-web.sh --oss    # the page must be staged into the bundle first

node "$ROOT/scripts/export-static.mjs" --r2-base-url "$ASSET_BASE" --r2-files "$R2_FILES"

IFS=',' read -ra NAMES <<< "$R2_FILES"
for name in "${NAMES[@]}"; do
  [ -z "$name" ] && continue
  echo "→ uploading $name.gz to r2://$BUCKET"
  npx --yes wrangler@latest r2 object put "$BUCKET/$name.gz" --file "$BIN/$name.gz" --content-type application/gzip --remote
done

echo "→ deploying $ROOT/build/pages-static to Pages project $PROJECT"
npx --yes wrangler@latest pages deploy "$ROOT/build/pages-static" --project-name "$PROJECT" --branch main
