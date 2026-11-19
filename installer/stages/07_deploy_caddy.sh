#!/usr/bin/env bash
# Stage 07 — Deploy Caddy (initial, with internal cert)
# Stage 10 switches to ACME short-lived IP cert.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="07_deploy_caddy"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

# Install Caddy 2.7+
log_info "Installing Caddy..."
export DEBIAN_FRONTEND=noninteractive

. /etc/os-release
install -m 0755 -d /etc/apt/keyrings
curl -fsSL "https://dl.cloudsmith.io/public/caddy/stable/gpg.key" | gpg --dearmor -o /etc/apt/keyrings/caddy-stable-archive-keyring.gpg 2>/dev/null || true
chmod a+r /etc/apt/keyrings/caddy-stable-archive-keyring.gpg

APT_CODENAME="$VERSION_CODENAME"
# Fall back to "noble" if Caddy repo doesn't have packages for this codename
if ! curl -fsS "https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu/dists/$APT_CODENAME/Release" &>/dev/null; then
  log_info "Caddy repo not available for codename '$APT_CODENAME', falling back to 'noble'"
  APT_CODENAME="noble"
fi
echo "deb [signed-by=/etc/apt/keyrings/caddy-stable-archive-keyring.gpg] https://dl.cloudsmith.io/public/caddy/stable/deb/ubuntu $APT_CODENAME main" > /etc/apt/sources.list.d/caddy-stable.list

apt-get update -qq
apt-get install -y -qq caddy 2>&1 | tail -3

log_ok "Caddy installed: $(caddy version)"

# Detect public IPs
PUBLIC_IP4=$(curl -fsS --connect-timeout 5 https://api.ipify.org 2>/dev/null || echo "")
PUBLIC_IP6=$(curl -fsS --connect-timeout 6 -6 https://api64.ipify.org 2>/dev/null || echo "")

if [[ -z "$PUBLIC_IP4" ]]; then
  log_fail "Cannot detect public IPv4 address"
  exit 1
fi

log_ok "Public IPv4: $PUBLIC_IP4"
if [[ -n "$PUBLIC_IP6" && "$PUBLIC_IP6" != "$PUBLIC_IP4" ]]; then
  log_ok "Public IPv6: $PUBLIC_IP6"
fi

# Render initial Caddyfile (internal cert, no ACME yet)
log_info "Rendering initial Caddyfile (internal cert)..."
mkdir -p /etc/caddy /etc/caddy/services

if [[ -n "$PUBLIC_IP6" && "$PUBLIC_IP6" != "$PUBLIC_IP4" ]]; then
  IP_BLOCK="$PUBLIC_IP4, $PUBLIC_IP6"
else
  IP_BLOCK="$PUBLIC_IP4"
fi

cat > /etc/caddy/Caddyfile <<EOF
{
  admin 127.0.0.1:2019
  auto_https disable_certs
  persist_config /var/lib/cloudlane/caddy/
}

https://$IP_BLOCK {
  tls internal

  handle /api/v1/* {
    reverse_proxy localhost:3000
  }

  # Per-service routes managed by the agent (release.activate)
  import /etc/caddy/services/*.caddy

  handle {
    root * /opt/cloudlane/dashboard
    try_files {path} /index.html
    file_server
  }

  header {
    Strict-Transport-Security "max-age=31536000; includeSubDomains"
    X-Content-Type-Options nosniff
    X-Frame-Options DENY
    Referrer-Policy strict-origin-when-cross-origin
  }

  log {
    output file /var/log/cloudlane/caddy-access.log {
      roll_size 10MB
      roll_keep 5
    }
    format json
  }
}
EOF

# Save IP info for stage 10
echo "PUBLIC_IP4=$PUBLIC_IP4" > /etc/cloudlane/.public_ips
echo "PUBLIC_IP6=$PUBLIC_IP6" >> /etc/cloudlane/.public_ips
chmod 600 /etc/cloudlane/.public_ips

# Restart Caddy
systemctl enable caddy
systemctl restart caddy

# Verify
sleep 2
if curl -fsSk "https://$PUBLIC_IP4/health" &>/dev/null || curl -fsSk "https://localhost/health" &>/dev/null; then
  log_ok "Caddy is serving"
else
  log_warn "Caddy may not be responding yet. Check: journalctl -u caddy -f"
fi

state_mark_complete "$stage_name" "caddy installed, ip=$PUBLIC_IP4"
log_ok "Stage 07 complete"
