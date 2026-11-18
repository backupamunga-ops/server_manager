#!/usr/bin/env bash
# Cloudlane installer — stage journal library
#
# Persists the installer's stage progression to /var/lib/cloudlane/installer-state.json
# so reruns skip completed stages and resume from the last failed one.

set -euo pipefail

STATE_DIR="/var/lib/cloudlane"
STATE_FILE="$STATE_DIR/installer-state.json"

state_init() {
  mkdir -p "$STATE_DIR"
  if [[ ! -f "$STATE_FILE" ]]; then
    cat > "$STATE_FILE" <<EOF
{
  "version": 1,
  "startedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "stages": {}
}
EOF
  fi
}

# state_mark_complete <stage_name> <optional note>
state_mark_complete() {
  local stage="$1"
  local note="${2:-}"
  python3 - "$STATE_FILE" "$stage" "$note" <<'PY'
import json, sys, datetime
path, stage, note = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    state = json.load(f)
state["stages"][stage] = {
    "status": "completed",
    "completedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "note": note,
}
with open(path, "w") as f:
    json.dump(state, f, indent=2)
PY
}

# state_mark_failed <stage_name> <error_message>
state_mark_failed() {
  local stage="$1"
  local error="$2"
  python3 - "$STATE_FILE" "$stage" "$error" <<'PY'
import json, sys, datetime
path, stage, error = sys.argv[1], sys.argv[2], sys.argv[3]
with open(path) as f:
    state = json.load(f)
state["stages"][stage] = {
    "status": "failed",
    "failedAt": datetime.datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"),
    "error": error,
}
with open(path, "w") as f:
    json.dump(state, f, indent=2)
PY
}

# state_is_complete <stage_name> -> exit 0 if complete, exit 1 otherwise
state_is_complete() {
  local stage="$1"
  python3 - "$STATE_FILE" "$stage" <<'PY'
import json, sys
path, stage = sys.argv[1], sys.argv[2]
with open(path) as f:
    state = json.load(f)
stage_state = state.get("stages", {}).get(stage, {})
sys.exit(0 if stage_state.get("status") == "completed" else 1)
PY
}

# state_skip_if_complete <stage_name>
# Echoes "SKIP" if the stage is already complete, nothing otherwise.
state_skip_if_complete() {
  local stage="$1"
  if state_is_complete "$stage" 2>/dev/null; then
    echo "SKIP"
  fi
}
