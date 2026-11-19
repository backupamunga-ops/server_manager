#!/usr/bin/env bash
# Stage 09 — Deploy Garage Object Storage
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
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
replication_factor = 1
rpc_bind_addr = "[::]:3901"
rpc_secret = "$(openssl rand -hex 32)"

[s3_api]
s3_region = "garage"
api_bind_addr = "0.0.0.0:3900"

[admin]
api_bind_addr = "0.0.0.0:3902"
admin_token = "$GARAGE_ADMIN_TOKEN"
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
  if docker exec cloudlane-garage /garage status >/dev/null 2>&1; then
    log_ok "Garage is responding"
    break
  fi
  sleep 2
  if [[ $i -eq 15 ]]; then
    log_warn "Garage not responding yet. Check: docker logs cloudlane-garage"
  fi
done

# Assign the node its storage role and apply the layout.
# Garage v1.0.1 CLI: node ids are positional, capacity is in bytes
# (suffixes supported). Commit half of the free space on the data volume,
# minimum 1 GB.
log_info "Configuring Garage cluster layout..."
NODE_ID=$(docker exec cloudlane-garage /garage status | awk '/HEALTHY NODES/{f=1; next} f && $1 ~ /^[0-9a-f]+$/ {print $1; exit}')
LAYOUT_VERSION=$(docker exec cloudlane-garage /garage layout show | grep -oP 'Current cluster layout version: \K[0-9]+' || echo 0)
if [[ -n "$NODE_ID" && "$LAYOUT_VERSION" == "0" ]]; then
  AVAIL_KB=$(df --output=avail -k /var/lib/cloudlane/garage-data | tail -1 | tr -dc '0-9')
  CAP_KB=$((AVAIL_KB / 2))
  if [[ $CAP_KB -lt 1048576 ]]; then CAP_KB=1048576; fi
  docker exec cloudlane-garage /garage layout assign -z garage -c "${CAP_KB}KB" "$NODE_ID" \
    || log_warn "garage layout assign failed"
  docker exec cloudlane-garage /garage layout apply --version 1 \
    || log_warn "garage layout apply failed"
else
  log_ok "Garage layout already configured"
fi

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

  # Update API env with real S3 credentials (append if placeholders absent)
  if grep -q '^S3_ACCESS_KEY=' /etc/cloudlane/api.env 2>/dev/null; then
    sed -i "s/^S3_ACCESS_KEY=.*/S3_ACCESS_KEY=$CLOUDLANE_S3_KEY/" /etc/cloudlane/api.env
    sed -i "s/^S3_SECRET_KEY=.*/S3_SECRET_KEY=$CLOUDLANE_S3_SECRET/" /etc/cloudlane/api.env
  else
    printf '\nS3_ACCESS_KEY=%s\nS3_SECRET_KEY=%s\nS3_ENDPOINT=http://127.0.0.1:3900\nS3_REGION=garage\n' \
      "$CLOUDLANE_S3_KEY" "$CLOUDLANE_S3_SECRET" >> /etc/cloudlane/api.env
  fi
  chmod 600 /etc/cloudlane/api.env
  log_ok "S3 credentials written to /etc/cloudlane/api.env"
else
  log_warn "Could not create S3 API key automatically. Run manually:"
  log_warn "  docker exec cloudlane-garage /garage key create cloudlane-api"
fi

# Restart API to pick up new S3 credentials
systemctl restart cloudlane-api 2>/dev/null || true

state_mark_complete "$stage_name" "garage deployed, buckets created"
log_ok "Stage 09 complete"
