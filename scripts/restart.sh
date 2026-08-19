#!/usr/bin/env bash
# =============================================================================
# Mindleaf manual production restart/deploy wrapper.
#
# Run from the editable VPS checkout:
#   sudo bash scripts/restart.sh
#
# This intentionally performs the same safe frontend/backend release deploy as
# `scripts/deploy.sh --no-migrate`. Database migrations are skipped because
# this wrapper is intended for ordinary application changes; run deploy.sh
# directly when a schema change is part of the release.
#
# Output is shown in the terminal and stored in a timestamped log file under
# /var/log/mindleaf/ when possible. Set MINDLEAF_RESTART_LOG_DIR to override
# the log directory.
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
LOG_DIR="${MINDLEAF_RESTART_LOG_DIR:-/var/log/mindleaf}"
STAMP="$(date -u '+%Y%m%dT%H%M%SZ')"
LOG_FILE="$LOG_DIR/restart-$STAMP.log"
STARTED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

# A normal operator may not be able to create /var/log/mindleaf. In that case
# keep the log in the checkout (the repository ignores *.log) rather than
# silently losing the deploy output.
if ! mkdir -p "$LOG_DIR" 2>/dev/null || ! touch "$LOG_FILE" 2>/dev/null; then
    LOG_DIR="$REPO_ROOT/.restart-logs"
    mkdir -p "$LOG_DIR"
    LOG_FILE="$LOG_DIR/restart-$STAMP.log"
    touch "$LOG_FILE"
fi
chmod 0640 "$LOG_FILE"

exec > >(tee -a "$LOG_FILE") 2>&1

log() {
    printf '[restart] %s %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$*"
}

finish() {
    local status=$?
    trap - EXIT
    if [[ "$status" -eq 0 ]]; then
        log "manual deploy/restart completed successfully"
    else
        log "manual deploy/restart failed with exit code $status"
    fi
    log "started: $STARTED_AT"
    log "log: $LOG_FILE"
    exit "$status"
}
trap finish EXIT

[[ -f "$REPO_ROOT/scripts/deploy.sh" ]] || {
    log "deploy script not found: $REPO_ROOT/scripts/deploy.sh"
    exit 66
}

cd "$REPO_ROOT"
log "starting manual production deploy"
log "source: $REPO_ROOT"
log "command: scripts/deploy.sh --no-migrate"

bash "$REPO_ROOT/scripts/deploy.sh" --no-migrate
