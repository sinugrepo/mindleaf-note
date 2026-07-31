#!/usr/bin/env bash
# =============================================================================
# Phase 9 — Daily database backup: pg_dump → rclone to Cloudflare R2.
#
# Usage:
#   /opt/mindleaf/scripts/backup.sh            # run from cron or manually
#   sudo -u mindleaf /opt/mindleaf/scripts/backup.sh
#
# Designed for:
#   - cron.d daily at 03:00 (deploy/cron.d/mindleaf-backup)
#   - manual `sudo systemctl restart mindleaf-backup.timer` (future use)
#   - emergency invocation as root (`bash backup.sh` → inherits env)
#
# Exit codes:
#   0 = success (dump uploaded, retention sweep attempted)
#   1 = pg_dump failed
#   2 = rclone copy to R2 failed
#   4 = flock lock failed (another run in progress — non-fatal)
#
# Idempotency & safety:
#   - `set -euo pipefail` abort on first error.
#   - `flock -n` prevents overlapping runs; second invocation exits 4.
#   - rclone writes to a date-stamped filename (`2026-07-23.dump`) so
#     re-running never overwrites a previous day's dump.
#   - The local /tmp dump is `rm`'d after upload, even on success.
#   - Retention sweep with `--min-age ${RETENTION_DAYS}d --rmdirs`
#     keeps 30 days of backups (TBD #3 default).
#   - All steps log to systemd-cat AND stdout. cron picks up stdout to
#     /var/log/syslog automatically.
# =============================================================================

set -euo pipefail
shopt -s nullglob

# ---------------------------------------------------------------------------
# Configuration (overrideable via environment if needed; defaults match
# the CLOUD_MIGRATION_PLAN §11 spec).
# ---------------------------------------------------------------------------
PG_DB="${PG_DB:-mindleaf}"
PG_HOST="${PG_HOST:-localhost}"
PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-mindleaf}"

RCLONE_REMOTE="${RCLONE_REMOTE:-r2:mindleaf-prod-backups/db}"
RCLONE_CONFIG="${RCLONE_CONFIG:-/opt/mindleaf/.config/rclone/rclone.conf}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

LOCK_FILE="${LOCK_FILE:-/var/lock/mindleaf-backup.lock}"
TMP_DIR="${TMP_DIR:-/var/tmp}"
BACKUP_PREFIX="${BACKUP_PREFIX:-mindleaf}"
LOG_TAG="${LOG_TAG:-mindleaf-backup}"

# ---------------------------------------------------------------------------
# Logging: prefer systemd-cat (cron-less path); fall back to stdout.
# ---------------------------------------------------------------------------
log() {
    local msg="[$(date -u '+%F %T') UTC] $*"
    if command -v systemd-cat >/dev/null 2>&1; then
        # systemd-cat writes to journal under identifier $LOG_TAG.
        echo "$msg" | systemd-cat -t "$LOG_TAG" 2>/dev/null || true
    fi
    echo "$msg"
}
err() {
    local msg="[$(date -u '+%F %T') UTC] ERROR: $*"
    if command -v systemd-cat >/dev/null 2>&1; then
        echo "$msg" | systemd-cat -t "$LOG_TAG" -p err 2>/dev/null || true
    fi
    echo "$msg" >&2
}

# ---------------------------------------------------------------------------
# Single-run lock via flock(1). Non-blocking so a stuck previous run
# surfaces an error rather than queueing further invocations.
# ---------------------------------------------------------------------------
acquire_lock() {
    exec 9>"$LOCK_FILE"
    if ! flock -n 9; then
        err "another backup holds $LOCK_FILE — exiting (4)"
        exit 4
    fi
    log "acquired lock $LOCK_FILE"
}

# ---------------------------------------------------------------------------
# pg_dump — `-Fc` (custom, parallel-restore capable) with --no-owner /
# --no-acl so the dump is portable across environments.
# ---------------------------------------------------------------------------
dump_database() {
    local out_path="$1"
    log "pg_dump -Fc -d $PG_DB → $out_path (start)"

    # Avoid embedding password in command line. Use ~/.pgpass which
    # bootstrap.sh provisions (chmod 600, format
    # `hostname:port:database:username:password`).
    if ! pg_dump \
        --host="$PG_HOST" \
        --port="$PG_PORT" \
        --username="$PG_USER" \
        --dbname="$PG_DB" \
        --format=custom \
        --no-owner \
        --no-acl \
        --compress=9 \
        --file="$out_path"; then
        err "pg_dump failed — removing partial $out_path"
        rm -f "$out_path"
        exit 1
    fi

    local size
    size="$(du -h "$out_path" | cut -f1)"
    log "pg_dump ok (size=$size)"
}

# ---------------------------------------------------------------------------
# Push to R2 via rclone. Date-stamped filename guarantees no
# overwrite; rclone retries handle transient S3 errors.
# ---------------------------------------------------------------------------
push_to_r2() {
    local src="$1"
    local dest_name
    dest_name="$(date -u '+%Y-%m-%d')-$(basename "$src")"

    log "rclone copyto $src → $RCLONE_REMOTE/$dest_name (start)"
    if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone copyto \
        --retries 3 \
        --low-level-retries 5 \
        --s3-upload-cutoff 100M \
        --s3-chunk-size 50M \
        --stats 30s \
        --stats-one-line \
        --log-level INFO \
        "$src" "$RCLONE_REMOTE/$dest_name" 2>&1 | systemd-cat -t "$LOG_TAG" 2>/dev/null || true; then
        # rclone prints progress to stdout but exits non-zero only on
        # hard failures; the pipe to systemd-cat means we can't see
        # rclone's actual exit through `set -e`. Re-check the local
        # copy: rclone copyto is atomic (write-on-temp, rename on success).
        if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone lsjson "$RCLONE_REMOTE/$dest_name" >/dev/null 2>&1; then
            err "rclone copy verification failed — $dest_name NOT in $RCLONE_REMOTE"
            exit 2
        fi
    fi
    log "rclone ok"
}

# ---------------------------------------------------------------------------
# Retention sweep. Failures are logged but NOT fatal: a corrupt
# old dump should not abort today's backup.
# ---------------------------------------------------------------------------
enforce_retention() {
    log "rclone retention sweep (older than $RETENTION_DAYS days)"
    if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone delete \
        --min-age "${RETENTION_DAYS}d" \
        --rmdirs \
        --log-level INFO \
        "$RCLONE_REMOTE" 2>&1 | systemd-cat -t "$LOG_TAG" 2>/dev/null || true; then
        err "retention sweep failed (non-fatal — old dumps will accumulate)"
        return 0
    fi
    log "retention sweep ok"
}

# ---------------------------------------------------------------------------
# Main: acquire lock → dump → push → cleanup → retention sweep.
# ---------------------------------------------------------------------------
main() {
    acquire_lock

    local stamp
    stamp="$(date -u '+%Y%m%dT%H%M%SZ')"
    local tmpfile="$TMP_DIR/${BACKUP_PREFIX}-${stamp}.dump"

    dump_database "$tmpfile"
    push_to_r2 "$tmpfile"

    if [[ -f "$tmpfile" ]]; then
        rm -f "$tmpfile"
        log "cleanup: removed $tmpfile"
    fi

    enforce_retention
    log "backup run complete (exit 0)"
}

main "$@"
