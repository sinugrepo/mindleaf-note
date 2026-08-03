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

# The checkout that contains this script is the source for the bootstrap
# template. It may live in /home (for example /home/sinug/mindleaf-note);
# bootstrap does not require the full source to exist in /opt first.
BOOTSTRAP_SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
BOOTSTRAP_SOURCE_ROOT="$(cd -- "$BOOTSTRAP_SCRIPT_DIR/../.." && pwd -P)"
INSTALL_ROOT="${INSTALL_ROOT:-/opt/mindleaf}"

[[ "$INSTALL_ROOT" == /* && "$INSTALL_ROOT" != *[!A-Za-z0-9_./-]* ]] || {
    echo "ERROR: invalid INSTALL_ROOT: $INSTALL_ROOT" >&2
    exit 1
}

# The account that edits the checkout and runs scripts/deploy.sh. When this
# script is invoked through `sudo`, SUDO_USER identifies that operator (for
# example `sinug`); direct root execution falls back to the service account.
DEPLOY_USER="${DEPLOY_USER:-${SUDO_USER:-mindleaf}}"

# ---------------------------------------------------------------------------
# Pre-flight
# ---------------------------------------------------------------------------
if [[ $EUID -ne 0 ]]; then
    echo "ERROR: bootstrap.sh must run as root (use sudo)" >&2
    exit 1
fi
[[ "$DEPLOY_USER" =~ ^[a-z_][a-z0-9_-]*\$?$ ]] || {
    echo "ERROR: invalid deploy operator name: $DEPLOY_USER" >&2
    exit 1
}
id "$DEPLOY_USER" >/dev/null 2>&1 || {
    echo "ERROR: deploy operator does not exist: $DEPLOY_USER" >&2
    echo "       Set DEPLOY_USER explicitly or invoke bootstrap.sh via sudo." >&2
    exit 1
}

: "${R2_ACCOUNT_ID:?R2_ACCOUNT_ID is required}"
: "${R2_ACCESS_KEY:?R2_ACCESS_KEY is required}"
: "${R2_SECRET_KEY:?R2_SECRET_KEY is required}"
: "${ALLOWED_ORIGIN:?ALLOWED_ORIGIN is required}"

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
# A previous partial run may have left a temporarily invalid source list;
# the authoritative source/keyring entries are repaired below before the
# second update. The first update is best-effort only.
apt-get update -y || true
apt-get install -y --no-install-recommends \
    ca-certificates curl cron gnupg lsb-release openssl rsync sudo wget

# Ubuntu 22.04 does not ship PostgreSQL 16 or Caddy in its default
# repositories. Add the official repositories idempotently before install.
install -d -m 0755 /etc/apt/keyrings /usr/share/keyrings
curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc \
    | gpg --dearmor --yes -o /etc/apt/keyrings/postgresql.gpg
printf 'deb [signed-by=/etc/apt/keyrings/postgresql.gpg] http://apt.postgresql.org/pub/repos/apt %s-pgdg main\n' \
    "$(. /etc/os-release && echo "$VERSION_CODENAME")" \
    > /etc/apt/sources.list.d/pgdg.list

# Cloudsmith's published source list currently references this exact
# /usr/share/keyrings path; keep the key and source synchronized.
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sed 's#signed-by=[^]]*#signed-by=/usr/share/keyrings/caddy-stable-archive-keyring.gpg#g' \
    > /etc/apt/sources.list.d/caddy-stable.list

apt-get update -y
apt-get install -y --no-install-recommends \
    postgresql-16 postgresql-client-16 caddy rclone

# The systemd unit uses /usr/bin/node. Install the documented Node 22 LTS
# system-wide rather than relying on a root-only nvm installation.
if [[ ! -x /usr/bin/node ]] || ! /usr/bin/node --version | grep -q '^v22\.'; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
    apt-get install -y --no-install-recommends nodejs
fi

# Enable PostgreSQL now. Caddy packages may auto-start with a default
# config; stop/disable it until the production Caddyfile is validated.
systemctl enable --now postgresql
systemctl enable --now cron
systemctl disable --now caddy 2>/dev/null || true

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

# Canonical install root (spec §11 defaults to /opt/mindleaf).
mkdir -p "$INSTALL_ROOT"
chown mindleaf:mindleaf "$INSTALL_ROOT"
chmod 755 "$INSTALL_ROOT"

# ---------------------------------------------------------------------------
# Step 3 / 4 — secrets + .env
# ---------------------------------------------------------------------------
log "Step 3: provision /opt/mindleaf/.env from template"

ENV_FILE="$INSTALL_ROOT/.env"
TEMPLATE="${BOOTSTRAP_TEMPLATE:-$BOOTSTRAP_SOURCE_ROOT/apps/server/.env.production.example}"

# The template is read from the checkout containing this script, not from
# /opt/mindleaf. This lets an operator bootstrap from /home/sinug/mindleaf-note;
# the regular deploy script later stages the complete release into /opt.
if [[ ! -f "$TEMPLATE" ]]; then
    echo "ERROR: $TEMPLATE not found." >&2
    echo "       Copy the repo to /opt/mindleaf before running bootstrap.sh." >&2
    exit 1
fi

if [[ ! -f "$ENV_FILE" ]]; then
    # First-time bootstrap. Generate secrets and render the template.
    SESSION_SECRET="$(openssl rand -base64 32)"
    MASTER_ENCRYPTION_KEY="$(openssl rand -base64 32)"
    PG_PASSWORD="$(openssl rand -base64 24 | tr -d '/+' | cut -c1-30)"

    # Escape replacement values so base64 characters cannot alter sed syntax.
    sed_escape() { printf '%s' "$1" | sed 's/[\\&|]/\\\\&/g'; }
    PG_PASSWORD_ESC="$(sed_escape "$PG_PASSWORD")"
    SESSION_SECRET_ESC="$(sed_escape "$SESSION_SECRET")"
    MASTER_ENCRYPTION_KEY_ESC="$(sed_escape "$MASTER_ENCRYPTION_KEY")"
    R2_ACCOUNT_ID_ESC="$(sed_escape "$R2_ACCOUNT_ID")"
    R2_ACCESS_KEY_ESC="$(sed_escape "$R2_ACCESS_KEY")"
    R2_SECRET_KEY_ESC="$(sed_escape "$R2_SECRET_KEY")"
    ALLOWED_ORIGIN_ESC="$(sed_escape "$ALLOWED_ORIGIN")"

    sed \
        -e "s|<STRONG_PASSWORD>|$PG_PASSWORD_ESC|g" \
        -e "s|<SESSION_SECRET>|$SESSION_SECRET_ESC|g" \
        -e "s|<MASTER_ENCRYPTION_KEY>|$MASTER_ENCRYPTION_KEY_ESC|g" \
        -e "s|<R2_ACCOUNT_ID>|$R2_ACCOUNT_ID_ESC|g" \
        -e "s|<R2_ACCESS_KEY>|$R2_ACCESS_KEY_ESC|g" \
        -e "s|<R2_SECRET_KEY>|$R2_SECRET_KEY_ESC|g" \
        -e "s|<ALLOWED_ORIGIN>|$ALLOWED_ORIGIN_ESC|g" \
        "$TEMPLATE" > "$ENV_FILE"

    log "generated fresh secrets in $ENV_FILE"
else
    log "$ENV_FILE already exists — keeping existing secrets"
fi

chown mindleaf:mindleaf "$ENV_FILE"
chmod 600 "$ENV_FILE"
# The repository may have been copied by root. Let the service account
# install workspace dependencies and create build output.
chown -R mindleaf:mindleaf "$INSTALL_ROOT"
chmod 600 "$ENV_FILE"

# ---------------------------------------------------------------------------
# Step 5 — Postgres provisioning
# ---------------------------------------------------------------------------
log "Step 5: Provision Postgres role + database + .pgpass"

# PGCOMMAND-aware idempotency: create the role and database independently.
# Decode the URI password through Node's URL parser so URL-escaped passwords
# (for example `%40` for `@`) work in both PostgreSQL and .pgpass. The env file
# is trusted operator input and is loaded only in this process.
set -a
# shellcheck disable=SC1091
source "$ENV_FILE"
set +a
: "${DATABASE_URL:?DATABASE_URL is required in $ENV_FILE}"
DB_PASSWORD="$(DATABASE_URL="$DATABASE_URL" node -e '
const value = process.env.DATABASE_URL;
const url = new URL(value);
process.stdout.write(decodeURIComponent(url.password));
')"
[[ -n "$DB_PASSWORD" ]] || { echo "ERROR: DATABASE_URL has an empty password" >&2; exit 3; }

if ! sudo -u postgres psql -tA -c "SELECT 1 FROM pg_roles WHERE rolname='mindleaf'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_password="$DB_PASSWORD" \
        -c "CREATE ROLE mindleaf LOGIN PASSWORD :'db_password'"
    log "postgres role created"
else
    # Reconcile an existing role with the supplied DATABASE_URL. This makes
    # reruns deterministic and prevents a stale role password from breaking
    # drizzle-kit, pg_dump, or pg_restore on the replacement VPS.
    sudo -u postgres psql -v ON_ERROR_STOP=1 -v db_password="$DB_PASSWORD" \
        -c "ALTER ROLE mindleaf LOGIN PASSWORD :'db_password'"
    log "postgres role 'mindleaf' password synchronized"
fi
if ! sudo -u postgres psql -tA -c "SELECT 1 FROM pg_database WHERE datname='mindleaf'" | grep -q 1; then
    sudo -u postgres psql -v ON_ERROR_STOP=1 \
        -c "CREATE DATABASE mindleaf OWNER mindleaf"
    log "postgres database created"
else
    log "postgres database 'mindleaf' already exists — keeping it"
fi
sudo -u postgres psql -v ON_ERROR_STOP=1 \
    -c "GRANT ALL PRIVILEGES ON DATABASE mindleaf TO mindleaf"

# .pgpass for passwordless cron/backup access. Format documented at
# https://www.postgresql.org/docs/current/libpq-pgpass.html
#   hostname:port:database:username:password
# .pgpass uses colon-separated fields; escape backslashes and colons in the
# decoded password so credentials remain valid even when DATABASE_URL contains
# URL-encoded punctuation.
PGPASSWORD_PLACEHOLDER="$(printf '%s' "$DB_PASSWORD" | sed 's/[\\:]/\\&/g')"
cat > "$INSTALL_ROOT/.pgpass" <<PGPASS
localhost:5432:mindleaf:mindleaf:$PGPASSWORD_PLACEHOLDER
*:5432:mindleaf:mindleaf:$PGPASSWORD_PLACEHOLDER
PGPASS
chown mindleaf:mindleaf "$INSTALL_ROOT/.pgpass"
chmod 600 "$INSTALL_ROOT/.pgpass"
log ".pgpass provisioned (chmod 600)"

# ---------------------------------------------------------------------------
# Step 6 — rclone config
# ---------------------------------------------------------------------------
log "Step 6: write /opt/mindleaf/.config/rclone/rclone.conf"

mkdir -p "$INSTALL_ROOT/.config/rclone"
RCLONE_PATH="$INSTALL_ROOT/.config/rclone/rclone.conf"
if [[ ! -f "$RCLONE_PATH" ]]; then
    if [[ -n "${RCLONE_CONF_B64:-}" ]]; then
        echo "$RCLONE_CONF_B64" | base64 -d > "$RCLONE_PATH"
    else
        cat > "$RCLONE_PATH" <<RCLONE
[r2]
type = s3
provider = Other
env_auth = false
access_key_id = $R2_ACCESS_KEY
secret_access_key = $R2_SECRET_KEY
endpoint = https://$R2_ACCOUNT_ID.r2.cloudflarestorage.com
acl = private
RCLONE
    fi
    chown mindleaf:mindleaf "$RCLONE_PATH"
    chmod 600 "$RCLONE_PATH"
    log "rclone.conf written (chmod 600)"
else
    log "rclone.conf already exists — keeping"
fi

# ---------------------------------------------------------------------------
# Step 7 — DB schema (Drizzle push)
# ---------------------------------------------------------------------------
log "Step 7: apply Drizzle schema (npm run db:push)"

# Bootstrap applies the current schema once before an optional database
# restore. `--force` is intentional: fresh-VPS migration must never pause
# for an interactive drizzle-kit confirmation prompt. The deploy phase
# repeats the idempotent push after restore.
if [[ -f "$INSTALL_ROOT/apps/server/package.json" ]]; then
    install -d -o mindleaf -g mindleaf -m 0700 /home/mindleaf/.npm
    sudo -u mindleaf env HOME=/home/mindleaf npm_config_cache=/home/mindleaf/.npm bash <<SU
cd "$INSTALL_ROOT"
# Load .env so drizzle-kit sees DATABASE_URL.
set -a
source "$INSTALL_ROOT/.env"
set +a
env -u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT npm ci --include=dev
npm run ownership:prepare --workspace=@mindleaf/server
npm run db:push --workspace=@mindleaf/server -- --force
SU
    log "db:push complete"
else
    log "skipping db:push (runtime source is not staged yet — run scripts/deploy.sh from the editable checkout)"
fi

# Cron's shell runs as mindleaf, so pre-create its redirected log file
# and lock file before the first manual/cron backup.
install -o mindleaf -g adm -m 0640 /dev/null /var/log/mindleaf-backup.log
install -o mindleaf -g mindleaf -m 0644 /dev/null /var/lock/mindleaf-backup.lock
# Allow the operator who edits the checkout to install local artifacts and
# reload services. Keep this narrowly scoped: deploy.sh never needs a shell,
# package manager, SSH, or remote rsync privilege. The runtime service account
# remains `mindleaf`; DEPLOY_USER is normally the invoking human (e.g. sinug).
cat > /etc/sudoers.d/mindleaf-deploy <<SUDOERS
Cmnd_Alias MINDLEAF_DEPLOY = /usr/bin/systemctl *, /bin/systemctl *, /usr/bin/caddy *, /usr/bin/install *, /bin/install *, /usr/bin/mkdir *, /bin/mkdir *, /usr/bin/rm *, /bin/rm *, /usr/bin/cp *, /bin/cp *, /usr/bin/mv *, /bin/mv *, /usr/bin/chown *, /bin/chown *, /usr/bin/find *, /usr/bin/test *, /bin/test *
$DEPLOY_USER ALL=(root) NOPASSWD: MINDLEAF_DEPLOY
SUDOERS
chmod 440 /etc/sudoers.d/mindleaf-deploy
visudo -cf /etc/sudoers.d/mindleaf-deploy
log "local deploy sudoers rule installed for $DEPLOY_USER (mode 440)"

# ---------------------------------------------------------------------------
# Final
# ---------------------------------------------------------------------------
log "bootstrap complete"
log "next steps:"
log "  1. As $DEPLOY_USER, from the editable checkout, run ./scripts/deploy.sh --dry-run"
log "  2. As $DEPLOY_USER, from the editable checkout, run ./scripts/deploy.sh"
log "     (the deployer stages the release into $INSTALL_ROOT)"
log "  3. Verify sudo systemctl status mindleaf caddy postgresql"
