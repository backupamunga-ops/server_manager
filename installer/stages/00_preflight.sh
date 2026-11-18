#!/usr/bin/env bash
# Cloudlane installer — preflight stage (stage 00)
#
# Verifies the host is ready for Cloudlane installation. Hard stops on
# incompatible configurations, warns on suboptimal but workable ones.
#
# Exit codes:
#   0 — all checks passed (with possible warnings)
#   1 — hard stop, cannot install
#   2 — usage error

set -euo pipefail

# ---- Color helpers (optional, no-op if not a tty) ----
if [[ -t 1 ]]; then
  RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; BLUE=$'\e[34m'; RESET=$'\e[0m'
else
  RED=""; GREEN=""; YELLOW=""; BLUE=""; RESET=""
fi

log_info()  { printf '%s[INFO]%s  %s\n' "$BLUE" "$RESET" "$*"; }
log_ok()    { printf '%s[ OK ]%s  %s\n' "$GREEN" "$RESET" "$*"; }
log_warn()  { printf '%s[WARN]%s  %s\n' "$YELLOW" "$RESET" "$*"; }
log_fail()  { printf '%s[FAIL]%s  %s\n' "$RED" "$RESET" "$*" >&2; }

HARD_FAIL=0
WARN_COUNT=0

fail() {
  log_fail "$*"
  HARD_FAIL=1
}

warn() {
  log_warn "$*"
  WARN_COUNT=$((WARN_COUNT + 1))
}

require_root() {
  if [[ $EUID -ne 0 ]]; then
    fail "Installer must be run as root (use sudo)."
    exit 1
  fi
}

# ---- OS check ----
check_os() {
  log_info "Checking operating system..."

  if [[ ! -f /etc/os-release ]]; then
    fail "Cannot determine OS: /etc/os-release missing."
    return
  fi

  # shellcheck disable=SC1091
  source /etc/os-release

  if [[ "$ID" != "ubuntu" ]]; then
    fail "Unsupported OS: $ID. Only Ubuntu is supported."
    return
  fi

  if [[ "$VERSION_ID" != "24.04" ]]; then
    if [[ "$VERSION_ID" == "22.04" ]]; then
      warn "Ubuntu 22.04 detected. Supported but not the primary target. Proceed with caution."
    else
      fail "Unsupported Ubuntu version: $VERSION_ID. Only 24.04 LTS is supported."
      return
    fi
  fi

  log_ok "Ubuntu $VERSION_ID LTS"

  # Architecture
  local arch
  arch=$(uname -m)
  if [[ "$arch" != "x86_64" ]]; then
    if [[ "$arch" == "aarch64" ]]; then
      warn "ARM64 detected. Not yet validated — proceed with caution."
    else
      fail "Unsupported architecture: $arch"
      return
    fi
  fi
  log_ok "Architecture: $arch"
}

# ---- Resource check ----
check_resources() {
  log_info "Checking system resources..."

  local ram_kb ram_mb
  ram_kb=$(grep MemTotal /proc/meminfo | awk '{print $2}')
  ram_mb=$((ram_kb / 1024))

  if (( ram_mb < 768 )); then
    fail "Insufficient RAM: ${ram_mb} MB. Minimum 768 MB, recommended 1 GB."
    return
  fi

  if (( ram_mb < 1024 )); then
    warn "Low RAM: ${ram_mb} MB. Will configure 2 GB swap. Recommended 2 GB+ RAM."
  else
    log_ok "RAM: ${ram_mb} MB"
  fi

  # Disk space on /var
  local disk_avail_mb
  disk_avail_mb=$(df -m /var | awk 'NR==2 {print $4}')

  if (( disk_avail_mb < 10240 )); then
    fail "Insufficient disk on /var: ${disk_avail_mb} MB. Minimum 10 GB required."
    return
  fi
  log_ok "Disk available on /var: ${disk_avail_mb} MB"

  # Swap
  local swap_kb
  swap_kb=$(grep SwapTotal /proc/meminfo | awk '{print $2}')
  if (( swap_kb < 1048576 )); then
    warn "Swap is ${swap_kb} KB. Installer will configure 2 GB swap."
  else
    log_ok "Swap: $((swap_kb / 1024)) MB"
  fi
}

