#!/usr/bin/env bash
# Stage 12 — Finalize installation
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="12_finalize"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — skipping"
  exit 0
fi

# Enable all systemd units for boot persistence
log_info "Enabling services for auto-start on boot..."
for svc in cloudlane-postgres cloudlane-api cloudlane-agent cloudlane-stalwart cloudlane-garage caddy; do
  systemctl enable "$svc" 2>/dev/null && log_ok "Enabled: $svc" || log_warn "Could not enable: $svc"
done

# Write the installed marker
source /etc/cloudlane/.public_ips
cat > /etc/cloudlane/installed.marker <<EOF
{
  "version": "0.1.0",
  "installedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "publicIp4": "$PUBLIC_IP4",
  "publicIp6": "${PUBLIC_IP6:-}",
  "stages": $(cat /var/lib/cloudlane/installer-state.json 2>/dev/null | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin).get('stages',{})))" 2>/dev/null || echo '{}')
}
EOF
chmod 600 /etc/cloudlane/installed.marker

# Print summary
echo ""
echo "========================================================"
echo "  CLOUDLANE INSTALLATION COMPLETE"
echo "========================================================"
echo ""
echo "  Services running:"
for svc in cloudlane-postgres cloudlane-api cloudlane-agent cloudlane-stalwart cloudlane-garage caddy; do
  status=$(systemctl is-active "$svc" 2>/dev/null || echo "unknown")
  if [[ "$status" == "active" ]]; then
    echo "    ✓ $svc"
  else
    echo "    ✗ $svc ($status)"
  fi
done
echo ""
echo "  Dashboard: https://$PUBLIC_IP4"
echo "  API:       https://$PUBLIC_IP4/api/v1"
echo ""
echo "  Management commands:"
echo "    cloudlane status     — show platform status"
echo "    cloudlane doctor     — run diagnostics"
echo "    cloudlane repair     — repair failed services"
echo "    cloudlane upgrade    — upgrade to a new version"
echo ""
echo "  Mail service: installed but NOT accepting external mail yet."
echo "    MX/DNS records will be configured when you add a domain."
echo ""
echo "  Storage: Garage S3 running on internal network."
echo "    Buckets: cloudlane-uploads, cloudlane-deployments"
echo ""
echo "========================================================"

state_mark_complete "$stage_name" "installation finalized"
log_ok "Stage 12 complete"
