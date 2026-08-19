#!/usr/bin/env bash
# =============================================================================
# Phase 9 — Daily database backup: pg_dump → rclone to Cloudflare R2.
#
# Usage:
#   /opt/mindleaf/deploy/scripts/backup.sh            # run manually
#   sudo -u mindleaf /opt/mindleaf/deploy/scripts/backup.sh
#
# Designed for:
#   - cron.d daily at 07:00 WIB (deploy/cron.d/mindleaf-backup)
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
INSTALL_ROOT="${INSTALL_ROOT:-/opt/mindleaf}"
PGPASSFILE="${PGPASSFILE:-$INSTALL_ROOT/.pgpass}"

# The runtime env is the source of truth for the backup bucket/path. It is
# loaded only in this process and never printed; explicit RCLONE_REMOTE still
# wins for emergency/manual overrides.
if [[ -f "$INSTALL_ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$INSTALL_ROOT/.env"
    set +a
fi
BACKUP_R2_BUCKET="${BACKUP_R2_BUCKET:-mindleaf-prod-backups}"
BACKUP_R2_PATH="${BACKUP_R2_PATH:-db}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2:${BACKUP_R2_BUCKET}/${BACKUP_R2_PATH}}"
RCLONE_CONFIG="${RCLONE_CONFIG:-$INSTALL_ROOT/.config/rclone/rclone.conf}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"

# Telegram is an alert channel only. The dump is never uploaded to Telegram;
# R2 remains the primary backup destination. Both values are optional until
# the operator configures the bot in /opt/mindleaf/.env.
TELEGRAM_BOT_TOKEN="${TELEGRAM_BOT_TOKEN:-}"
TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-}"
TELEGRAM_API_BASE_URL="${TELEGRAM_API_BASE_URL:-https://api.telegram.org}"
TELEGRAM_ALERT_RETRIES="${TELEGRAM_ALERT_RETRIES:-3}"
TELEGRAM_ALERT_TIMEOUT="${TELEGRAM_ALERT_TIMEOUT:-15}"

LOCK_FILE="${LOCK_FILE:-/var/lock/mindleaf-backup.lock}"
TMP_DIR="${TMP_DIR:-/var/tmp}"
BACKUP_PREFIX="${BACKUP_PREFIX:-mindleaf}"
LOG_TAG="${LOG_TAG:-mindleaf-backup}"
LAST_ERROR=""
BACKUP_ALERT_REASON=""
ACTIVE_TMPFILE=""

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
    LAST_ERROR="$*"
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

    # Avoid embedding a password in the command line. bootstrap.sh stores
    # the credentials at "$INSTALL_ROOT/.pgpass", so pass the path explicitly;
    # cron's HOME is not a stable contract for locating .pgpass.
    if ! PGPASSFILE="$PGPASSFILE" pg_dump \
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
    local rclone_status=0
    RCLONE_CONFIG="$RCLONE_CONFIG" rclone copyto \
        --retries 3 \
        --low-level-retries 5 \
        --s3-upload-cutoff 100M \
        --s3-chunk-size 50M \
        --stats 30s \
        --stats-one-line \
        --log-level INFO \
        "$src" "$RCLONE_REMOTE/$dest_name" 2>&1 \
        | systemd-cat -t "$LOG_TAG" 2>/dev/null || rclone_status=$?

    # Verify the object independently because the logging pipe otherwise
    # masks rclone's exit status.
    if [[ $rclone_status -ne 0 ]] || ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone lsjson "$RCLONE_REMOTE/$dest_name" >/dev/null 2>&1; then
        err "rclone copy verification failed — $dest_name NOT in $RCLONE_REMOTE"
        exit 2
    fi
    log "rclone ok"
}

# ---------------------------------------------------------------------------
# Telegram alert delivery. This sends only a short failure/warning message;
# the database dump remains in R2. The token is passed to curl without being
# printed in logs, and each attempt has a bounded timeout.
# ---------------------------------------------------------------------------
escape_html() {
    local value="$1"
    value="${value//&/&amp;}"
    value="${value//</&lt;}"
    value="${value//>/&gt;}"
    printf '%s' "$value"
}

