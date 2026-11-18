#!/usr/bin/env bash
# Stage 09 — Deploy Garage Object Storage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/log.sh"
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="09_deploy_garage"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

log_info "Pulling Garage image..."
docker pull dxflrs/garage:v1.0.1

# Generate Garage credentials
GARAGE_ROOT_KEY=$(openssl rand -hex 16)
GARAGE_ROOT_SECRET=$(openssl rand -hex 32)
GARAGE_ADMIN_TOKEN=$(openssl rand -hex 32)

# Write Garage config
mkdir -p /etc/cloudlane/garage /var/lib/cloudlane/garage-data /var/lib/cloudlane/garage-meta

cat > /etc/cloudlane/garage/config.toml <<EOF
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "lmdb"

[api]
s3_bind_addr = "0.0.0.0:3900"
s3_region = "garage"
s3_api_root_domain = ".s3.garage"

[admin]
admin_bind_addr = "0.0.0.0:3902"
admin_metrics_token = "$GARAGE_ADMIN_TOKEN"
EOF
chmod 640 /etc/cloudlane/garage/config.toml

# Write env file for systemd unit
cat > /etc/cloudlane/garage.env <<EOF
GARAGE_ROOT_KEY=$GARAGE_ROOT_KEY
GARAGE_ROOT_SECRET=$GARAGE_ROOT_SECRET
GARAGE_ADMIN_TOKEN=$GARAGE_ADMIN_TOKEN
EOF
chmod 600 /etc/cloudlane/garage.env

# Install systemd unit
cp "$SCRIPT_DIR/../../deploy/systemd/cloudlane-garage.service" /etc/systemd/system/ 2>/dev/null || \
  curl -fsS -o /etc/systemd/system/cloudlane-garage.service \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/systemd/cloudlane-garage.service"

systemctl daemon-reload
systemctl enable cloudlane-garage
systemctl start cloudlane-garage

# Wait for Garage to be ready
log_info "Waiting for Garage S3 API..."
for i in $(seq 1 15); do
  if docker exec cloudlane-garage wget -qO- http://localhost:3900/health 2>/dev/null || \
     docker exec cloudlane-garage curl -fsS http://localhost:3900/ 2>/dev/null; then
    log_ok "Garage is responding"
    break
  fi
  sleep 2
  if [[ $i -eq 15 ]]; then
    log_warn "Garage not responding yet. Check: docker logs cloudlane-garage"
  fi
done

# Create buckets using garage CLI inside the container
log_info "Creating S3 buckets..."
docker exec cloudlane-garage /garage layout assign --node "$(docker exec cloudlane-garage /garage status | head -5 | grep -oP '^[a-f0-9]+' | head -1)" --zone garage --capacity 1 2>/dev/null || true

# Create buckets
for bucket in cloudlane-uploads cloudlane-deployments; do
  docker exec cloudlane-garage /garage bucket create "$bucket" 2>/dev/null || true
  log_ok "Bucket created: $bucket"
done

# Create an API key for Cloudlane API
KEY_OUTPUT=$(docker exec cloudlane-garage /garage key create cloudlane-api 2>/dev/null || echo "")
CLOUDLANE_S3_KEY=$(echo "$KEY_OUTPUT" | grep -oP 'Key ID:\s+\K\S+' || echo "")
CLOUDLANE_S3_SECRET=$(echo "$KEY_OUTPUT" | grep -oP 'Secret key:\s+\K\S+' || echo "")

if [[ -n "$CLOUDLANE_S3_KEY" && -n "$CLOUDLANE_S3_SECRET" ]]; then
  # Grant key access to both buckets
  for bucket in cloudlane-uploads cloudlane-deployments; do
    docker exec cloudlane-garage /garage bucket allow --key cloudlane-api --read --write "$bucket" 2>/dev/null || true
  done

  # Update API env with real S3 credentials
  sed -i "s/S3_ACCESS_KEY=PLACEHOLDER/S3_ACCESS_KEY=$CLOUDLANE_S3_KEY/" /etc/cloudlane/api.env
  sed -i "s/S3_SECRET_KEY=PLACEHOLDER/S3_SECRET_KEY=$CLOUDLANE_S3_SECRET/" /etc/cloudlane/api.env
  log_ok "S3 credentials written to /etc/cloudlane/api.env"
else
  log_warn "Could not create S3 API key automatically. Run manually:"
  log_warn "  docker exec cloudlane-garage /garage key create cloudlane-api"
fi

# Restart API to pick up new S3 credentials
systemctl restart cloudlane-api 2>/dev/null || true

state_mark_complete "$stage_name" "garage deployed, buckets created"
log_ok "Stage 09 complete"
