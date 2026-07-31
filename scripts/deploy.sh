#!/usr/bin/env bash
# =============================================================================
# Phase 9 — Production deployer for Mindleaf.
#
# Runs from your LOCAL machine, pushes to the VPS via SSH + rsync.
# Idempotent: re-runnable. Safe-by-default with --dry-run.
#
# Usage:
#   scripts/deploy.sh --vps mindleaf@example.com
#   scripts/deploy.sh --vps mindleaf@example.com --dry-run        # simulate
#   scripts/deploy.sh --vps mindleaf@example.com --no-migrate     # skip db:push
#   scripts/deploy.sh --vps mindleaf@example.com --rollback        # restore prev build
#
# Required env (or flags):
#   VPS_HOST       user@host (e.g. mindleaf@1.2.3.4 or mindleaf@mydomain.com)
#   REPO_PATH      path on VPS where repo lives (default /opt/mindleaf)
#
# Steps (real run; --dry-run echoes only):
#   1. Verify VPS prerequisites (systemd unit, postgresql up, .env present)
#   2. git pull --ff-only on VPS
#   3. npm ci at repo root + apps/server front-end-only install
#   4. npm run build (apps/server tsc → dist/)
#   5. npm run build (apps/web vite → dist/)
#   6. rsync SPA dist → /var/www/mindleaf/dist/ on VPS
#   7. rsync + install systemd unit, Caddyfile, cron file
#   8. systemctl daemon-reload + restart mindleaf
#   9. db:push (unless --no-migrate)
#  10. Healthcheck loop: poll http://localhost:8787/healthz up to 60s.
#      Auto-rollback if unhealthy.
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
DRY_RUN=0
NO_MIGRATE=0
ROLLBACK=0
VPS_HOST="${VPS_HOST:-}"
REPO_PATH="${REPO_PATH:-/opt/mindleaf}"
HEALTHCHECK_TIMEOUT="${HEALTHCHECK_TIMEOUT:-60}"

usage() {
    sed -n '2,30p' "$0" | sed 's/^# \?//'
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)         DRY_RUN=1; shift ;;
        --no-migrate)      NO_MIGRATE=1; shift ;;
        --rollback)        ROLLBACK=1; shift ;;
        --vps)             VPS_HOST="$2"; shift 2 ;;
        --repo-path)       REPO_PATH="$2"; shift 2 ;;
        --timeout)         HEALTHCHECK_TIMEOUT="$2"; shift 2 ;;
        -h|--help)         usage; exit 0 ;;
        *) echo "Unknown arg: $1" >&2; usage >&2; exit 64 ;;
    esac
done

[[ -n "$VPS_HOST" ]] || { echo "ERROR: --vps user@host required" >&2; usage >&2; exit 64; }

# ---------------------------------------------------------------------------
# Helpers — execute or echo depending on DRY_RUN.
# ---------------------------------------------------------------------------
run() {
    if [[ $DRY_RUN -eq 1 ]]; then
        printf '\033[1;33m[dry-run]\033[0m %s\n' "$*"
    else
        printf '\033[1;32m[run]\033[0m %s\n' "$*"
        "$@"
    fi
}

ssh_run() {
    # `ssh -A` would forward the agent for git ops; we use ssh keys
    # directly (deploy user has passwordless key for the mindleaf user)
    # so the default key auth is fine. BatchMode=yes avoids password
    # prompts aborting the script.
    run ssh -o StrictHostKeyChecking=accept-new \
             -o BatchMode=yes \
             -o ConnectTimeout=10 \
             -- "$VPS_HOST" -- "$1"
}

rsync_to() {
    # rsync with --delete wouldn't be appropriate for /opt/mindleaf
    # because we'd blow away .env and scripts/backup.sh. We use rsync
    # to push ONLY specific sub-trees; the deploy/ subtree is mirrored.
    local src="$1" dst="$2"
    run rsync -az \
        --rsync-path="sudo rsync" \
        --chmod=D0755,F0644 \
        "$src" "$VPS_HOST:$dst"
}

step() {
    printf '\n\033[1;36m=== %s ===\033[0m\n' "$1"
}

cleanup_on_error() {
    local exit_code=$?
    if [[ $exit_code -ne 0 && $DRY_RUN -eq 0 ]]; then
        printf '\n\033[1;31m[FATAL] deploy failed with exit %d\033[0m\n' "$exit_code" >&2
        printf 'Recovery: re-run with --rollback to restore the previous build.\n' >&2
        printf '  $ %s --vps %s --rollback\n' "$0" "$VPS_HOST" >&2
    fi
}
trap cleanup_on_error EXIT