send_telegram_alert() {
    local reason="$1"
    local detail="${2:-$LAST_ERROR}"
    if [[ -z "$TELEGRAM_BOT_TOKEN" || -z "$TELEGRAM_CHAT_ID" ]]; then
        err "Telegram alert skipped: TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID must both be configured"
        return 1
    fi

    local host_name
    host_name="$(hostname -s 2>/dev/null || hostname)"
    local safe_host safe_reason safe_detail safe_r2
    safe_host="$(escape_html "$host_name")"
    safe_reason="$(escape_html "$reason")"
    safe_detail="$(escape_html "$detail")"
    safe_r2="$(escape_html "$RCLONE_REMOTE")"

    local text
    printf -v text '<b>🚨 Mindleaf Backup Alert</b>\n\n<b>Status:</b> <code>ANOMALY</code>\n<b>Waktu:</b> %s UTC\n<b>Host:</b> <code>%s</code>\n\n<b>Alasan</b>\n%s\n\n<b>Detail</b>\n<code>%s</code>\n\n<b>R2</b>\n<code>%s</code>' \
        "$(date -u '+%F %T')" "$safe_host" "$safe_reason" "$safe_detail" "$safe_r2"
    local api_url="${TELEGRAM_API_BASE_URL%/}/bot${TELEGRAM_BOT_TOKEN}/sendMessage"
    local response=""
    local attempt

    for attempt in $(seq 1 "$TELEGRAM_ALERT_RETRIES"); do
        if response="$(curl \
            --silent \
            --show-error \
            --fail \
            --connect-timeout 5 \
            --max-time "$TELEGRAM_ALERT_TIMEOUT" \
            --data-urlencode "chat_id=$TELEGRAM_CHAT_ID" \
            --data-urlencode "parse_mode=HTML" \
            --data-urlencode "text=$text" \
            "$api_url" 2>/dev/null)" && \
            grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' <<<"$response"; then
            log "Telegram alert delivered (attempt $attempt)"
            return 0
        fi
        [[ "$attempt" -lt "$TELEGRAM_ALERT_RETRIES" ]] && sleep $((attempt * 2))
    done

    err "Telegram alert delivery failed after $TELEGRAM_ALERT_RETRIES attempts"
    return 1
}

# ---------------------------------------------------------------------------
# Retention sweep. Failures are non-fatal for the current backup, but they
# are surfaced to Telegram as an operational warning.
# ---------------------------------------------------------------------------
enforce_retention() {
    log "rclone retention sweep (older than $RETENTION_DAYS days)"
    if ! RCLONE_CONFIG="$RCLONE_CONFIG" rclone delete \
        --min-age "${RETENTION_DAYS}d" \
        --rmdirs \
        --log-level INFO \
        "$RCLONE_REMOTE" 2>&1 | systemd-cat -t "$LOG_TAG" 2>/dev/null; then
        BACKUP_ALERT_REASON="R2 retention sweep failed; old dumps may accumulate"
        err "$BACKUP_ALERT_REASON"
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
    ACTIVE_TMPFILE="$tmpfile"

    dump_database "$tmpfile"
    push_to_r2 "$tmpfile"

    if [[ -f "$tmpfile" ]]; then
        rm -f "$tmpfile"
        log "cleanup: removed $tmpfile"
    fi
    ACTIVE_TMPFILE=""

    enforce_retention
    log "backup run complete (exit 0)"
}

on_exit() {
    local status=$?
    trap - EXIT

    if [[ -n "$ACTIVE_TMPFILE" && -f "$ACTIVE_TMPFILE" ]]; then
        rm -f "$ACTIVE_TMPFILE"
        log "cleanup: removed incomplete $ACTIVE_TMPFILE"
    fi

    # Exit 4 means another backup is already running; avoid duplicate noise.
    if [[ "$status" -ne 0 && "$status" -ne 4 ]]; then
        send_telegram_alert "Backup failed (exit $status)" "${LAST_ERROR:-backup script exited unexpectedly}" || true
    elif [[ "$status" -eq 0 && -n "$BACKUP_ALERT_REASON" ]]; then
        send_telegram_alert "Backup completed with warning" "$BACKUP_ALERT_REASON" || true
    fi

    exit "$status"
}
trap on_exit EXIT

main "$@"
