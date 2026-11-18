#!/usr/bin/env bash
# Stage 03 — Deploy PostgreSQL (tuned for 1GB VPS)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/log.sh"
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="03_deploy_postgres"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

# Generate credentials
PGUSER="cloudlane"
PGDB="cloudlane"
PGPASS=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)

# Write env file (root-only)
cat > /etc/cloudlane/postgres.env <<EOF
POSTGRES_USER=$PGUSER
POSTGRES_PASSWORD=$PGPASS
POSTGRES_DB=$PGDB
EOF
chmod 600 /etc/cloudlane/postgres.env

# Copy tuning config
mkdir -p /opt/cloudlane/releases/current
cp "$SCRIPT_DIR/../../deploy/docker/postgres-tuning.conf" /opt/cloudlane/releases/current/deploy/docker/postgres-tuning.conf 2>/dev/null || true
mkdir -p /opt/cloudlane/releases/current/deploy/docker/
# Download the tuning file from the repo if not found locally
if [[ ! -f /opt/cloudlane/releases/current/deploy/docker/postgres-tuning.conf ]]; then
  curl -fsS -o /opt/cloudlane/releases/current/deploy/docker/postgres-tuning.conf \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/docker/postgres-tuning.conf"
fi

# Install systemd unit
cp "$SCRIPT_DIR/../../deploy/systemd/cloudlane-postgres.service" /etc/systemd/system/ 2>/dev/null || \
  curl -fsS -o /etc/systemd/system/cloudlane-postgres.service \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/systemd/cloudlane-postgres.service"

systemctl daemon-reload
systemctl enable cloudlane-postgres
systemctl start cloudlane-postgres

# Wait for Postgres to be ready
log_info "Waiting for PostgreSQL to be ready..."
for i in $(seq 1 30); do
  if docker exec cloudlane-postgres pg_isready -U "$PGUSER" -d "$PGDB" &>/dev/null; then
    log_ok "PostgreSQL is ready"
    break
  fi
  sleep 2
  if [[ $i -eq 30 ]]; then
    log_fail "PostgreSQL did not become ready in 60 seconds"
    exit 1
  fi
done

# Write DATABASE_URL for the API
DATABASE_URL="postgresql://$PGUSER:$PGPASS@cloudlane-postgres:5432/$PGDB?schema=public"
echo "DATABASE_URL=$DATABASE_URL" >> /etc/cloudlane/.database_url
chmod 600 /etc/cloudlane/.database_url

# Run migrations via the API container (will be done in stage 04)
# For now just store the URL
log_ok "Database URL written to /etc/cloudlane/.database_url"

state_mark_complete "$stage_name" "postgres deployed, db=$PGDB user=$PGUSER"
log_ok "Stage 03 complete"
