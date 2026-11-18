#!/usr/bin/env bash
# Stage 05 — Deploy dashboard (static files)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../lib/log.sh"
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="05_deploy_dashboard"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

log_info "Pulling dashboard image..."
docker pull ghcr.io/backupamunga-ops/server_manager/cloudlane-dashboard:latest

log_info "Extracting static files..."
# Create a temporary container, copy the tarball out, extract it
CONTAINER_ID=$(docker create ghcr.io/backupamunga-ops/server_manager/cloudlane-dashboard:latest)
docker cp "$CONTAINER_ID:/dashboard.tar.gz" /tmp/dashboard.tar.gz
docker rm "$CONTAINER_ID" >/dev/null

# Extract to /opt/cloudlane/dashboard
rm -rf /opt/cloudlane/dashboard/*
cd /opt/cloudlane
tar xzf /tmp/dashboard.tar.gz
rm /tmp/dashboard.tar.gz

chown -R root:root /opt/cloudlane/dashboard
chmod -R 0644 /opt/cloudlane/dashboard
# Directories need execute permission
find /opt/cloudlane/dashboard -type d -exec chmod 0755 {} \;

log_ok "Dashboard files extracted to /opt/cloudlane/dashboard"
log_info "$(find /opt/cloudlane/dashboard -type f | wc -l) files"

state_mark_complete "$stage_name" "dashboard extracted"
log_ok "Stage 05 complete"
