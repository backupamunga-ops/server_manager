#!/usr/bin/env bash
# Stage 04 — Deploy Cloudlane API
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/log.sh"
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="04_deploy_api"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

# Read database URL
if [[ ! -f /etc/cloudlane/.database_url ]]; then
  log_fail "Database URL not found. Run stage 03 first."
  exit 1
fi
source /etc/cloudlane/.database_url

# Generate MASTER_KEY (32 bytes hex = 64 chars)
MASTER_KEY=$(openssl rand -hex 32)

# Generate HMAC key for agent communication
AGENT_HMAC_KEY=$(openssl rand -hex 32)

# Generate password pepper
PASSWORD_PEPPER=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)

# Write API env file (root-only, 0600)
cat > /etc/cloudlane/api.env <<EOF
DATABASE_URL=$DATABASE_URL
MASTER_KEY=$MASTER_KEY
PASSWORD_PEPPER=$PASSWORD_PEPPER
PEPPER_VERSION=1
NODE_ENV=production
PORT=3000
CLAIM_TTL_MINUTES=20
CLAIM_MAX_ATTEMPTS=5
LOGIN_RATE_LIMIT_PER_MINUTE=10
SESSION_TTL_MINUTES=10080
SESSION_STEPUP_TTL_MINUTES=5
AGENT_SOCKET_PATH=/run/cloudlane/agent.sock
AGENT_HMAC_KEY=$AGENT_HMAC_KEY
S3_ENDPOINT=http://cloudlane-garage:3900
S3_ACCESS_KEY=PLACEHOLDER
S3_SECRET_KEY=PLACEHOLDER
S3_BUCKET_UPLOADS=cloudlane-uploads
S3_BUCKET_DEPLOYMENTS=cloudlane-deployments
S3_REGION=garage
EOF
chmod 600 /etc/cloudlane/api.env

# Write agent HMAC key to separate file
echo -n "$AGENT_HMAC_KEY" > /etc/cloudlane/agent-hmac.key
chmod 600 /etc/cloudlane/agent-hmac.key

# Pull the API image
log_info "Pulling Cloudlane API image..."
docker pull ghcr.io/backupamunga-ops/server_manager/cloudlane-api:latest

# Install systemd unit
log_info "Installing systemd unit..."
cp "$SCRIPT_DIR/../../deploy/systemd/cloudlane-api.service" /etc/systemd/system/ 2>/dev/null || \
  curl -fsS -o /etc/systemd/system/cloudlane-api.service \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/systemd/cloudlane-api.service"

systemctl daemon-reload
systemctl enable cloudlane-api

# Start the API
log_info "Starting Cloudlane API..."
systemctl start cloudlane-api

# Wait for health check
log_info "Waiting for API to be healthy..."
for i in $(seq 1 30); do
  if curl -fsS http://localhost:3000/health &>/dev/null; then
    log_ok "API is healthy"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    log_warn "API did not respond to health check in 60 seconds"
    log_info "Check logs with: journalctl -u cloudlane-api -f"
  fi
done

# Run Prisma migrations
log_info "Running database migrations..."
docker exec cloudlane-api sh -c "cd /app/apps/api && npx prisma migrate deploy --schema src/prisma/schema.prisma" 2>&1 | tail -5 || \
  log_warn "Migration command failed — may need to run manually"

state_mark_complete "$stage_name" "api deployed and running"
log_ok "Stage 04 complete"
