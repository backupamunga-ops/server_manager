#!/bin/bash
# Cloudlane managed-DNS nameserver scaffold (PowerDNS Authoritative).
# Installs PowerDNS with a SQLite backend and its HTTP API on the VPS, so the
# panel can later publish real zones for domains that delegate to us.
#
# THIS IS THE SCAFFOLD ONLY:
#   - It does NOT become authoritative for any zone until the domain owner
#     changes NS records at their registrar to ns1/ns2.<provider domain>.
#   - A production deployment needs a SECOND independent nameserver
#     (ns2 on another host) before inviting real customers — one VPS is a
#     single point of failure and violates the prototype's documented
#     "two independent authoritative nameservers" requirement.
#
# After install:
#   API:      http://127.0.0.1:8053/api/v1  (X-API-Key from /etc/cloudlane/pdns-api-key)
#   Recursor: none (authoritative only)
#   Zones dir: /var/lib/powerdns (SQLite)
set -euo pipefail

API_KEY_FILE="/etc/cloudlane/pdns-api-key"

echo "==> Installing PowerDNS authoritative (sqlite backend)"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq pdns-server pdns-backend-sqlite3 sqlite3
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y pdns pdns-backend-sqlite sqlite
else
  echo "Unsupported package manager" >&2
  exit 1
fi

echo "==> API key"
mkdir -p /etc/cloudlane
if [[ ! -f "$API_KEY_FILE" ]]; then
  (umask 077 && openssl rand -hex 24 > "$API_KEY_FILE")
fi
API_KEY="$(cat "$API_KEY_FILE")"

echo "==> Schema"
ZONE_DIR=/var/lib/powerdns
mkdir -p "$ZONE_DIR"
if [[ ! -f "$ZONE_DIR/pdns.sqlite3" ]]; then
  SCHEMA=/usr/share/doc/pdns-backend-sqlite3/schema.sqlite3.sql
  [[ -f "$SCHEMA" ]] || SCHEMA=$(find /usr/share -name 'schema.sqlite3.sql' 2>/dev/null | head -1)
  sqlite3 "$ZONE_DIR/pdns.sqlite3" < "$SCHEMA"
fi
chown -R pdns:pdns "$ZONE_DIR"

echo "==> Writing /etc/powerdns/pdns.conf"
cat > /etc/powerdns/pdns.conf <<CONF
launch=gsqlite3
gsqlite3-database=$ZONE_DIR/pdns.sqlite3
api=yes
api-key=$API_KEY
webserver=yes
webserver-address=127.0.0.1
webserver-port=8053
local-address=0.0.0.0, ::
local-port=53
default-soa-name=ns1.billucsolutions.co.ke
default-soa-mail=hostmaster.billucsolutions.co.ke
slave=no
master=no
loglevel=4
CONF

echo "==> Enabling service"
systemctl enable --now pdns
sleep 2
systemctl is-active pdns

echo "==> Smoke test"
curl -s -H "X-API-Key: $API_KEY" http://127.0.0.1:8053/api/v1/servers/localhost | head -c 200; echo

cat <<'NEXT'

Scaffold complete. NEXT STEPS (manual, at your DNS provider/registrar):
 1. Decide the provider domain for nameservers, e.g. ns1/ns2.billucsolutions.co.ke.
 2. Add A records:  ns1.billucsolutions.co.ke -> 95.211.164.33
                    ns2.<second-host>        -> <future second VPS IP>
    plus glue records if the nameservers live UNDER billucsolutions.co.ke.
 3. When a customer domain is added to Cloudlane with managed DNS, the panel
    (via the agent) creates the zone here; the domain owner then points NS at
    ns1/ns2. Until ns2 exists on a second machine, keep managed mode disabled
    in production (the panel already gates this).
NEXT
