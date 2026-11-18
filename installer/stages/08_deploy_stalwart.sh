#!/usr/bin/env bash
# Stage 08 — Deploy Stalwart Mail Server
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/log.sh"
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="08_deploy_stalwart"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

source /etc/cloudlane/.public_ips

# Pull Stalwart image
log_info "Pulling Stalwart Mail image..."
docker pull stalwart/mail-server:latest

# Generate DKIM keys
log_info "Generating DKIM keys..."
mkdir -p /etc/cloudlane/stalwart
openssl genrsa -out /etc/cloudlane/stalwart/dkim-private.pem 2048 2>/dev/null
openssl rsa -in /etc/cloudlane/stalwart/dkim-private.pem -pubout -out /etc/cloudlane/stalwart/dkim-public.pem 2>/dev/null
chmod 600 /etc/cloudlane/stalwart/dkim-private.pem
chmod 644 /etc/cloudlane/stalwart/dkim-public.pem

# Generate Stalwart admin password
STALWART_ADMIN_PASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 24)

# Write Stalwart config
source /etc/cloudlane/.public_ips
HOSTNAME="mail.$PUBLIC_IP4"

cat > /etc/cloudlane/stalwart/config.toml <<EOF
[server]
hostname = "$HOSTNAME"
[server.listener]
[server.listener.smtp]
bind = ["0.0.0.0:25"]
[server.listener.submission]
bind = ["0.0.0.0:587"]
[server.listener.imap]
bind = ["0.0.0.0:993"]
[server.listener.manage]
bind = ["127.0.0.1:8443"]
[storage]
data-path = "/var/lib/stalwart"
[certificate]
default = "/etc/stalwart/cert.pem"
key = "/etc/stalwart/key.pem"
[dkim]
signing-key = "/etc/stalwart/dkim-private.pem"
[spam-filter]
enabled = true
threshold = 5.0
[management]
admin-user = "admin"
admin-password = "$STALWART_ADMIN_PASS"
EOF
chmod 640 /etc/cloudlane/stalwart/config.toml

# Generate self-signed cert for now (replaced with real cert in phase 3)
openssl req -x509 -newkey rsa:2048 -keyout /etc/cloudlane/stalwart/key.pem \
  -out /etc/cloudlane/stalwart/cert.pem -days 365 -nodes \
  -subj "/CN=$HOSTNAME" 2>/dev/null
chmod 600 /etc/cloudlane/stalwart/key.pem
chmod 644 /etc/cloudlane/stalwart/cert.pem

# Install systemd unit
cp "$SCRIPT_DIR/../../deploy/systemd/cloudlane-stalwart.service" /etc/systemd/system/ 2>/dev/null || \
  curl -fsS -o /etc/systemd/system/cloudlane-stalwart.service \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/systemd/cloudlane-stalwart.service"

systemctl daemon-reload
systemctl enable cloudlane-stalwart
systemctl start cloudlane-stalwart

# Wait for SMTP
log_info "Waiting for Stalwart SMTP..."
for i in $(seq 1 15); do
  if docker exec cloudlane-stalwart sh -c "echo QUIT | nc localhost 25" 2>/dev/null | grep -q "220"; then
    log_ok "Stalwart SMTP is responding"
    break
  fi
  sleep 2
  if [[ $i -eq 15 ]]; then
    log_warn "Stalwart SMTP not responding yet. Check: docker logs cloudlane-stalwart"
  fi
done

# Save admin password for later reference
echo "STALWART_ADMIN_PASS=$STALWART_ADMIN_PASS" > /etc/cloudlane/.stalwart-admin
chmod 600 /etc/cloudlane/.stalwart-admin

state_mark_complete "$stage_name" "stalwart deployed"
log_ok "Stage 08 complete"
log_info "Stalwart admin password saved to /etc/cloudlane/.stalwart-admin (root-only)"
log_info "Mail service is running but NOT accepting external mail yet (no MX/DNS until phase 3)"
