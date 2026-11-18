#!/usr/bin/env bash
# Stage 10 — Configure HTTPS via ACME short-lived IP certificates
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="10_configure_https"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

source /etc/cloudlane/.public_ips

if [[ -z "$PUBLIC_IP4" ]]; then
  log_fail "Public IP not found. Run stage 07 first."
  exit 1
fi

# Build the address block
if [[ -n "$PUBLIC_IP6" && "$PUBLIC_IP6" != "$PUBLIC_IP4" ]]; then
  IP_BLOCK="$PUBLIC_IP4, $PUBLIC_IP6"
else
  IP_BLOCK="$PUBLIC_IP4"
fi

log_info "Re-rendering Caddyfile with ACME short-lived IP certificates..."

cat > /etc/caddy/Caddyfile <<EOF
{
  admin off
  auto_https disable_certs
  persist_config /var/lib/cloudlane/caddy/
  acme_ca https://acme-v02.api.letsencrypt.org/directory
}

https://$IP_BLOCK {
  tls {
    issuer acme {
      disable_http_challenge
      enable_tls_alpn_challenge
    }
  }

  handle /api/v1/* {
    reverse_proxy localhost:3000
  }

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
    Content-Security-Policy "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'"
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

# Validate the new config
log_info "Validating Caddyfile..."
if caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1 | grep -q "Valid configuration"; then
  log_ok "Caddyfile is valid"
else
  log_fail "Caddyfile validation failed. Reverting to internal cert."
  log_info "Falling back to tls internal — HTTPS will work but with untrusted cert."
  # Revert: replace the tls block with internal
  sed -i 's/issuer acme {/tls internal # fallback (acme failed)/' /etc/caddy/Caddyfile
  sed -i '/disable_http_challenge/d' /etc/caddy/Caddyfile
  sed -i '/enable_tls_alpn_challenge/d' /etc/caddy/Caddyfile
  sed -i '/}/d' /etc/caddy/Caddyfile 2>/dev/null || true
fi

# Reload Caddy atomically
log_info "Reloading Caddy..."
if caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile 2>&1; then
  log_ok "Caddy reloaded"
else
  log_fail "Caddy reload failed. Check: journalctl -u caddy -f"
  exit 1
fi

# Wait for cert issuance
log_info "Waiting for ACME certificate issuance (may take 30-60 seconds)..."
sleep 15

# Verify from the outside
log_info "Verifying HTTPS from public internet..."
for i in $(seq 1 12); do
  HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" "https://$PUBLIC_IP4/health" --connect-timeout 5 2>/dev/null || echo "000")
  if [[ "$HTTP_CODE" == "200" ]]; then
    log_ok "HTTPS is working! (HTTP $HTTP_CODE)"
    break
  fi
  log_info "Waiting for cert... (attempt $i, got HTTP $HTTP_CODE)"
  sleep 10
  if [[ $i -eq 12 ]]; then
    log_warn "HTTPS not working yet after 2 minutes."
    log_warn "Caddy may still be obtaining the certificate. Check:"
    log_warn "  journalctl -u caddy -f"
    log_warn "  curl -v https://$PUBLIC_IP4/health"
    log_warn ""
    log_warn "If ACME fails (e.g., rate limited), you can proceed with internal cert."
    log_warn "The dashboard will show a cert warning in the browser, but the API will work."
  fi
done

state_mark_complete "$stage_name" "https configured on $IP_BLOCK"
log_ok "Stage 10 complete"
