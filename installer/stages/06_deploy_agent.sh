#!/usr/bin/env bash
# Stage 06 — Deploy Go agent
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="06_deploy_agent"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

log_info "Pulling agent image..."
docker pull ghcr.io/backupamunga-ops/server_manager/cloudlane-agent:latest

log_info "Extracting agent binary..."
CONTAINER_ID=$(docker create ghcr.io/backupamunga-ops/server_manager/cloudlane-agent:latest)
docker cp "$CONTAINER_ID:/usr/local/bin/cloudlane-agent" /usr/local/bin/cloudlane-agent
docker rm "$CONTAINER_ID" >/dev/null

chmod 0755 /usr/local/bin/cloudlane-agent
log_ok "Agent binary installed at /usr/local/bin/cloudlane-agent"

# Get instance ID from the API (it creates one on first run)
log_info "Getting instance ID from API..."
INSTANCE_ID=""
for i in $(seq 1 15); do
  INSTANCE_ID=$(curl -fsS http://localhost:3000/api/v1/installation/status 2>/dev/null | jq -r '.instanceId // empty' 2>/dev/null || echo "")
  if [[ -n "$INSTANCE_ID" ]]; then
    break
  fi
  sleep 2
done

if [[ -z "$INSTANCE_ID" ]]; then
  log_fail "Could not get instance ID from API. Is the API running?"
  exit 1
fi
log_ok "Instance ID: $INSTANCE_ID"

# Write agent env file
cat > /etc/cloudlane/agent.env <<EOF
INSTANCE_ID=$INSTANCE_ID
EOF
chmod 600 /etc/cloudlane/agent.env

# Install systemd unit
cp "$SCRIPT_DIR/../../deploy/systemd/cloudlane-agent.service" /etc/systemd/system/ 2>/dev/null || \
  curl -fsS -o /etc/systemd/system/cloudlane-agent.service \
    "https://raw.githubusercontent.com/backupamunga-ops/server_manager/main/deploy/systemd/cloudlane-agent.service"

systemctl daemon-reload
systemctl enable cloudlane-agent
systemctl start cloudlane-agent

# Wait for agent socket
log_info "Waiting for agent socket..."
for i in $(seq 1 10); do
  if [[ -S /run/cloudlane/agent.sock ]]; then
    log_ok "Agent socket is live"
    break
  fi
  sleep 1
  if [[ $i -eq 10 ]]; then
    log_warn "Agent socket not found. Check: journalctl -u cloudlane-agent -f"
  fi
done

state_mark_complete "$stage_name" "agent deployed, instance=$INSTANCE_ID"
log_ok "Stage 06 complete"
