#!/usr/bin/env bash
# Deploy the built bundle to a host over ssh: refresh the shell/agent files and the .br/.gz sidecars in
# build/qgis/output/bin, rsync them with scripts/serve.mjs and deploy/* to the host, then run deploy/remote-install.sh
# there (systemd service in --shared mode on 127.0.0.1:<port>, nginx TLS site when a certificate is present).
#
#   scripts/deploy.sh [ssh host] [public url] [install dir = /srv/qgis-wasm] [port = 8123]
#   TLS_CERT=/etc/ssl/x.pem TLS_KEY=/etc/ssl/x.key scripts/deploy.sh my-host https://qgis.example.com   # certificate paths on the host
#
# Defaults for the arguments come from internal/deploy.env when that file exists (DEPLOY_HOST, PUBLIC_URL, INSTALL_DIR,
# PORT) — a deployment keeps its own values there, outside the open-source tree.
# Rerun after every build or shell change; it only transfers what changed (rsync). Needs: ssh access, rsync on both ends,
# Node.js >= 18 on the host (on PATH, as <install dir>/runtime/node, or via nvm); sudo on the host for a system service /
# nginx (without it, a --user service on <port>, e.g. install dir ~/.local/share/qgis-wasm/current with a shipped runtime/node).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
[ -f "$ROOT/internal/deploy.env" ] && source "$ROOT/internal/deploy.env"
HOST=${1:-${DEPLOY_HOST:-}}; PUBLIC_URL=${2:-${PUBLIC_URL:-}}; DIR=${3:-${INSTALL_DIR:-/srv/qgis-wasm}}; PORT=${4:-${PORT:-8123}}
[ -n "$HOST" ] && [ -n "$PUBLIC_URL" ] || { echo "usage: scripts/deploy.sh <ssh host> <public url> [install dir] [port]  (or set them in internal/deploy.env)"; exit 2; }
BIN="$ROOT/build/qgis/output/bin"
STAGE_REMOTE="~/.qgis-wasm-deploy"
[ -f "$BIN/qgis.wasm" ] || { echo "no build in $BIN — run scripts/build-qgis.sh first"; exit 1; }
command -v rsync >/dev/null || { echo "rsync is required"; exit 1; }

echo "== bundle: web layers (+ internal overlay when present), sidecars"
"$ROOT/scripts/stage-web.sh" --compress

echo "== upload → $HOST:$STAGE_REMOTE"
ssh "$HOST" "mkdir -p $STAGE_REMOTE/bin"
rsync -az --delete --info=stats1 "$BIN/" "$HOST:$STAGE_REMOTE/bin/" | grep -E "Number of (regular files transferred|created)|Total transferred" || true
rsync -az "$ROOT/scripts/serve.mjs" "$ROOT/deploy/qgis-wasm.service" "$ROOT/deploy/nginx-qgis.conf" "$ROOT/deploy/remote-install.sh" "$HOST:$STAGE_REMOTE/"

echo "== install on $HOST"
ssh -t "$HOST" "TLS_CERT='${TLS_CERT:-}' TLS_KEY='${TLS_KEY:-}' bash $STAGE_REMOTE/remote-install.sh $STAGE_REMOTE $DIR $PUBLIC_URL $PORT"

echo
echo "== check from here"
if curl -fsS -o /dev/null -m 20 -w "$PUBLIC_URL/qgis.lazy.json → %{http_code} in %{time_total}s\n" "$PUBLIC_URL/qgis.lazy.json"; then
  echo "open $PUBLIC_URL/  ·  MCP: each page shows its endpoint under Plugins → Share → \"Copy MCP endpoint of this page\""
else
  echo "$PUBLIC_URL is not reachable from this machine (DNS / firewall / TLS front not up yet) — on the host, serve.mjs answers on 127.0.0.1:$PORT"
fi
