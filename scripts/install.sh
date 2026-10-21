#!/usr/bin/env bash
# Install or upgrade the study-kb PocketBase server on Debian.
#
#   sudo scripts/install.sh --nginx                 # behind an existing nginx (writes the site, runs certbot)
#   sudo scripts/install.sh --proxy                 # behind any reverse proxy you configure yourself
#   sudo scripts/install.sh                         # standalone: PocketBase serves :80/:443 itself
#
# Options: --domain ans.mhetsu.com  --port 8090  --version 0.40.5
#
# Run it from a checkout of this repo on the VPS. It is safe to re-run: it
# replaces the binary, hooks and migrations, keeps pb_data, the secret and an
# existing nginx site, and restarts the service (migrations apply on start).
set -euo pipefail

PB_VERSION="0.40.5"
DOMAIN="ans.mhetsu.com"
PORT="8090"
MODE="standalone" # standalone | proxy | nginx
PREFIX="/opt/pocketbase"
ENV_FILE="/etc/pocketbase/env"
UNIT="/etc/systemd/system/pocketbase.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    --nginx) MODE="nginx"; shift ;;
    --proxy|--caddy) MODE="proxy"; shift ;;
    --version) PB_VERSION="$2"; shift 2 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }
die() { echo "error: $*" >&2; exit 1; }

# Who is listening on a TCP port (empty when free). Ignores our own service.
port_owner() {
  ss -ltnpH "sport = :$1" 2>/dev/null | grep -v '"pocketbase"' | sed -n 's/.*users:(("\([^"]*\)".*/\1/p' | sort -u | tr '\n' ' '
}

say "Dependencies"
need=()
for bin in curl unzip openssl sha256sum ss; do command -v "$bin" >/dev/null || need+=("$bin"); done
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq curl unzip openssl coreutils ca-certificates iproute2
fi

say "Preflight ($MODE mode)"
if [ "$MODE" = "standalone" ]; then
  owner="$(port_owner 443)$(port_owner 80)"
  if [ -n "$owner" ]; then
    die "ports 80/443 are already used by: $owner
       Re-run with --nginx (nginx in front) or --proxy (another reverse proxy)."
  fi
else
  owner="$(port_owner "$PORT")"
  [ -z "$owner" ] || die "127.0.0.1:$PORT is already used by: $owner — pick another with --port"
  if [ "$MODE" = "nginx" ]; then
    command -v nginx >/dev/null || die "nginx is not installed; use --proxy or the standalone mode"
  fi
fi
echo "ok"

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

say "System user"
if ! id pocketbase >/dev/null 2>&1; then
  useradd --system --home "$PREFIX" --shell /usr/sbin/nologin pocketbase
fi
install -d -o pocketbase -g pocketbase -m 750 "$PREFIX" "$PREFIX/pb_data"

say "PocketBase v$PB_VERSION ($ARCH)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
ZIP="pocketbase_${PB_VERSION}_linux_${ARCH}.zip"
BASE_URL="https://github.com/pocketbase/pocketbase/releases/download/v${PB_VERSION}"
curl -fsSL -o "$TMP/$ZIP" "$BASE_URL/$ZIP"
curl -fsSL -o "$TMP/checksums.txt" "$BASE_URL/checksums.txt"
(cd "$TMP" && grep " $ZIP\$" checksums.txt | sha256sum -c -) || die "checksum mismatch"
unzip -q -o "$TMP/$ZIP" pocketbase -d "$TMP"
was_active=false
systemctl is-active --quiet pocketbase && was_active=true
install -o root -g root -m 755 "$TMP/pocketbase" "$PREFIX/pocketbase"

say "Hooks and migrations"
rm -rf "$PREFIX/pb_hooks" "$PREFIX/pb_migrations"
cp -r "$REPO_DIR/pb_hooks" "$REPO_DIR/pb_migrations" "$PREFIX/"
chown -R root:pocketbase "$PREFIX/pb_hooks" "$PREFIX/pb_migrations"
chmod -R u=rwX,g=rX,o= "$PREFIX/pb_hooks" "$PREFIX/pb_migrations"

say "Secret ($ENV_FILE)"
install -d -o root -g root -m 755 "$(dirname "$ENV_FILE")"
if [ ! -s "$ENV_FILE" ] || ! grep -qE '^MCP_SECRET=[0-9a-f]{32,}$' "$ENV_FILE"; then
  umask 077
  printf 'MCP_SECRET=%s\n' "$(openssl rand -hex 32)" > "$ENV_FILE"
  echo "generated a new secret"