# ---- Port check ----
check_ports() {
  log_info "Checking required ports..."

  local port80 port443
  port80=$(ss -tlnp 2>/dev/null | grep -E ':80\s' || true)
  port443=$(ss -tlnp 2>/dev/null | grep -E ':443\s' || true)

  if [[ -n "$port80" ]]; then
    fail "Port 80 is already in use. Cloudlane requires ports 80 and 443 for Caddy."
    log_info "  Held by: $port80"
    return
  fi
  log_ok "Port 80 free"

  if [[ -n "$port443" ]]; then
    fail "Port 443 is already in use."
    log_info "  Held by: $port443"
    return
  fi
  log_ok "Port 443 free"
}

# ---- Docker check ----
check_docker() {
  log_info "Checking for existing Docker installation..."

  if command -v docker >/dev/null 2>&1; then
    local docker_version
    docker_version=$(docker --version 2>/dev/null | grep -oP 'version \K[0-9]+\.[0-9]+' || echo "unknown")
    log_ok "Docker $docker_version detected (will be reused)"
  else
    log_info "Docker not installed — installer will install Docker Engine 24+"
  fi
}

# ---- Network check ----
check_network() {
  log_info "Checking outbound network reachability..."

  # DNS resolution
  if ! getent hosts acme-v02.api.letsencrypt.org >/dev/null 2>&1; then
    fail "Cannot resolve acme-v02.api.letsencrypt.org — DNS resolution failed."
    return
  fi
  log_ok "DNS resolution working"

  # ACME endpoint
  if ! curl -fsS --connect-timeout 10 -o /dev/null https://acme-v02.api.letsencrypt.org/directory 2>/dev/null; then
    fail "Cannot reach Let's Encrypt ACME endpoint. HTTPS certificate issuance will fail."
    return
  fi
  log_ok "Let's Encrypt ACME endpoint reachable"

  # GitHub
  if ! curl -fsS --connect-timeout 10 -o /dev/null https://github.com 2>/dev/null; then
    warn "Cannot reach github.com — GitHub deploys will fail until network is available."
  else
    log_ok "GitHub reachable"
  fi
}

# ---- Time sync ----
check_time() {
  log_info "Checking time synchronization..."

  if ! systemctl is-active --quiet systemd-timesyncd 2>/dev/null; then
    if ! systemctl is-active --quiet chrony 2>/dev/null; then
      warn "Time sync service not active. ACME will fail if clock skews >60s."
      return
    fi
  fi
  log_ok "Time sync service active"
}

# ---- Existing install check ----
check_existing_install() {
  log_info "Checking for existing Cloudlane installation..."

  if [[ -f /etc/cloudlane/installed.marker ]]; then
    log_info "Existing Cloudlane installation detected."
    log_info "  Run 'cloudlane-installer upgrade' to upgrade, or 'cloudlane-installer repair' to fix issues."
    log_info "  This preflight is for fresh installs only."
    exit 0
  fi
  log_ok "No existing Cloudlane installation"
}

# ---- Public IP detection ----
detect_public_ip() {
  log_info "Detecting public IP addresses..."

  local ipv4 ipv6
  ipv4=$(curl -fsS --connect-timeout 5 https://api.ipify.org 2>/dev/null || echo "")
  ipv6=$(curl -fsS --connect-timeout 6 -6 https://api64.ipify.org 2>/dev/null || echo "")

  if [[ -z "$ipv4" ]]; then
    fail "Cannot detect public IPv4 address. HTTPS issuance will fail."
  else
    log_ok "Public IPv4: $ipv4"
  fi

  if [[ -n "$ipv6" && "$ipv6" != "$ipv4" ]]; then
    log_ok "Public IPv6: $ipv6"
  else
    warn "No public IPv6 detected. IPv6-only certificates will not be available."
  fi
}

# ---- Summary ----
summary() {
  echo ""
  if (( HARD_FAIL == 1 )); then
    printf '%s[FAIL]%s Preflight failed. Resolve the issues above and rerun.\n' "$RED" "$RESET"
    exit 1
  fi

  if (( WARN_COUNT > 0 )); then
    printf '%s[WARN]%s Preflight passed with %d warning(s).\n' "$YELLOW" "$RESET" "$WARN_COUNT"
  else
    printf '%s[ OK ]%s Preflight passed.\n' "$GREEN" "$RESET"
  fi
}

# ---- Main ----
main() {
  echo ""
  echo "Cloudlane Installer — Preflight (stage 00)"
  echo "============================================"
  echo ""

  require_root
  check_os
  check_resources
  check_ports
  check_docker
  check_network
  check_time
  check_existing_install
  detect_public_ip

  summary
}

main "$@"
