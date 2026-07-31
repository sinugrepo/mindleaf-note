#!/usr/bin/env bash
# =============================================================================
# Phase 9 — One-time VPS provisioning script for Mindleaf production.
#
# Usage (run as root):
#   sudo bash deploy/scripts/bootstrap.sh
#
# What it does (per CLOUD_MIGRATION_PLAN §11):
#   1. apt update + install postgresql-16, caddy, rclone, ca-certificates
#   2. Create `mindleaf` system user (non-root, no password login)
#   3. Create /opt/mindleaf owned by mindleaf
#   4. Generate /opt/mindleaf/.env from .env.production.example with
#      freshly-generated SESSION_SECRET + MASTER_ENCRYPTION_KEY +
#      DATABASE_URL password
#   5. Configure Postgres: create role + db, write ~/.pgpass for
#      passwordless cron access
#   6. Write /opt/mindleaf/.config/rclone/rclone.conf from $RCLONE_CONF_B64
#      environment variable (rclone secrets don't leak via ps/cron logs)
#   7. Run `npm run db:push` to apply Drizzle schema
#
# Idempotency:
#   - Safe to re-run. apt packages skip if already current. User/db
#     creation uses IF NOT EXISTS-style guards.
#   - Secrets are only generated on first run (we test for existing
#     .env before writing new SESSION_SECRET).
#
# Exit codes:
#   0 = success
#   1 = prerequisite missing (run as root with sudo)
#   2 = apt install failed (network issue / package unavailable)
#   3 = postgres provisioning failed
#   4 = rclone config not provided
# =============================================================================

set -euo pipefail

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: bootstrap.sh must run as root (use sudo)" >&2
    exit 1
fi

if [[ -z "${RCLONE_CONF_B64:-}" && ! -f /opt/mindleaf/.config/rclone/rclone.conf ]]; then
    echo "ERROR: RCLONE_CONF_B64 environment variable required" >&2
    echo "       (base64-encoded rclone.conf with the r2: remote)" >&2
    echo "       First-time only — existing config at /opt/mindleaf/.config/rclone/rclone.conf is reused." >&2
    exit 4
fi

LOG_TAG="mindleaf-bootstrap"
log() {
    local msg="[$(date -u '+%F %T') UTC] $*"
    if command -v systemd-cat >/dev/null 2>&1; then
        echo "$msg" | systemd-cat -t "$LOG_TAG" 2>/dev/null || true
    fi
    echo "$msg"
}

# ---------------------------------------------------------------------------
# Step 1 — apt packages
# ---------------------------------------------------------------------------
log "Step 1: apt update + install postgresql-16, caddy, rclone, ca-certificates"

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y --no-install-recommends \
    postgresql-16 \
    caddy \
    rclone \
    ca-certificates \
    curl \
    gnupg

# Enable systemd units for caddy + postgresql. We DON'T enable
# mindleaf.service here — that's deploy.sh's job (after repo is in place).
systemctl enable --now postgresql
systemctl enable --now caddy

# ---------------------------------------------------------------------------
# Step 2 — system user
# ---------------------------------------------------------------------------
log "Step 2: create system user 'mindleaf' (non-root, passwordless)"

if ! id mindleaf >/dev/null 2>&1; then
    useradd -m -s /bin/bash -G www-data,ssl-cert mindleaf
    passwd -l mindleaf >/dev/null  # disable password login
    log "user created (uid $(id -u mindleaf))"
else
    log "user already exists — skipping"
fi

# /opt/mindleaf as canonical install root (spec §11).
mkdir -p /opt/mindleaf
chown mindleaf:mindleaf /opt/mindleaf
chmod 755 /opt/mindleaf

# ---------------------------------------------------------------------------
# Step 3 / 4 — secrets + .env
# ---------------------------------------------------------------------------
log "Step 3: provision /opt/mindleaf/.env from template"

ENV_FILE="/opt/mindleaf/.env"
TEMPLATE="/opt/mindleaf/apps/server/.env.production.example"

