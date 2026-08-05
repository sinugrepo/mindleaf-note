#!/usr/bin/env bash
# =============================================================================
# Mindleaf one-command fresh-VPS migration.
#
# Run on a new Ubuntu VPS as root:
#   sudo bash scripts/migrate-vps.sh --env-file /root/mindleaf.env
#
# The script is intentionally infrastructure-only. It does not modify the
# application source; it acquires the repository and invokes bootstrap.sh and
# deploy.sh locally on the target VPS.
#
# Required for a data-preserving migration:
#   --env-file FILE  Existing production .env containing the original
#                    MASTER_ENCRYPTION_KEY, SESSION_SECRET, DATABASE_URL,
#                    R2_* values, and ALLOWED_ORIGIN.
#
# The .env is never printed, committed, regenerated, or replaced when a target
# .env already exists. Without the original MASTER_ENCRYPTION_KEY, encrypted
# notes from the R2 database dump cannot be decrypted after migration.
#
# Optional:
#   --rclone-conf FILE     Existing rclone.conf; otherwise it is generated
#                          from R2_* values in the supplied .env.
#   --backup-object NAME   Exact R2 dump object name. Default: latest .dump.
#   --no-restore           Provision an empty database instead of restoring R2.
#   --source-dir DIR       Use an already available checkout instead of git
#                          cloning the public repository.
#   --repo-url URL         Repository URL (default: GitHub origin).
#   --ref REF              Git branch/tag/commit (default: main).
#   --timeout SEC          Timeout for bootstrap/deploy phases (default: 1200).
#                          A stuck phase is terminated automatically.
#   --skip-public-check    Do not fail if DNS/HTTPS is not ready yet.
#
# The command emits progress continuously and applies a total phase timeout so
# a package manager, migration prompt, or network operation cannot hang forever.
# The final deploy runs as root because this script already owns the migration
# lock and the deployer uses the dedicated mindleaf account for the service.
# =============================================================================

set -Eeuo pipefail
umask 077

INSTALL_ROOT="${INSTALL_ROOT:-/opt/mindleaf}"
REPO_URL="${REPO_URL:-https://github.com/sinugrepo/mindleaf-note.git}"
REPO_REF="${REPO_REF:-main}"
ENV_FILE=""
RCLONE_CONF_FILE=""
BACKUP_OBJECT="latest"
SOURCE_DIR=""
PHASE_TIMEOUT="${MINDLEAF_MIGRATE_TIMEOUT:-1200}"
NO_RESTORE=0
SKIP_PUBLIC_CHECK=0
LOG_FILE=""
LOCK_FILE="/var/lock/mindleaf-migrate.lock"
TMP_DIR=""