else
  echo "keeping the existing secret"
fi
chown root:root "$ENV_FILE"
chmod 600 "$ENV_FILE"

say "systemd unit"
if [ "$MODE" = "standalone" ]; then
  SERVE_ARGS="$DOMAIN"
else
  SERVE_ARGS="--http=127.0.0.1:$PORT"
fi
sed "s|@SERVE_ARGS@|$SERVE_ARGS|" "$REPO_DIR/deploy/pocketbase.service" > "$UNIT"
if [ "$MODE" != "standalone" ]; then
  # Behind a proxy no privileged ports are needed.
  sed -i -e 's/^AmbientCapabilities=.*/AmbientCapabilities=/' -e 's/^CapabilityBoundingSet=.*/CapabilityBoundingSet=/' "$UNIT"
fi
systemctl daemon-reload
systemctl enable pocketbase >/dev/null

if [ "$MODE" = "standalone" ] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Firewall"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "opened 80/tcp and 443/tcp in ufw"
fi

say "Starting PocketBase"
if $was_active; then systemctl restart pocketbase; else systemctl start pocketbase; fi
sleep 3
systemctl --no-pager --lines=0 status pocketbase || true

if [ "$MODE" = "nginx" ]; then
  say "nginx site for $DOMAIN"
  SITE="/etc/nginx/sites-available/$DOMAIN.conf"
  if [ -d /etc/nginx/sites-available ] && [ -d /etc/nginx/sites-enabled ]; then
    ENABLED="/etc/nginx/sites-enabled/$DOMAIN.conf"
  else
    SITE="/etc/nginx/conf.d/$DOMAIN.conf"
    ENABLED=""
  fi
  if [ -e "$SITE" ]; then
    echo "keeping existing $SITE (delete it to regenerate)"
  else
    sed -e "s|@DOMAIN@|$DOMAIN|g" -e "s|@PORT@|$PORT|g" "$REPO_DIR/deploy/nginx.conf" > "$SITE"
    echo "wrote $SITE"
  fi
  [ -z "$ENABLED" ] || ln -sf "$SITE" "$ENABLED"
  nginx -t
  systemctl reload nginx

  if grep -q "listen 443" "$SITE"; then
    echo "TLS already configured in $SITE"
  elif command -v certbot >/dev/null; then
    say "Certificate (certbot)"
    certbot --nginx -d "$DOMAIN" --redirect --non-interactive --agree-tos --register-unsafely-without-email --keep-until-expiring \
      || echo "certbot failed; fix DNS/firewall and run: sudo certbot --nginx -d $DOMAIN"
  else
    echo "certbot not found. Add TLS for $DOMAIN to $SITE yourself, or:"
    echo "  sudo apt-get install -y certbot python3-certbot-nginx && sudo certbot --nginx -d $DOMAIN"
  fi
fi

PROXY_STEP=""
if [ "$MODE" != "standalone" ]; then
  PROXY_STEP="
  2. Behind a proxy, tell PocketBase which header holds the real client IP
     (rate limiting and logs): admin UI -> Settings -> Application ->
     \"User IP proxy headers\" -> X-Real-IP (the bundled nginx config sets it).
"
fi
cat <<EOF

Done. Next steps:

  1. Create the superuser. Either open the one-time installer link that
     PocketBase prints on start while no superuser exists (it expires after
     ~30 minutes; restart the service for a new one):
       sudo journalctl -u pocketbase --no-pager | grep pbinstall | tail -1
     It starts with http://127.0.0.1:PORT; open it as https://$DOMAIN/_/#/pbinstall/...
     or run (leading space keeps the password out of shell history):
        sudo -u pocketbase $PREFIX/pocketbase superuser upsert <email> <password> --dir=$PREFIX/pb_data
     Then sign in at https://$DOMAIN/_/ and enable MFA.
$PROXY_STEP
  3. Run the smoke test (needs curl and jq):
       BASE=https://$DOMAIN SECRET=\$(sudo sed -n 's/^MCP_SECRET=//p' $ENV_FILE) scripts/smoke-test.sh

  4. Connector URL for Claude (treat it like a password):
       https://$DOMAIN/mcp/<MCP_SECRET from $ENV_FILE>

Logs: journalctl -u pocketbase -f
EOF
