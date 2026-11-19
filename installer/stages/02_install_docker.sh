#!/usr/bin/env bash
# Stage 02 — Install or reuse Docker Engine
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="02_install_docker"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

if command -v docker &>/dev/null; then
  existing_version=$(docker --version | grep -oP 'version \K[0-9]+' || echo "0")
  if (( existing_version >= 24 )); then
    log_ok "Docker $existing_version already installed — reusing"
    state_mark_complete "$stage_name" "reused existing docker $existing_version"
    exit 0
  else
    log_fail "Docker $existing_version is too old (need 24+). Please upgrade manually."
    exit 1
  fi
fi

log_info "Installing Docker Engine 24+..."
export DEBIAN_FRONTEND=noninteractive

# Add Docker's official GPG key
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

# Add the repository — use "noble" as fallback codename if the current
# Ubuntu version's codename isn't published on Docker's apt repo yet.
# Docker packages are forward-compatible across Ubuntu LTS versions.
. /etc/os-release
APT_CODENAME="$VERSION_CODENAME"
# Test if the repo exists for this codename, fall back to noble if not
if ! curl -fsS "https://download.docker.com/linux/ubuntu/dists/$APT_CODENAME/Release" &>/dev/null; then
  log_info "Docker repo not available for codename '$APT_CODENAME', falling back to 'noble'"
  APT_CODENAME="noble"
fi
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $APT_CODENAME stable" > /etc/apt/sources.list.d/docker.list

apt-get update -qq
apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin 2>&1 | tail -5

# Configure Docker daemon for security
log_info "Configuring Docker daemon..."
cat > /etc/docker/daemon.json <<'EOF'
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "bridge": "none",
  "iptables": true,
  "userland-proxy": false,
  "no-new-privileges": true
}
EOF

systemctl enable docker
systemctl restart docker

# Verify
if docker info &>/dev/null; then
  log_ok "Docker is running"
else
  log_fail "Docker failed to start"
  exit 1
fi

# Create internal network
if ! docker network inspect cloudlane-internal &>/dev/null; then
  docker network create --driver bridge --internal cloudlane-internal
  log_ok "Created cloudlane-internal network"
fi

state_mark_complete "$stage_name" "docker $(docker --version)"
log_ok "Stage 02 complete"