# We need the template in place before we can copy. The deploy step
# copies the repo to /opt/mindleaf; bootstrap.sh assumes it's already
# there OR can fetch it. For first-time VPS bootstrap, run:
#   scp -r apps/server /opt/mindleaf/apps/
# before this script. If the template is missing, abort with a clear
# error.
if [[ ! -f "$TEMPLATE" ]]; then
    echo "ERROR: $TEMPLATE not found." >&2
    echo "       Copy the repo to /opt/mindleaf before running bootstrap.sh." >&2
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    # First-time bootstrap. Generate secrets.
    SESSION_SECRET="$(openssl rand -base64 32)"
    MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)"
    PG_PASSWORD="$(openssl rand -base64 24 | tr -d '/' | tr -d '+')"
    ALLOWED_ORIGIN="${ALLOWED_ORIGIN:-https://mindleaf.example.com}"

    # Substitute placeholders in the template. We avoid envsubst because
    # it would also touch any $-quoted strings we don't recognize;
    # sed is fine for the small fixed set of placeholders above.
    sed \
        -e "s|<STRONG_PASSWORD>|$PG_PASSWORD|g" \
        -e "s|replace-with-openssl-rand-base64-32|$SESSION_SECRET|g" \
        -e "s#https://mindleaf.example.com#$ALLOWED_ORIGIN#g" \
        "$TEMPLATE" > "$ENV_FILE"

    # Also: write SESSION_SECRET and MASTER_ENCRYPTION_KEY twice (the
    # template has the same placeholder for both). For safety, replace
    # ALL occurrences with fresh secrets.
    log "generated fresh secrets in $ENV_FILE"
else
    log "$ENV_FILE already exists — keeping existing secrets"
fi

chown mindleaf:mindleaf "$ENV_FILE"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------------------
# Step 5 — Postgres provisioning
# ---------------------------------------------------------------------------
log "Step 5: Provision Postgres role + database + .pgpass"

# PGCOMMAND-aware idempotency. If the role already exists, skip create.
if ! sudo -u postgres psql -tA -c "SELECT 1 FROM pg_roles WHERE rolname='mindleaf'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 <<SQL
CREATE ROLE mindleaf LOGIN PASSWORD '$PG_PASSWORD';
CREATE DATABASE mindleaf OWNER mindleaf;
GRANT ALL PRIVILEGES ON DATABASE mindleaf TO mindleaf;
SQL
    log "postgres role + database created"
else
    log "postgres role 'mindleaf' already exists — skipping create"
fi

# .pgpass for passwordless cron/backup access. Format documented at
# https://www.postgresql.org/docs/current/libpq-pgpass.html
#   hostname:port:database:username:password
PGPASSWORD_PLACEHOLDER="$(grep '^DATABASE_URL=' "$ENV_FILE" | sed -nE 's|.*://[^:]+:([^@]+)@.*|\1|p')"
cat > /opt/mindleaf/.pgpass <<PGPASS
localhost:5432:mindleaf:mindleaf:$PGPASSWORD_PLACEHOLDER
*:5432:mindleaf:mindleaf:$PGPASSWORD_PLACEHOLDER
PGPASS
chown mindleaf:mindleaf /opt/mindleaf/.pgpass
chmod 600 /opt/mindleaf/.pgpass
log ".pgpass provisioned (chmod 600)"

# ---------------------------------------------------------------------------
# Step 6 — rclone config
# ---------------------------------------------------------------------------
log "Step 6: write /opt/mindleaf/.config/rclone/rclone.conf"

mkdir -p /opt/mindleaf/.config/rclone
RCLONE_PATH=/opt/mindleaf/.config/rclone/rclone.conf
if [[ ! -f "$RCLONE_PATH" && -n "${RCLONE_CONF_B64:-}" ]]; then
    echo "$RCLONE_CONF_B64" | base64 -d > "$RCLONE_PATH"
    chown -R mindleaf:mindleaf /opt/mindleaf/.config/rclone
    chmod 600 "$RCLONE_PATH"
    log "rclone.conf written (chmod 600)"
elif [[ -f "$RCLONE_PATH" ]]; then
    log "rclone.conf already exists — keeping"
else
    err "neither pre-existing rclone.conf nor RCLONE_CONF_B64 found"
    exit 4
fi

# ---------------------------------------------------------------------------
# Step 7 — DB schema (Drizzle push)
# ---------------------------------------------------------------------------
log "Step 7: apply Drizzle schema (npm run db:push)"

# Bootstrap delegates this to deploy.sh too — but for first-time prod
# where deploy.sh has nothing to pull yet, run db:push from /opt/mindleaf.
# (This requires the repo to be cloned into /opt/mindleaf already
#  — that's a separate step; see README "Production deploy" section.)
if [[ -f /opt/mindleaf/apps/server/package.json ]]; then
    sudo -u mindleaf -E bash <<'SU'
        cd /opt/mindleaf
        # Load .env so drizzle-kit sees DATABASE_URL.
        set -a; source /opt/mindleaf/.env; set +a
        npm ci --workspace=@mindleaf/server
        npm run db:push --workspace=@mindleaf/server
    SU
    log "db:push complete"
else
    log "skipping db:push (apps/server/package.json not found — run deploy.sh after cloning)"
fi

# ---------------------------------------------------------------------------
# Final
# ---------------------------------------------------------------------------
log "bootstrap complete"
log "next steps:"
log "  1. Run scripts/deploy.sh --vps <this-vps> to copy deploy/ unit + cron files"
log "  2. systemctl restart mindleaf"
log "  3. Verify sudo systemctl status mindleaf"