# ---------------------------------------------------------------------------
# Rollback path — restore from the most recent dist.bak.<timestamp>
# ---------------------------------------------------------------------------
if [[ $ROLLBACK -eq 1 ]]; then
    step "Rolling back to previous build"
    ssh_run "ls -dt /opt/mindleaf/apps/server/dist.bak.* 2>/dev/null | head -n1"
    LATEST_BAK="$(ssh_run 'ls -dt /opt/mindleaf/apps/server/dist.bak.* 2>/dev/null | head -n1')"
    if [[ -z "$LATEST_BAK" ]]; then
        echo "ERROR: no dist.bak.* snapshots found" >&2
        exit 1
    fi
    ssh_run "sudo mv /opt/mindleaf/apps/server/dist /opt/mindleaf/apps/server/dist.failed.$(date +%s) && sudo mv '$LATEST_BAK' /opt/mindleaf/apps/server/dist && sudo systemctl restart mindleaf"
    printf '\n\033[1;32m[ok]\033[0m rolled back to %s\n' "$LATEST_BAK"
    exit 0
fi

# ---------------------------------------------------------------------------
# Step 1 — prereqs
# ---------------------------------------------------------------------------
step "Verifying VPS prerequisites"
ssh_run "test -d '$REPO_PATH' && test -f '$REPO_PATH/.env' && systemctl is-active postgresql >/dev/null && which node && node --version"

# Pre-flight: confirm the deploy user can run restricted sudo commands
# without a password prompt. bootstrap.sh provisions a sudoers drop-in
# granting `mindleaf ALL=(ALL) NOPASSWD: /bin/systemctl * mindleaf,
# /usr/bin/rsync`. If the host is misconfigured, restart + rsync
# below would hang forever on a tty password. Fail fast instead.
if [[ $DRY_RUN -eq 1 ]]; then
    # DRY_RUN echoes only — claiming `passwordless sudo confirmed`
    # without ever SSH'ing would mislead the operator. Skip with a hint.
    printf '\033[1;33m[dry-run]\033[0m skipping passwordless sudo pre-flight (no ssh)\n'
elif ! ssh_run "sudo -n true" >/dev/null 2>&1; then
    printf '\033[1;31m[FATAL]\033[0m passwordless sudo not configured for %s\n' "$VPS_HOST" >&2
    printf 'Fix on VPS with: \n' >&2
    printf '  sudo tee /etc/sudoers.d/mindleaf-deploy >/dev/null <<EOF\n' >&2
    printf '  %%mindleaf ALL=(ALL) NOPASSWD: /bin/systemctl * mindleaf, /usr/bin/rsync\n' >&2
    printf '  EOF\n' >&2
    printf '  sudo chmod 440 /etc/sudoers.d/mindleaf-deploy\n' >&2
    exit 70
else
    printf '\033[1;32m[ok]\033[0m passwordless sudo confirmed\n'
fi

PRE_TAG="$(ssh_run "cd '$REPO_PATH' && git describe --tags --always 2>/dev/null || echo none")"
PRE_BUILT_AT="$(date -u '+%F %T')"
printf 'pre-deploy:  rev=%s  start=%s UTC\n' "$PRE_TAG" "$PRE_BUILT_AT"

# ---------------------------------------------------------------------------
# Step 2 — git pull
# ---------------------------------------------------------------------------
step "git pull (--ff-only)"
ssh_run "cd '$REPO_PATH' && git fetch --tags --prune origin && git pull --ff-only"

# ---------------------------------------------------------------------------
# Step 3 — npm install
# ---------------------------------------------------------------------------
step "Installing dependencies (full workspace)"
ssh_run "cd '$REPO_PATH' && npm ci"

step "Installing apps/server prod-only deps (smaller node_modules)"
ssh_run "cd '$REPO_PATH/apps/server' && npm install --omit=dev"

# ---------------------------------------------------------------------------
# Step 4 — typecheck + build (with rollback-friendly backup)
# ---------------------------------------------------------------------------
step "Type-checking + building backend"
ssh_run "cd '$REPO_PATH' && npm run lint --workspace=@mindleaf/server"

# Snapshot the previous dist before we overwrite it — gives deploy.sh
# --rollback something to restore. Use sudo only when needed (mindleaf
# owns its own dir).
ssh_run "if [[ -d /opt/mindleaf/apps/server/dist ]]; then sudo mv /opt/mindleaf/apps/server/dist /opt/mindleaf/apps/server/dist.bak.\$(date +%s); fi"
ssh_run "cd '$REPO_PATH/apps/server' && npm run build"

# ---------------------------------------------------------------------------
# Step 5 — frontend build
# ---------------------------------------------------------------------------
step "Building frontend SPA"
ssh_run "cd '$REPO_PATH' && npm ci --workspace=@mindleaf/web"
ssh_run "cd '$REPO_PATH/apps/web' && npm run build"

# ---------------------------------------------------------------------------
# Step 6 — rsync SPA to /var/www/mindleaf/dist
# ---------------------------------------------------------------------------
step "rsync SPA dist → /var/www/mindleaf/dist"
ssh_run "sudo mkdir -p /var/www/mindleaf && sudo chown mindleaf:mindleaf /var/www/mindleaf"
# Push from local (the SPA dist was generated locally if you're running
# deploy.sh on the host that built it; otherwise we just rsync from VPS).
# We use the local repo's apps/web/dist if it exists, else fall back to
# building on the VPS.
if [[ -d apps/web/dist ]]; then
    run rsync -az --delete \
        --rsync-path="sudo rsync" \
        apps/web/dist/ "$VPS_HOST:/var/www/mindleaf/dist/"
