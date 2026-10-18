#!/usr/bin/env bash
# Install or upgrade the study-kb PocketBase server on Debian.
#
#   sudo scripts/install.sh                         # option B on ans.mhetsu.com
#   sudo scripts/install.sh --domain kb.example.com
#   sudo scripts/install.sh --caddy                 # option A: listen on 127.0.0.1:8090
#
# Run it from a checkout of this repo on the VPS. It is safe to re-run: it
# replaces the binary, hooks and migrations, keeps pb_data and the secret,
# and restarts the service (migrations apply on start).
set -euo pipefail

PB_VERSION="0.40.5"
DOMAIN="ans.mhetsu.com"
MODE="b"
PREFIX="/opt/pocketbase"
ENV_FILE="/etc/pocketbase/env"
UNIT="/etc/systemd/system/pocketbase.service"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) DOMAIN="$2"; shift 2 ;;
    --caddy) MODE="a"; shift ;;
    --version) PB_VERSION="$2"; shift 2 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
done

[ "$(id -u)" -eq 0 ] || { echo "run as root (sudo)" >&2; exit 1; }
command -v systemctl >/dev/null || { echo "systemd is required" >&2; exit 1; }

say() { printf '\n==> %s\n' "$*"; }

say "Dependencies"
need=()
for bin in curl unzip openssl sha256sum; do command -v "$bin" >/dev/null || need+=("$bin"); done
if [ ${#need[@]} -gt 0 ]; then
  apt-get update -qq
  apt-get install -y -qq curl unzip openssl coreutils ca-certificates
fi

case "$(uname -m)" in
  x86_64|amd64) ARCH="amd64" ;;
  aarch64|arm64) ARCH="arm64" ;;
  *) echo "unsupported architecture: $(uname -m)" >&2; exit 1 ;;
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
(cd "$TMP" && grep " $ZIP\$" checksums.txt | sha256sum -c -) || { echo "checksum mismatch" >&2; exit 1; }
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

say "systemd unit (option ${MODE^^})"
if [ "$MODE" = "b" ]; then
  SERVE_ARGS="$DOMAIN"
else
  SERVE_ARGS="--http=127.0.0.1:8090"
fi
sed "s|@SERVE_ARGS@|$SERVE_ARGS|" "$REPO_DIR/deploy/pocketbase.service" > "$UNIT"
if [ "$MODE" = "a" ]; then
  # Behind Caddy no privileged ports are needed.
  sed -i -e 's/^AmbientCapabilities=.*/AmbientCapabilities=/' -e 's/^CapabilityBoundingSet=.*/CapabilityBoundingSet=/' "$UNIT"
fi
systemctl daemon-reload
systemctl enable pocketbase >/dev/null

if [ "$MODE" = "b" ] && command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  say "Firewall"
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "opened 80/tcp and 443/tcp in ufw"
fi

say "Starting"
if $was_active; then systemctl restart pocketbase; else systemctl start pocketbase; fi
sleep 3
systemctl --no-pager --lines=0 status pocketbase || true

if [ "$MODE" = "b" ]; then PUBLIC="https://$DOMAIN"; else PUBLIC="https://$DOMAIN (via Caddy)"; fi
cat <<EOF

Done. Next steps:

  1. Create the superuser. Either open the one-time installer link that
     PocketBase prints on first start:
       journalctl -u pocketbase --no-pager | grep -A1 -i installer
     or run (leading space keeps the password out of shell history):
        sudo -u pocketbase $PREFIX/pocketbase superuser upsert <email> <password> --dir=$PREFIX/pb_data
     Then sign in at $PUBLIC/_/ and enable MFA.

  2. Run the smoke test from any machine with curl and jq:
       BASE=https://$DOMAIN SECRET=\$(sudo sed -n 's/^MCP_SECRET=//p' $ENV_FILE) scripts/smoke-test.sh

  3. Connector URL for Claude (treat it like a password):
       https://$DOMAIN/mcp/<MCP_SECRET from $ENV_FILE>

Logs: journalctl -u pocketbase -f
EOF
