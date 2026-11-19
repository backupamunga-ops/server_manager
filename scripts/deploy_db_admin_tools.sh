#!/bin/bash
# Deploy phpMyAdmin + phpPgAdmin behind Caddy on the platform network.
set -uo pipefail

NET=cloudlane-internal

# Network name check
docker network inspect $NET >/dev/null 2>&1 || NET=$(docker network ls --format '{{.Name}}' | grep -E 'cloudlane' | head -1)
echo "network: $NET"

# phpMyAdmin — ARBITRARY lets the operator pick any server at login (works for
# every MySQL/MariaDB database container the platform creates).
if ! docker ps --format '{{.Names}}' | grep -q '^cloudlane-pma$'; then
  docker pull -q phpmyadmin/phpmyadmin:latest 2>&1 | tail -1
  docker run -d --name cloudlane-pma --restart unless-stopped \
    --network "$NET" -p 127.0.0.1:8081:8080 \
    -e PMA_ARBITRARY=1 -e UPLOAD_LIMIT=512M phpmyadmin/phpmyadmin:latest
else
  echo "pma already running"
fi

# PostgreSQL admin (pga.billucsolutions.co.ke): Adminer 4.8.1 — v6 requires a
# CSRF token and breaks single-sign-on handoff; 4.8.1 accepts auth[] fields.
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
docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'pma|ppa'# phpMyAdmin (pma.billucsolutions.co.ke) — SSO via SignonScript:
# panel opens /cloudlane/sso.php?t=<signed one-time token>; sso.php stores the
# credentials in the SignonSession and the signon script hands them to
# phpMyAdmin on every request. Adminer 4.8.1 (pga) accepts auth[] POSTs.
if [ ! -d /opt/cloudlane/dbadmin/etc ] || [ ! -f /opt/cloudlane/dbadmin/etc/sso_secret.txt ]; then
  mkdir -p /opt/cloudlane/dbadmin/etc /opt/cloudlane/dbadmin/web
  [ -f /opt/cloudlane/dbadmin/sso_secret.txt ] || openssl rand -hex 32 > /opt/cloudlane/dbadmin/etc/sso_secret.txt
  chmod 644 /opt/cloudlane/dbadmin/etc/sso_secret.txt
fi
grep -q PMA_SSO_SECRET /etc/cloudlane/api.env || echo "PMA_SSO_SECRET=$(cat /opt/cloudlane/dbadmin/etc/sso_secret.txt)" >> /etc/cloudlane/api.env
if ! docker ps --format '{{.Names}}' | grep -q '^cloudlane-pma$'; then
  docker rm -f cloudlane-pma >/dev/null 2>&1 || true
  docker pull -q phpmyadmin/phpmyadmin:latest 2>&1 | tail -1
  docker run -d --name cloudlane-pma --restart unless-stopped \
    --network "$NET" -p 127.0.0.1:8081:80 \
    -e PMA_ARBITRARY=1 -e UPLOAD_LIMIT=512M \
    -v /opt/cloudlane/dbadmin/config.inc.php:/etc/phpmyadmin/config.user.inc.php:ro \
    -v /opt/cloudlane/dbadmin/etc:/etc/phpmyadmin/cloudlane:ro \
    -v /opt/cloudlane/dbadmin/web:/var/www/html/cloudlane:ro \
    phpmyadmin/phpmyadmin:latest
else
  echo "pma already running"
fi
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
docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'pma|ppa'