else
    ssh_run "sudo rsync -a --delete $REPO_PATH/apps/web/dist/ /var/www/mindleaf/dist/"
fi

# ---------------------------------------------------------------------------
# Step 7 — install systemd unit + Caddyfile + cron
# ---------------------------------------------------------------------------
step "Installing systemd unit"
# Push the unit file from local repo to VPS, then sudo install.
rsync_to deploy/systemd/mindleaf.service /opt/mindleaf/deploy/systemd/mindleaf.service
ssh_run "sudo install -m 644 /opt/mindleaf/deploy/systemd/mindleaf.service /etc/systemd/system/mindleaf.service"
ssh_run "sudo systemctl daemon-reload"

step "Installing Caddyfile"
rsync_to deploy/Caddyfile /opt/mindleaf/deploy/Caddyfile
ssh_run "sudo install -m 644 /opt/mindleaf/deploy/Caddyfile /etc/caddy/Caddyfile"
ssh_run "sudo caddy validate --config /etc/caddy/Caddyfile"
# Reload (not restart) — Caddy is zero-downtime.
ssh_run "sudo systemctl reload caddy"

step "Installing backup script + cron entry"
rsync_to deploy/scripts/backup.sh /opt/mindleaf/deploy/scripts/backup.sh
ssh_run "sudo install -m 755 /opt/mindleaf/deploy/scripts/backup.sh /opt/mindleaf/scripts/backup.sh"
ssh_run "sudo install -m 644 /opt/mindleaf/deploy/cron.d/mindleaf-backup /etc/cron.d/mindleaf-backup"

# ---------------------------------------------------------------------------
# Step 8 — db:push (unless skipped)
# ---------------------------------------------------------------------------
if [[ $NO_MIGRATE -eq 0 ]]; then
    step "Applying database schema (db:push)"
    ssh_run "cd '$REPO_PATH' && sudo -u mindleaf -E bash -c 'set -a; source /opt/mindleaf/.env; set +a; cd apps/server && npm run db:push'"
else
    printf '\n\033[1;33m[skip]\033[0m --no-migrate: skipping db:push\n'
fi

# ---------------------------------------------------------------------------
# Step 9 — restart + healthcheck
# ---------------------------------------------------------------------------
step "Restarting mindleaf.service"
ssh_run "sudo systemctl restart mindleaf"

step "Healthcheck (timeout=${HEALTHCHECK_TIMEOUT}s)"
HEALTHCHECK_OK=0
trials=$(( HEALTHCHECK_TIMEOUT / 2 ))
for i in $(seq 1 "$trials"); do
    if ssh_run "curl -fsS http://localhost:8787/healthz" >/dev/null 2>&1; then
        printf '\033[1;32m[ok]\033[0m backend healthy after %d attempt(s)\n' "$i"
        HEALTHCHECK_OK=1
        break
    fi
    sleep 2
done

if [[ $HEALTHCHECK_OK -eq 0 ]]; then
    printf '\n\033[1;31m[FATAL]\033[0m backend not healthy after %ds — rolling back\n' "$HEALTHCHECK_TIMEOUT" >&2
    # Restore previous build.
    LATEST_BAK="$(ssh_run 'ls -dt /opt/mindleaf/apps/server/dist.bak.* 2>/dev/null | head -n1')"
    if [[ -n "$LATEST_BAK" ]]; then
        printf 'restoring %s\n' "$LATEST_BAK"
        ssh_run "sudo mv /opt/mindleaf/apps/server/dist /opt/mindleaf/apps/server/dist.failed.$(date +%s) && sudo mv '$LATEST_BAK' /opt/mindleaf/apps/server/dist && sudo systemctl restart mindleaf"
        printf 'roll back complete — re-run with --rollback if the new build is confirmed broken\n' >&2
        exit 1
    fi
fi

# ---------------------------------------------------------------------------
# Step 10 — caddy reload (already done above if SPA changed)
# ---------------------------------------------------------------------------
POST_TAG="$(ssh_run "cd '$REPO_PATH' && git describe --tags --always 2>/dev/null || echo none")"
POST_BUILT_AT="$(date -u '+%F %T')"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n\033[1;32m=== Deploy complete ===\033[0m\n'
printf 'pre:  rev=%s  start=%s UTC\n' "$PRE_TAG" "$PRE_BUILT_AT"
printf 'post: rev=%s  end=%s UTC\n'   "$POST_TAG" "$POST_BUILT_AT"

# Cleanup: prune dist.bak snapshots older than 3 (keep last 2 for safety).
ssh_run "ls -dt /opt/mindleaf/apps/server/dist.bak.* 2>/dev/null | tail -n +4 | xargs -r sudo rm -rf"