usage() {
    sed -n '2,42p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env-file)
            [[ $# -ge 2 ]] || { echo "ERROR: --env-file requires a path" >&2; exit 64; }
            ENV_FILE="$2"; shift 2 ;;
        --rclone-conf)
            [[ $# -ge 2 ]] || { echo "ERROR: --rclone-conf requires a path" >&2; exit 64; }
            RCLONE_CONF_FILE="$2"; shift 2 ;;
        --backup-object)
            [[ $# -ge 2 ]] || { echo "ERROR: --backup-object requires a name" >&2; exit 64; }
            BACKUP_OBJECT="$2"; shift 2 ;;
        --no-restore) NO_RESTORE=1; shift ;;
        --source-dir)
            [[ $# -ge 2 ]] || { echo "ERROR: --source-dir requires a path" >&2; exit 64; }
            SOURCE_DIR="$2"; shift 2 ;;
        --repo-url)
            [[ $# -ge 2 ]] || { echo "ERROR: --repo-url requires a URL" >&2; exit 64; }
            REPO_URL="$2"; shift 2 ;;
        --ref)
            [[ $# -ge 2 ]] || { echo "ERROR: --ref requires a branch, tag, or commit" >&2; exit 64; }
            REPO_REF="$2"; shift 2 ;;
        --timeout)
            [[ $# -ge 2 ]] || { echo "ERROR: --timeout requires seconds" >&2; exit 64; }
            PHASE_TIMEOUT="$2"; shift 2 ;;
        --skip-public-check) SKIP_PUBLIC_CHECK=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done

if [[ $EUID -ne 0 ]]; then
    echo "ERROR: migrate-vps.sh must run as root (use sudo)" >&2
    exit 1
fi
[[ "$PHASE_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: --timeout must be a positive integer" >&2
    exit 64
}
[[ "$INSTALL_ROOT" == /* && "$INSTALL_ROOT" != *[!A-Za-z0-9_./-]* ]] || {
    echo "ERROR: INSTALL_ROOT is invalid" >&2
    exit 64
}
export INSTALL_ROOT

log() { printf '\033[1;32m[migrate]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

install -d -m 0755 /var/lock
exec 9>"$LOCK_FILE"
flock -n 9 || { err "another migration is already running: $LOCK_FILE"; exit 75; }

TMP_DIR="$(mktemp -d /var/tmp/mindleaf-migrate.XXXXXX)"
LOG_FILE="/var/log/mindleaf-migrate-$(date -u '+%Y%m%dT%H%M%SZ').log"
install -m 0600 /dev/null "$LOG_FILE"
exec > >(tee -a "$LOG_FILE") 2>&1

cleanup() {
    local status=$?
    if [[ $status -ne 0 ]]; then
        err "migration failed with exit $status; log: $LOG_FILE"
        systemctl start mindleaf 2>/dev/null || true
    fi
    rm -rf "$TMP_DIR"
    exit "$status"
}
trap cleanup EXIT

step "Checking migration inputs"
if [[ -n "$ENV_FILE" ]]; then
    [[ -f "$ENV_FILE" ]] || { err "secret bundle not found: $ENV_FILE"; exit 66; }
    chmod 600 "$ENV_FILE"
fi

if [[ -f "$INSTALL_ROOT/.env" ]]; then
    if [[ -n "$ENV_FILE" ]] && ! cmp -s "$ENV_FILE" "$INSTALL_ROOT/.env"; then
        err "$INSTALL_ROOT/.env already exists and differs from --env-file"
        err "refusing to mix secret bundles; verify MASTER_ENCRYPTION_KEY and DATABASE_URL before retrying"
        exit 66
    fi
    log "existing $INSTALL_ROOT/.env found — preserving it"
elif [[ -n "$ENV_FILE" ]]; then
    install -d -m 0755 "$INSTALL_ROOT"
    install -m 0600 "$ENV_FILE" "$INSTALL_ROOT/.env"
    log "production .env installed without printing its contents"
else
    err "fresh migration requires --env-file with the original production .env"
    err "do not generate a new MASTER_ENCRYPTION_KEY when restoring existing data"
    exit 66
fi

# Read the trusted operator-supplied env file only in this process. Values are
# never echoed; bootstrap receives only the variables it explicitly requires.
set -a
# shellcheck disable=SC1091
source "$INSTALL_ROOT/.env"
set +a

for required in DATABASE_URL MASTER_ENCRYPTION_KEY SESSION_SECRET R2_ACCOUNT_ID R2_ACCESS_KEY R2_SECRET_KEY ALLOWED_ORIGIN; do
    if [[ -z "${!required:-}" ]]; then
        err "$required is missing from $INSTALL_ROOT/.env"
        exit 66
    fi
done

step "Installing host prerequisites"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends ca-certificates git rsync curl

step "Acquiring repository source"
if [[ -n "$SOURCE_DIR" ]]; then
    [[ -d "$SOURCE_DIR" ]] || { err "source directory not found: $SOURCE_DIR"; exit 66; }
    SOURCE_ROOT="$(cd "$SOURCE_DIR" && pwd -P)"
    log "using local source: $SOURCE_ROOT"
else
    SOURCE_ROOT="$TMP_DIR/source"
    git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SOURCE_ROOT"
    log "cloned repository ref $REPO_REF"
fi

[[ -f "$SOURCE_ROOT/apps/server/.env.production.example" ]] || {
    err "repository does not contain apps/server/.env.production.example"
    exit 66
}

# The target may contain old runtime state. Delete only source-managed paths;
# the explicit excludes preserve secrets, R2 config, dependencies, backups,
# and the installed backup script.
install -d -m 0755 "$INSTALL_ROOT"
rsync -a --delete \
    --exclude='.env' \
    --exclude='.pgpass' \
    --exclude='.config/' \
    --exclude='node_modules/' \
    --exclude='apps/server/dist/' \
    --exclude='apps/web/dist/' \
    --exclude='dist.bak.*' \
    --exclude='.package-manifests.sha256' \
    --exclude='scripts/backup.sh' \
    --exclude='.git/' \
    "$SOURCE_ROOT/" "$INSTALL_ROOT/"

# Restore the preserved env metadata after source sync and ensure the service
# account can read the checkout after bootstrap creates it.
chmod 600 "$INSTALL_ROOT/.env"

if [[ -n "$RCLONE_CONF_FILE" ]]; then
    [[ -f "$RCLONE_CONF_FILE" ]] || { err "rclone config not found: $RCLONE_CONF_FILE"; exit 66; }
    install -d -m 0700 "$INSTALL_ROOT/.config/rclone"
    install -m 0600 "$RCLONE_CONF_FILE" "$INSTALL_ROOT/.config/rclone/rclone.conf"
    log "rclone config installed without printing credentials"
fi

step "Bootstrapping operating system and database"
# bootstrap.sh is idempotent and preserves the supplied .env. Its db:push is
# non-interactive; the deploy phase repeats it after restore so a dump from an
# older schema is upgraded safely. timeout prevents package/migration hangs.
timeout --signal=TERM --kill-after=30s "${PHASE_TIMEOUT}s" \
    bash "$INSTALL_ROOT/deploy/scripts/bootstrap.sh"

step "Validating PostgreSQL and object storage"
BACKUP_R2_BUCKET="${BACKUP_R2_BUCKET:-mindleaf-prod-backups}"
BACKUP_R2_PATH="${BACKUP_R2_PATH:-db}"
RCLONE_REMOTE="${RCLONE_REMOTE:-r2:${BACKUP_R2_BUCKET}/${BACKUP_R2_PATH}}"
pg_isready -h localhost -p 5432 -U mindleaf -d mindleaf
RCLONE_CONFIG="$INSTALL_ROOT/.config/rclone/rclone.conf" \
    rclone lsf --max-depth 1 "r2:$BACKUP_R2_BUCKET" >/dev/null
log "PostgreSQL and R2 connectivity verified"

if [[ $NO_RESTORE -eq 0 ]]; then
    step "Restoring database from R2"
    if [[ "$BACKUP_OBJECT" == "latest" ]]; then
        BACKUP_OBJECT="$(RCLONE_CONFIG="$INSTALL_ROOT/.config/rclone/rclone.conf" \
            rclone lsf --files-only "$RCLONE_REMOTE" \
            | grep -E '\.dump$' | sort | tail -n 1)"
        [[ -n "$BACKUP_OBJECT" ]] || { err "no .dump backup found in $RCLONE_REMOTE"; exit 66; }
    fi
    log "selected R2 backup object: $BACKUP_OBJECT"
    RCLONE_CONFIG="$INSTALL_ROOT/.config/rclone/rclone.conf" \
        rclone copyto "$RCLONE_REMOTE/$BACKUP_OBJECT" "$TMP_DIR/mindleaf.restore.dump"
    install -o mindleaf -g mindleaf -m 0600 "$TMP_DIR/mindleaf.restore.dump" "$INSTALL_ROOT/.mindleaf.restore.dump"

    systemctl stop mindleaf || true
    sudo -u mindleaf env \
        PGHOST=localhost PGPORT=5432 PGUSER=mindleaf PGDATABASE=mindleaf \
        PGPASSFILE="$INSTALL_ROOT/.pgpass" \
        pg_restore --clean --if-exists --no-owner --no-acl --exit-on-error \
        "$INSTALL_ROOT/.mindleaf.restore.dump"
    rm -f "$INSTALL_ROOT/.mindleaf.restore.dump"
    log "database restore complete"
else
    warn "--no-restore specified — leaving a new empty database"
fi

step "Deploying application locally"
timeout --signal=TERM --kill-after=30s "${PHASE_TIMEOUT}s" \
    env DEPLOY_ROOT="$INSTALL_ROOT" bash "$INSTALL_ROOT/scripts/deploy.sh" --timeout 60

step "Final migration checks"
# These checks intentionally do not print credentials or database contents.
pg_isready -h localhost -p 5432 -U mindleaf -d mindleaf
systemctl is-enabled mindleaf >/dev/null
systemctl is-enabled caddy >/dev/null
curl --fail --silent --show-error --max-time 10 http://localhost:8787/healthz
printf '\n'
caddy validate --config /etc/caddy/Caddyfile

PUBLIC_URL="${ALLOWED_ORIGIN%/}"
if [[ $SKIP_PUBLIC_CHECK -eq 0 ]]; then
    if curl --fail --silent --show-error --max-time 20 "$PUBLIC_URL/healthz" >/dev/null; then
        log "public HTTPS healthcheck passed: $PUBLIC_URL/healthz"
    else
        warn "public HTTPS check failed; verify DNS and firewall for $PUBLIC_URL"
        warn "local service is healthy; rerun with --skip-public-check only when DNS is intentionally pending"
        exit 1
    fi
else
    warn "public HTTPS check skipped by operator"
fi

log "one-command VPS migration complete"
log "log: $LOG_FILE"
