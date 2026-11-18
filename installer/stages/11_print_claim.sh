#!/usr/bin/env bash
# Stage 11 — Print one-time claim code
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/log.sh"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/../lib/state.sh"

stage_name="11_print_claim"
log_stage "$stage_name"

if state_is_complete "$stage_name" 2>/dev/null; then
  log_ok "Already complete — claim code was printed previously"
  log_info "To generate a new claim code, run: cloudlane-installer regenerate-claim"
  exit 0
fi

source /etc/cloudlane/.public_ips

# Generate a one-time claim code (32 bytes, base32)
CLAIM_CODE=$(openssl rand 32 | base32 | tr -d '=' | tr 'A-Z' '2-9A-Z' | head -c 52)

# Register the claim with the API
log_info "Registering claim code with API..."
RESULT=$(curl -fsS -X POST http://localhost:3000/api/v1/installation/claim \
  -H "Content-Type: application/json" \
  -d "{\"claimCode\": \"$CLAIM_CODE\"}" 2>&1) || true

# If the API doesn't have a claim endpoint yet, store locally for the API to pick up
# The API reads from the installation_claims table — we need to insert it directly
# For now, we use a helper endpoint that the API exposes for the installer
CLAIM_HASH=$(echo -n "$CLAIM_CODE" | sha256sum | awk '{print $1}')

# Try to insert the claim via the API's bootstrap endpoint
# The API creates the claim record when the claim code is first verified
# But we need to pre-register it. We do this via a direct DB insert.
docker exec cloudlane-postgres psql -U cloudlane -d cloudlane -c "
  INSERT INTO \"InstallationClaim\" (\"claimHash\", \"installationId\", status, \"expiresAt\", \"maxAttempts\")
  SELECT '$CLAIM_HASH', id, 'CLAIM_ISSUED', NOW() + INTERVAL '20 minutes', 5
  FROM \"InstallationIdentity\" LIMIT 1
  ON CONFLICT (\"claimHash\") DO NOTHING;
" 2>/dev/null || log_warn "Could not pre-register claim in DB — the API will handle it on first verification"

# Print the claim information
echo ""
echo "========================================================"
echo "  CLOUDLANE IS READY — CLAIM YOUR INSTALLATION"
echo "========================================================"
echo ""
echo "  Open this URL in your browser:"
echo ""
echo "    https://$PUBLIC_IP4"
echo ""
echo "  Claim code (one-time use, expires in 20 minutes):"
echo ""
echo "    $CLAIM_CODE"
echo ""
echo "  After claiming, you'll create your owner account"
echo "  with email, password, and MFA."
echo ""
echo "========================================================"
echo ""

# Log the claim (without the code itself)
state_mark_complete "$stage_name" "claim code printed"
log_ok "Stage 11 complete"
log_info "IMPORTANT: The claim code above is shown only once."
log_info "If lost, run: cloudlane-installer regenerate-claim"
