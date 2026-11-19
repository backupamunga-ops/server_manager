#!/bin/bash
# Deploy the database admin tools behind Caddy on the platform network:
#   pma.billucsolutions.co.ke — phpMyAdmin (MySQL/MariaDB) with SSO
#   pga.billucsolutions.co.ke — Adminer 4.8.1 (PostgreSQL) with SSO
# SSO design:
#   The panel API signs a one-time token (HMAC-SHA256, 60s, single use) and
#   opens /cloudlane/sso.php?t=... inside the pma container. sso.php stores
#   the credentials in the SignonSession; the signon script
#   (/etc/phpmyadmin/cloudlane/sso_script.php) hands them to phpMyAdmin on
#   every request. Adminer 4.8.1 accepts auth[] POST fields directly
#   (Adminer 6+ adds a CSRF token and breaks the handoff, hence the pin).
#   The shared secret must exist in /etc/cloudlane/api.env as PMA_SSO_SECRET.
set -uo pipefail

NET=cloudlane-internal
BASE=/opt/cloudlane/dbadmin

# Network name check
docker network inspect "$NET" >/dev/null 2>&1 || NET=$(docker network ls --format '{{.Name}}' | grep -E 'cloudlane' | head -1)
echo "network: $NET"

mkdir -p "$BASE/etc" "$BASE/web"
if [ ! -f "$BASE/etc/sso_secret.txt" ]; then
  openssl rand -hex 32 > "$BASE/etc/sso_secret.txt"
fi
chmod 644 "$BASE/etc/sso_secret.txt"
grep -q PMA_SSO_SECRET /etc/cloudlane/api.env 2>/dev/null || \
  echo "PMA_SSO_SECRET=$(cat "$BASE/etc/sso_secret.txt")" >> /etc/cloudlane/api.env

# phpMyAdmin with the SSO bridge (config + script mounted read-only).
if ! docker ps --format '{{.Names}}' | grep -q '^cloudlane-pma$'; then
  docker rm -f cloudlane-pma >/dev/null 2>&1 || true
  docker pull -q phpmyadmin/phpmyadmin:latest 2>&1 | tail -1
  docker run -d --name cloudlane-pma --restart unless-stopped \
    --network "$NET" -p 127.0.0.1:8081:80 \
    -e PMA_ARBITRARY=1 -e UPLOAD_LIMIT=512M \
    -v "$BASE/config.inc.php":/etc/phpmyadmin/config.user.inc.php:ro \
    -v "$BASE/etc":/etc/phpmyadmin/cloudlane:ro \
    -v "$BASE/web":/var/www/html/cloudlane:ro \
    phpmyadmin/phpmyadmin:latest
else
  echo "pma already running"
fi

# Adminer pinned to 4.8.1 for the PostgreSQL handoff (see header).
if ! docker ps --format '{{.Names}}' | grep -q '^cloudlane-pga$'; then
  docker rm -f cloudlane-pga >/dev/null 2>&1 || true
  docker pull -q adminer:4.8.1 2>&1 | tail -1
  docker run -d --name cloudlane-pga --restart unless-stopped \
    --network "$NET" -p 127.0.0.1:8082:8080 adminer:4.8.1
else
  echo "pga already running"
fi

sleep 2
curl -s -o /dev/null -w "pma local: %{http_code}\n" http://127.0.0.1:8081/
curl -s -o /dev/null -w "pga local: %{http_code}\n" http://127.0.0.1:8082/ || true
docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'pma|pga'
