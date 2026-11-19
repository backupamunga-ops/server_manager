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
docker ps --format '{{.Names}} {{.Ports}}' | grep -E 'pma|ppa'
