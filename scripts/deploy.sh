#!/usr/bin/env bash
# =============================================================================
# Mindleaf VPS-local deployer.
#
# Run this script from the checkout you are editing on the VPS:
#   cd /home/<operator>/mindleaf-note
#   ./scripts/deploy.sh
#
# The checkout is the source of truth for this release. The script builds it,
# copies the release into the canonical runtime tree /opt/mindleaf, stages the
# SPA into /var/www/mindleaf/dist, installs service configuration, and restarts
# the local services. There is no SSH or remote deploy step.
#
# /opt/mindleaf/.env, .pgpass, and .config/ are operational secrets and are
# preserved from the existing runtime tree; they are never copied from the
# editable checkout.
#
# Options:
#   --dry-run       Print the deployment plan without changing anything.
#   --no-migrate    Skip the Drizzle db:push step.
#   --rollback      Restore the newest /opt/mindleaf.bak.* release snapshot.
#   --timeout SEC   Healthcheck timeout (default: 60).
#   --pull          Fetch/pull git before deploying (default: no network pull).
#
# Environment overrides:
#   DEPLOY_ROOT=/opt/mindleaf
#   RUNTIME_USER=mindleaf
# =============================================================================

set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_PATH="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
DEPLOY_ROOT="${DEPLOY_ROOT:-/opt/mindleaf}"
RUNTIME_USER="${RUNTIME_USER:-mindleaf}"
DRY_RUN=0
NO_MIGRATE=0
NO_PULL=1
ROLLBACK=0
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-60}"
KEEP_BACKUPS=2

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)  DRY_RUN=1; shift ;;
        --no-migrate) NO_MIGRATE=1; shift ;;
        --rollback) ROLLBACK=1; shift ;;
        --pull) NO_PULL=0; shift ;;
        --timeout)
            [[ $# -ge 2 ]] || { echo "ERROR: --timeout requires seconds" >&2; exit 64; }
            HEALTHCHECK_TIMEOUT="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *) echo "ERROR: unknown argument: $1" >&2; usage >&2; exit 64 ;;
    esac
done

[[ "$HEALTHCHECK_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || {
    echo "ERROR: --timeout must be a positive integer" >&2
    exit 64
}
[[ "$DEPLOY_ROOT" == /* && "$DEPLOY_ROOT" != *[!A-Za-z0-9_./-]* ]] || {
    echo "ERROR: DEPLOY_ROOT is invalid" >&2
    exit 64
}

log() { printf '\033[1;32m[deploy]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }
run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        printf '\033[1;33m[dry-run]\033[0m'; printf ' %q' "$@"; printf '\n'
    else
        "$@"
    fi
}

cd -- "$REPO_PATH"

[[ -f package.json && -f package-lock.json ]] || {
    echo "ERROR: package.json/package-lock.json missing from $REPO_PATH" >&2
    exit 66
}
[[ -f apps/server/package.json && -f apps/web/package.json ]] || {
    echo "ERROR: workspace package manifests are missing" >&2
    exit 66
}

# Keep the rest of the script readable: as root, `sudo` becomes a no-op;
# as an operator, it remains the normal privilege boundary.
if [[ "$(id -u)" -eq 0 ]]; then
    warn "running as root; prefer the normal operator account with sudo"
    # Keep calls such as `sudo -u postgres ...` working even when sudo
    # itself is unnecessary because this script already has uid 0.
    sudo() {
        if [[ "${1:-}" == "-u" ]]; then
            local target_user="${2:?sudo -u requires a user}"
            shift 2
            runuser -u "$target_user" -- "$@"
        else
            "$@"
        fi
    }
else
    command -v sudo >/dev/null || { err "sudo is required"; exit 69; }
    if [[ $DRY_RUN -eq 0 ]]; then
        # Production bootstrap grants a narrow NOPASSWD sudo policy to the
        # runtime operator. Do not prompt: a locked system user cannot answer
        # a password prompt, and deploy must fail clearly instead.
        sudo -n systemctl --version >/dev/null 2>&1 || {
            err "passwordless sudo is required; run bootstrap.sh or fix the deploy sudoers rule"
            exit 70
        }
    fi
fi

if [[ $DRY_RUN -eq 0 ]]; then
    command -v node >/dev/null || { err "node is required"; exit 69; }
    command -v npm >/dev/null || { err "npm is required"; exit 69; }
    command -v rsync >/dev/null || { err "rsync is required (install it with bootstrap.sh)"; exit 69; }
    id "$RUNTIME_USER" >/dev/null 2>&1 || {
        err "runtime user does not exist: $RUNTIME_USER"; exit 69;
    }
fi

TARGET_ENV="$DEPLOY_ROOT/.env"
BACKEND_DIST="$REPO_PATH/apps/server/dist"
FRONTEND_DIST="$REPO_PATH/apps/web/dist"
FRONTEND_ROOT="/var/www/mindleaf"
FRONTEND_BACKUP_ROOT="/var/www/mindleaf-dist.bak"
STAMP="$(date -u '+%Y%m%d%H%M%S')"
RELEASE_STAGE="$DEPLOY_ROOT.new.$STAMP"
TARGET_BACKUP_PATH=""
FRONTEND_BACKUP_PATH=""
CADDY_BACKUP_PATH=""
SYSTEMD_BACKUP_PATH=""
CRON_BACKUP_PATH=""
DEPLOY_MUTATED=0
CADDY_CONFIG_INSTALLED=0
SYSTEMD_CONFIG_INSTALLED=0
CRON_CONFIG_INSTALLED=0

# A deploy lock prevents two operators (or two shells) from swapping the
# runtime tree at the same time. The lock file itself contains no secrets.
DEPLOY_LOCK_FILE="${TMPDIR:-/tmp}/mindleaf-deploy-${RUNTIME_USER}.lock"
exec 9>"$DEPLOY_LOCK_FILE"
flock -n 9 || { err "another deployment is already running: $DEPLOY_LOCK_FILE"; exit 75; }

restore_release() {
    if [[ -n "$TARGET_BACKUP_PATH" ]] && sudo test -d "$TARGET_BACKUP_PATH"; then
        log "restoring runtime release $TARGET_BACKUP_PATH"
        if sudo test -e "$DEPLOY_ROOT"; then
            sudo mv "$DEPLOY_ROOT" "$DEPLOY_ROOT.failed.$STAMP"
        fi
        sudo mv "$TARGET_BACKUP_PATH" "$DEPLOY_ROOT"
    fi
    if [[ -n "$FRONTEND_BACKUP_PATH" ]] && sudo test -d "$FRONTEND_BACKUP_PATH"; then
        log "restoring frontend $FRONTEND_BACKUP_PATH"
        if sudo test -d "$FRONTEND_ROOT/dist"; then
            sudo mv "$FRONTEND_ROOT/dist" "$FRONTEND_ROOT/dist.failed.$STAMP"
        fi
        sudo mv "$FRONTEND_BACKUP_PATH" "$FRONTEND_ROOT/dist"
    fi
    if [[ -n "$CADDY_BACKUP_PATH" ]] && sudo test -f "$CADDY_BACKUP_PATH"; then
        sudo cp "$CADDY_BACKUP_PATH" /etc/caddy/Caddyfile
    elif [[ "$CADDY_CONFIG_INSTALLED" -eq 1 ]]; then
        sudo rm -f /etc/caddy/Caddyfile
    fi
    if [[ -n "$SYSTEMD_BACKUP_PATH" ]] && sudo test -f "$SYSTEMD_BACKUP_PATH"; then
        sudo cp "$SYSTEMD_BACKUP_PATH" /etc/systemd/system/mindleaf.service
    elif [[ "$SYSTEMD_CONFIG_INSTALLED" -eq 1 ]]; then
        sudo rm -f /etc/systemd/system/mindleaf.service
    fi
    if [[ -n "$CRON_BACKUP_PATH" ]] && sudo test -f "$CRON_BACKUP_PATH"; then
        sudo cp "$CRON_BACKUP_PATH" /etc/cron.d/mindleaf-backup
    elif [[ "$CRON_CONFIG_INSTALLED" -eq 1 ]]; then
        sudo rm -f /etc/cron.d/mindleaf-backup
    fi
}

on_error() {
    local status=$?
    trap - ERR
    if [[ $status -ne 0 && $DRY_RUN -eq 0 && $DEPLOY_MUTATED -eq 1 ]]; then
        err "deployment failed (exit $status); restoring the previous release"
        if restore_release; then
            sudo systemctl daemon-reload
            sudo systemctl reload caddy || true
            sudo systemctl restart mindleaf
        else
            err "automatic rollback failed; inspect *.failed.* and journalctl -u mindleaf"
        fi
    fi
    exit "$status"
}
trap on_error ERR

if [[ $ROLLBACK -eq 1 ]]; then
    step "Rolling back latest runtime release"
    if [[ $DRY_RUN -eq 1 ]]; then
        log "would restore the newest $DEPLOY_ROOT.bak.* and frontend backup"
    else
        TARGET_BACKUP_PATH="$(find "$(dirname "$DEPLOY_ROOT")" -maxdepth 1 -type d -name "$(basename "$DEPLOY_ROOT").bak.*" -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
        FRONTEND_BACKUP_PATH="$(sudo find "$FRONTEND_BACKUP_ROOT" -maxdepth 1 -type d -name 'dist.bak.*' -printf '%T@ %p\n' 2>/dev/null | sort -nr | head -n1 | cut -d' ' -f2- || true)"
        [[ -n "$TARGET_BACKUP_PATH" ]] || { err "no runtime backup found for $DEPLOY_ROOT"; exit 66; }
        restore_release
        CADDY_DOMAIN="$(awk -F= '$1 == "ALLOWED_ORIGIN" { value=$2; sub(/^\047/, "", value); sub(/\047$/, "", value); sub(/^\042/, "", value); sub(/\042$/, "", value); sub(/\/$/, "", value); sub(/^https?:\/\//, "", value); print value; exit }' "$DEPLOY_ROOT/.env")"
        [[ "$CADDY_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { err "ALLOWED_ORIGIN must contain a valid hostname for Caddy"; exit 66; }
        sed "s#__MINDLEAF_DOMAIN__#$CADDY_DOMAIN#" "$DEPLOY_ROOT/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
        sed "s#/opt/mindleaf#$DEPLOY_ROOT#g" "$DEPLOY_ROOT/deploy/systemd/mindleaf.service" | sudo tee /etc/systemd/system/mindleaf.service >/dev/null
        sed "s#/opt/mindleaf#$DEPLOY_ROOT#g" "$DEPLOY_ROOT/deploy/cron.d/mindleaf-backup" | sudo tee /etc/cron.d/mindleaf-backup >/dev/null
        sudo caddy validate --config /etc/caddy/Caddyfile
        sudo systemctl daemon-reload
        sudo systemctl reload caddy
        sudo systemctl restart mindleaf
        curl --fail --silent --show-error --max-time 10 http://localhost:8787/healthz
        printf '\n'
        log "rollback complete"
    fi
    exit 0
fi

if [[ $DRY_RUN -eq 0 && ! -f "$TARGET_ENV" ]]; then
    err "$TARGET_ENV is missing; run bootstrap.sh/migrate-vps.sh first"
    err "the editable checkout's .env is intentionally not used or copied"
    exit 66
fi

step "Checking local VPS prerequisites"
log "editable checkout: $REPO_PATH"
log "runtime target: $DEPLOY_ROOT"
log "frontend target: $FRONTEND_ROOT/dist"

step "Updating checked-out release"
if [[ $NO_PULL -eq 1 ]]; then
    log "--no-pull: keeping the current working tree"
else
    run git fetch --tags --prune origin
    run git pull --ff-only
fi

step "Installing workspace dependencies in the editable checkout"
MANIFEST_HASH="$(sha256sum package-lock.json package.json apps/server/package.json apps/web/package.json packages/shared/package.json | sha256sum | cut -d' ' -f1)"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would compare .package-manifests.sha256 and run npm ci --include=dev if needed"
else
    if [[ -d node_modules && -f .package-manifests.sha256 && "$(cat .package-manifests.sha256)" == "$MANIFEST_HASH" ]]; then
        log "dependencies unchanged — skipping npm ci"
    else
        log "installing dependencies in $REPO_PATH"
        env HOME="${HOME:-/home/$(id -un)}" npm_config_cache="${HOME:-/home/$(id -un)}/.npm" \
            env -u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT \
            npm ci --include=dev --prefer-offline --no-audit --no-fund
        printf '%s\n' "$MANIFEST_HASH" > .package-manifests.sha256.tmp
        mv .package-manifests.sha256.tmp .package-manifests.sha256
    fi
fi

step "Building backend in the editable checkout"
run npm run lint --workspace=@mindleaf/server
if [[ $DRY_RUN -eq 1 ]]; then
    log "would clean and build $BACKEND_DIST"
else
    rm -rf "$BACKEND_DIST"
    mkdir -p "$BACKEND_DIST"
fi
run npm run build --workspace=@mindleaf/server

step "Building frontend in the editable checkout"
run npm run lint --workspace=@mindleaf/web
run npm run build --workspace=@mindleaf/web

step "Preparing release copy for $DEPLOY_ROOT"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would rsync the current checkout to $RELEASE_STAGE"
    log "would preserve $TARGET_ENV, .pgpass, and .config/ from the runtime target"
else
    sudo rm -rf "$RELEASE_STAGE"
    sudo mkdir -p "$RELEASE_STAGE"
    sudo chown "$(id -u):$(id -g)" "$RELEASE_STAGE"
    # Keep node_modules: the runtime starts from /opt/mindleaf and needs the
    # workspace dependency tree, including the @mindleaf/shared link.
    rsync -a --delete \
        --exclude '.git/' \
        --exclude '.env' \
        --exclude '.pgpass' \
        --exclude '.config/' \
        --exclude 'apps/server/dist.bak.*/' \
        --exclude 'apps/server/dist.failed.*/' \
        --exclude 'apps/web/dist.failed.*/' \
        "$REPO_PATH/" "$RELEASE_STAGE/"
    sudo cp -a "$TARGET_ENV" "$RELEASE_STAGE/.env"
    if sudo test -f "$DEPLOY_ROOT/.pgpass"; then
        sudo cp -a "$DEPLOY_ROOT/.pgpass" "$RELEASE_STAGE/.pgpass"
    fi
    if sudo test -d "$DEPLOY_ROOT/.config"; then
        sudo cp -a "$DEPLOY_ROOT/.config" "$RELEASE_STAGE/.config"
    fi
    sudo chown -R "$RUNTIME_USER:$RUNTIME_USER" "$RELEASE_STAGE"
fi

step "Staging frontend atomically"
run sudo mkdir -p "$FRONTEND_ROOT" "$FRONTEND_BACKUP_ROOT"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would copy $FRONTEND_DIST to an atomic frontend stage"
else
    # Mark the deployment as mutable before moving the current frontend;
    # any failure after this point must restore the previous dist snapshot.
    DEPLOY_MUTATED=1
    FRONTEND_STAGE="$FRONTEND_ROOT/.dist.new.$STAMP"
    sudo rm -rf "$FRONTEND_STAGE"
    sudo mkdir -p "$FRONTEND_STAGE"
    sudo cp -a "$FRONTEND_DIST/." "$FRONTEND_STAGE/"
    sudo chown -R "$RUNTIME_USER:$RUNTIME_USER" "$FRONTEND_STAGE"
    if sudo test -d "$FRONTEND_ROOT/dist"; then
        FRONTEND_BACKUP_PATH="$FRONTEND_BACKUP_ROOT/dist.bak.$STAMP"
        sudo mv "$FRONTEND_ROOT/dist" "$FRONTEND_BACKUP_PATH"
    fi
    sudo mv "$FRONTEND_STAGE" "$FRONTEND_ROOT/dist"
fi

step "Installing runtime release and service configuration"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would snapshot $DEPLOY_ROOT to $DEPLOY_ROOT.bak.$STAMP and activate $RELEASE_STAGE"
    log "would validate/install Caddy, systemd, and cron from the current checkout"
else
    if sudo test -d "$DEPLOY_ROOT"; then
        TARGET_BACKUP_PATH="$DEPLOY_ROOT.bak.$STAMP"
        sudo mv "$DEPLOY_ROOT" "$TARGET_BACKUP_PATH"
    fi
    sudo mv "$RELEASE_STAGE" "$DEPLOY_ROOT"
    DEPLOY_MUTATED=1

    CADDY_BACKUP_PATH="/tmp/mindleaf-Caddyfile.$STAMP.bak"
    SYSTEMD_BACKUP_PATH="/tmp/mindleaf-systemd.$STAMP.bak"
    CRON_BACKUP_PATH="/tmp/mindleaf-cron.$STAMP.bak"
    sudo test -f /etc/caddy/Caddyfile && sudo cp /etc/caddy/Caddyfile "$CADDY_BACKUP_PATH" || true
    sudo test -f /etc/systemd/system/mindleaf.service && sudo cp /etc/systemd/system/mindleaf.service "$SYSTEMD_BACKUP_PATH" || true
    sudo test -f /etc/cron.d/mindleaf-backup && sudo cp /etc/cron.d/mindleaf-backup "$CRON_BACKUP_PATH" || true

    CADDY_DOMAIN=""
    if [[ -f "$TARGET_ENV" ]]; then
        CADDY_DOMAIN="$(awk -F= '$1 == "ALLOWED_ORIGIN" { value=$2; sub(/^\047/, "", value); sub(/\047$/, "", value); sub(/^\042/, "", value); sub(/\042$/, "", value); sub(/\/$/, "", value); sub(/^https?:\/\//, "", value); print value; exit }' "$TARGET_ENV")"
    fi
    [[ "$CADDY_DOMAIN" =~ ^[A-Za-z0-9.-]+$ ]] || { err "ALLOWED_ORIGIN must contain a valid hostname for Caddy"; exit 66; }
    sed "s#__MINDLEAF_DOMAIN__#$CADDY_DOMAIN#" "$DEPLOY_ROOT/deploy/Caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
    CADDY_CONFIG_INSTALLED=1
    sudo caddy validate --config /etc/caddy/Caddyfile
    sudo systemctl reload caddy || sudo systemctl start caddy

    sed "s#/opt/mindleaf#$DEPLOY_ROOT#g" "$DEPLOY_ROOT/deploy/systemd/mindleaf.service" | sudo tee /etc/systemd/system/mindleaf.service >/dev/null
    SYSTEMD_CONFIG_INSTALLED=1
    sed "s#/opt/mindleaf#$DEPLOY_ROOT#g" "$DEPLOY_ROOT/deploy/cron.d/mindleaf-backup" | sudo tee /etc/cron.d/mindleaf-backup >/dev/null
    CRON_CONFIG_INSTALLED=1
    sudo systemctl daemon-reload
    sudo systemctl enable mindleaf caddy
fi

if [[ $NO_MIGRATE -eq 0 ]]; then
    step "Applying database schema"
    if [[ $DRY_RUN -eq 1 ]]; then
        log "would source $TARGET_ENV and run npm run db:push --workspace=@mindleaf/server -- --force"
    else
        set -a
        # shellcheck disable=SC1091
        source "$TARGET_ENV"
        set +a
        env -u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT \
            npm run db:push --workspace=@mindleaf/server -- --force
    fi
else
    warn "--no-migrate specified; skipping db:push"
fi

step "Restarting local backend"
run sudo systemctl restart mindleaf

step "Healthcheck"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would poll http://localhost:8787/healthz for ${HEALTHCHECK_TIMEOUT}s"
else
    HEALTHCHECK_OK=0
    TRIALS=$(( (HEALTHCHECK_TIMEOUT + 1) / 2 ))
    for _ in $(seq 1 "$TRIALS"); do
        if curl --fail --silent --show-error --max-time 5 http://localhost:8787/healthz >/dev/null; then
            HEALTHCHECK_OK=1
            break
        fi
        sleep 2
    done
    if [[ $HEALTHCHECK_OK -ne 1 ]]; then
        err "backend healthcheck failed; automatic rollback will run"
        exit 1
    fi
    curl --fail --silent --show-error http://localhost:8787/healthz
    printf '\n'
fi

step "Pruning old release backups"
if [[ $DRY_RUN -eq 1 ]]; then
    log "would keep the newest $KEEP_BACKUPS runtime/frontend backups"
else
    find "$(dirname "$DEPLOY_ROOT")" -maxdepth 1 -type d -name "$(basename "$DEPLOY_ROOT").bak.*" -printf '%T@ %p\n' \
        | sort -nr | tail -n +$((KEEP_BACKUPS + 1)) | cut -d' ' -f2- | xargs -r sudo rm -rf
    sudo find "$FRONTEND_BACKUP_ROOT" -maxdepth 1 -type d -name 'dist.bak.*' -printf '%T@ %p\n' \
        | sort -nr | tail -n +$((KEEP_BACKUPS + 1)) | cut -d' ' -f2- | xargs -r sudo rm -rf
    sudo rm -f "$CADDY_BACKUP_PATH" "$SYSTEMD_BACKUP_PATH" "$CRON_BACKUP_PATH"
fi

DEPLOY_MUTATED=0
log "deployment complete on this VPS"
log "source: $REPO_PATH"
log "runtime: $DEPLOY_ROOT"
log "frontend: $FRONTEND_ROOT/dist"
log "health: http://localhost:8787/healthz"
