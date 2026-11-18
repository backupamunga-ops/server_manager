#!/usr/bin/env bash
# Stage 01 — Prepare host
# Create system users, directories, permissions, install base packages.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="01_prepare_host"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

# Create system users
log_info "Creating system users..."
for user in cloudlane-api cloudlane-agent cloudlane-mail; do
  if ! id "$user" &>/dev/null; then
    useradd --system --no-create-home --shell /usr/sbin/nologin "$user"
    log_ok "Created user: $user"
  else
    log_ok "User exists: $user"
  fi
done

# Create directories
log_info "Creating directory structure..."
dirs=(
  "/etc/cloudlane"
  "/var/lib/cloudlane"
  "/var/lib/cloudlane/volumes"
  "/var/lib/cloudlane/mail"
  "/var/lib/cloudlane/garage-data"
  "/var/lib/cloudlane/garage-meta"
  "/var/lib/cloudlane/caddy"
  "/var/lib/cloudlane/deployments"
  "/var/log/cloudlane"
  "/run/cloudlane"
  "/opt/cloudlane"
  "/opt/cloudlane/releases"
  "/opt/cloudlane/dashboard"
)

for d in "${dirs[@]}"; do
  mkdir -p "$d"
  case "$d" in
    /etc/cloudlane) chmod 0750 "$d"; chown root:root "$d" ;;
    /var/lib/cloudlane) chmod 0750 "$d"; chown root:root "$d" ;;
    /var/log/cloudlane) chmod 0750 "$d"; chown root:root "$d" ;;
    /run/cloudlane) chmod 0770 "$d"; chown root:cloudlane-agent "$d" ;;
    /opt/cloudlane/*) chmod 0755 "$d"; chown root:root "$d" ;;
    *) chmod 0755 "$d" ;;
  esac
done
log_ok "Directories created"

# Install base packages
log_info "Installing base packages..."
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq ca-certificates curl gnupg jq net-tools iproute2 ufw 2>&1 | tail -3
log_ok "Base packages installed"

# Set secure umask for future operations
echo "umask 077" >> /etc/cloudlane/.umask

state_mark_complete "$stage_name" "users, dirs, base packages"
log_ok "Stage 01 complete"
