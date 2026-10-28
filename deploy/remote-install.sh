#!/usr/bin/env bash
# Runs ON the target host (uploaded and started by scripts/deploy.sh). Idempotent.
#   remote-install.sh <stage dir> <install dir> <public url> <port>
# Installs the bundle + serve.mjs under <install dir>, a systemd service (system-wide with sudo, otherwise --user),
# and, when nginx and a certificate are present, the TLS site for the host name of <public url>.
set -euo pipefail
STAGE=$1; DIR=$2; PUBLIC_URL=$3; PORT=${4:-8123}
HOSTNAME_PUBLIC=$(printf '%s' "$PUBLIC_URL" | sed -E 's#^[a-z]+://##; s#[/:].*$##')
# Node: on PATH, or a runtime shipped with an earlier deployment (<install dir>/runtime/node), or an nvm install
NODE=$(command -v node || true)
for cand in "$DIR/runtime/node" "$HOME/.local/share/qgis-wasm/current/runtime/node" "$HOME"/.nvm/versions/node/*/bin/node; do
  [ -n "$NODE" ] && break
  [ -x "$cand" ] && NODE=$cand
done
[ -n "$NODE" ] || { echo "node is not installed on $(hostname); install Node.js >= 18 (apt install nodejs, or copy a node binary to $DIR/runtime/node) and rerun"; exit 2; }
echo "node: $NODE ($("$NODE" --version))"
NODE_MAJOR=$("$NODE" -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
[ "$NODE_MAJOR" -ge 18 ] || { echo "node $("$NODE" --version) is too old (need >= 18)"; exit 2; }
if sudo -n true 2>/dev/null; then SUDO=sudo; else SUDO=""; fi
say() { printf '\n== %s\n' "$*"; }

say "files → $DIR"
if [ -n "$SUDO" ]; then
  $SUDO install -d "$DIR"
  $SUDO rsync -a --delete "$STAGE/bin/" "$DIR/bin/"
  $SUDO install -m 0644 "$STAGE/serve.mjs" "$DIR/serve.mjs"
  id -u qgis-wasm >/dev/null 2>&1 || $SUDO useradd --system --shell /usr/sbin/nologin --home-dir "$DIR" qgis-wasm
  $SUDO chown -R root:root "$DIR"; $SUDO chmod -R a+rX "$DIR"
  SERVICE_USER=qgis-wasm
else
  install -d "$DIR"; rsync -a --delete "$STAGE/bin/" "$DIR/bin/"; install -m 0644 "$STAGE/serve.mjs" "$DIR/serve.mjs"
  SERVICE_USER=$(id -un)
fi

say "systemd service"
render() { sed -e "s#__USER__#$SERVICE_USER#g; s#__DIR__#$DIR#g; s#__NODE__#$NODE#g; s#__PORT__#$PORT#g; s#__PUBLIC_URL__#$PUBLIC_URL#g" "$STAGE/qgis-wasm.service"; }
if [ -n "$SUDO" ]; then
  render | $SUDO tee /etc/systemd/system/qgis-wasm.service >/dev/null
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable --now qgis-wasm.service >/dev/null
  $SUDO systemctl restart qgis-wasm.service
  SYSTEMCTL="$SUDO systemctl"
else
  mkdir -p ~/.config/systemd/user
  render | sed -e '/^User=/d; /^ProtectHome=/d' > ~/.config/systemd/user/qgis-wasm.service
  systemctl --user daemon-reload
  systemctl --user enable --now qgis-wasm.service >/dev/null
  systemctl --user restart qgis-wasm.service
  loginctl enable-linger "$(id -un)" 2>/dev/null || true   # keep it running after logout
  SYSTEMCTL="systemctl --user"
fi
sleep 1.5
$SYSTEMCTL --no-pager --lines=5 status qgis-wasm.service || true
echo
if curl -fsS -o /dev/null -w 'serve.mjs on 127.0.0.1:%{http_code} answered in %{time_total}s\n' "http://127.0.0.1:$PORT/qgis.lazy.json"; then :; else echo "serve.mjs is not answering on 127.0.0.1:$PORT"; exit 3; fi

say "TLS front for $HOSTNAME_PUBLIC"
CERT=${TLS_CERT:-}; KEY=${TLS_KEY:-}
if [ -z "$CERT" ]; then
  for c in "/etc/letsencrypt/live/$HOSTNAME_PUBLIC/fullchain.pem" "/etc/ssl/certs/$HOSTNAME_PUBLIC.crt" "/etc/ssl/certs/$HOSTNAME_PUBLIC.pem" "/etc/pki/tls/certs/$HOSTNAME_PUBLIC.crt"; do [ -r "$c" ] || $SUDO test -r "$c" 2>/dev/null && { CERT=$c; break; }; done
  for k in "/etc/letsencrypt/live/$HOSTNAME_PUBLIC/privkey.pem" "/etc/ssl/private/$HOSTNAME_PUBLIC.key" "/etc/pki/tls/private/$HOSTNAME_PUBLIC.key"; do [ -r "$k" ] || $SUDO test -r "$k" 2>/dev/null && { KEY=$k; break; }; done
fi
if ! command -v nginx >/dev/null || [ -z "$SUDO" ]; then
  echo "nginx not installed or no sudo: serve.mjs is running on 127.0.0.1:$PORT. Point the TLS terminator for https://$HOSTNAME_PUBLIC at it"
  echo "(forward X-Forwarded-Proto/Host, no response buffering); deploy/nginx-qgis.conf is a ready-made nginx site."
  exit 0
fi
if [ -n "$CERT" ] && [ -n "$KEY" ]; then
  TLS="ssl_certificate $CERT;\n    ssl_certificate_key $KEY;\n    ssl_protocols TLSv1.2 TLSv1.3;"
  LISTEN="listen 443 ssl;\n    listen [::]:443 ssl;\n    http2 on;"
  REDIRECT="server {\n    listen 80;\n    listen [::]:80;\n    server_name $HOSTNAME_PUBLIC;\n    return 301 https://\$host\$request_uri;\n}"
  MODE="https://$HOSTNAME_PUBLIC (certificate $CERT)"
else
  TLS="# no certificate found for $HOSTNAME_PUBLIC: plain http on :80 — only usable behind a TLS load balancer\n    # (set TLS_CERT=/path/fullchain.pem TLS_KEY=/path/privkey.pem and rerun scripts/deploy.sh to serve https here)"
  LISTEN="listen 80;\n    listen [::]:80;"
  REDIRECT=""
  MODE="http://$HOSTNAME_PUBLIC:80 (no certificate on this host; TLS must be terminated in front)"
fi
SITE=$(sed -e "s#__SERVER_NAME__#$HOSTNAME_PUBLIC#g; s#__PORT__#$PORT#g" "$STAGE/nginx-qgis.conf" | awk -v tls="$TLS" -v listen="$LISTEN" -v redirect="$REDIRECT" '{ gsub(/__TLS__/, tls); gsub(/__LISTEN__/, listen); gsub(/__TLS_REDIRECT__/, redirect); print }' | sed 's/\\n/\n/g')
if [ -d /etc/nginx/sites-available ]; then
  printf '%s\n' "$SITE" | $SUDO tee /etc/nginx/sites-available/qgis-wasm >/dev/null
  $SUDO ln -sf /etc/nginx/sites-available/qgis-wasm /etc/nginx/sites-enabled/qgis-wasm
else
  printf '%s\n' "$SITE" | $SUDO tee /etc/nginx/conf.d/qgis-wasm.conf >/dev/null
fi
if $SUDO nginx -t 2>&1 | tail -1; then $SUDO systemctl reload nginx; echo "nginx serves $MODE → 127.0.0.1:$PORT"; else echo "nginx config test failed; the site file was installed but nginx was not reloaded"; exit 4; fi
