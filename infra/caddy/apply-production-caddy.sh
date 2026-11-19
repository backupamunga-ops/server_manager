#!/bin/bash
# Apply the production Caddy configuration on the Cloudlane VPS.
# Run as root ON the VPS (or via ssh). Backs up the previous Caddyfile,
# installs the production one, creates the hostnames route directory,
# validates, and reloads only if caddy is happy.
set -euo pipefail

CADDYFILE_SRC="$(dirname "$0")/Caddyfile.production"
CADDYFILE="/etc/caddy/Caddyfile"
HOSTNAMES_DIR="/etc/caddy/hostnames"
SERVICES_DIR="/etc/caddy/services"
TS="$(date +%Y%m%d-%H%M%S)"

if [[ ! -f "$CADDYFILE_SRC" ]]; then
  echo "Copy infra/caddy/ to the VPS first (e.g. /root/cloudlane-infra/caddy)." >&2
  exit 1
fi

echo "==> Backing up $CADDYFILE to $CADDYFILE.bak.$TS"
cp "$CADDYFILE" "$CADDYFILE.bak.$TS"

echo "==> Ensuring route directories"
mkdir -p "$HOSTNAMES_DIR" "$SERVICES_DIR"
chmod 755 "$HOSTNAMES_DIR" "$SERVICES_DIR"

echo "==> Installing production Caddyfile"
cp "$CADDYFILE_SRC" "$CADDYFILE"

echo "==> Validating"
if ! caddy validate --config "$CADDYFILE" --adapter caddyfile; then
  echo "Validation FAILED — restoring backup."
  cp "$CADDYFILE.bak.$TS" "$CADDYFILE"
  exit 1
fi

echo "==> Reloading caddy"
systemctl reload caddy
echo "Done. Panel: https://server.billucsolutions.co.ke  ·  path previews intact."
echo "New app hostnames activate automatically when connected in the panel."
