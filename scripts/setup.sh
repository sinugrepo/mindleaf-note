#!/usr/bin/env bash
# Mindleaf single-entrypoint setup and deployment.
#
# Beginner-friendly commands:
#   curl -fsSL https://raw.githubusercontent.com/sinugrepo/mindleaf-note/main/scripts/setup.sh | sudo bash
#   sudo bash scripts/setup.sh                 # fresh install or redeploy
#   sudo bash scripts/setup.sh --pull           # update checkout first
#   sudo bash scripts/setup.sh --mode migrate --env-file /root/mindleaf.env
#
# This is an orchestrator. The existing bootstrap, migration, and deploy
# scripts remain the authoritative implementation for each individual phase.
set -Eeuo pipefail
umask 077
ORIGINAL_ARGS=("$@")

REPO_URL="${MINDLEAF_REPO_URL:-https://github.com/sinugrepo/mindleaf-note.git}"
REPO_REF="${MINDLEAF_REF:-main}"
# The lower-level production scripts share this canonical runtime path.
# Keeping one path here prevents a first install from provisioning one
# directory while the deployer publishes another.
INSTALL_ROOT="/opt/mindleaf"
SOURCE_CACHE="${MINDLEAF_SOURCE_ROOT:-/opt/mindleaf-source}"
OPERATOR_USER="${SUDO_USER:-$(id -un)}"
[[ "$OPERATOR_USER" == root ]] && OPERATOR_USER="root"
MODE="auto"
ENV_FILE=""
SOURCE_DIR=""
NO_RESTORE=0
SKIP_PUBLIC_CHECK=0
NO_MIGRATE=0
PULL=0
DRY_RUN=0
NON_INTERACTIVE="${MINDLEAF_NON_INTERACTIVE:-0}"
R2_BUCKET="${MINDLEAF_R2_BUCKET:-mindleaf-prod}"
BACKUP_R2_BUCKET="${MINDLEAF_BACKUP_R2_BUCKET:-mindleaf-prod-backups}"
BACKUP_R2_PATH="${MINDLEAF_BACKUP_R2_PATH:-db}"
ADMIN_PASSWORD_FILE_INPUT="${MINDLEAF_ADMIN_PASSWORD_FILE:-}"
PHASE_TIMEOUT="${MINDLEAF_SETUP_TIMEOUT:-1200}"
TEMP_SOURCE=""
CREDENTIAL_FILE="/var/lib/mindleaf/admin-credentials.txt"

log() { printf '\033[1;32m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*" >&2; }
err() { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }
step() { printf '\n\033[1;36m=== %s ===\033[0m\n' "$*"; }

usage() {
    cat <<'HELP'
Mindleaf one-script setup

The script automatically chooses one of these modes:
  fresh    New VPS, creates secrets/database/services, then deploys.
  deploy   Existing Mindleaf installation, builds and activates a release.
  migrate  New VPS with an existing .env and R2 backup; preserves encrypted data.

Easy start on a brand-new Ubuntu VPS:
  curl -fsSL https://raw.githubusercontent.com/sinugrepo/mindleaf-note/main/scripts/setup.sh | sudo bash

Run again for a normal update from an existing checkout:
  sudo bash scripts/setup.sh --pull

Options:
  --mode auto|fresh|deploy|migrate  Select the operation explicitly.
  --env-file FILE                   Existing production .env for migration.
  --source-dir DIR                  Use this checkout instead of cloning one.
  --source-cache DIR                Persistent checkout used by the curl one-liner.
  --repo-url URL                    Repository URL (default: Mindleaf GitHub repo).
  --ref REF                         Branch/tag/commit to clone (default: main).
  --pull                            Fast-forward the existing checkout before deploy.
  --no-restore                      Migration only: skip importing the R2 dump (does not delete data).
  --no-migrate                      Skip the schema push during a normal deploy.
  --skip-public-check               Migration only: skip the public HTTPS check.
  --non-interactive                 Never prompt; read MINDLEAF_* values or fail.
  --r2-bucket NAME                  Attachment bucket (default: mindleaf-prod).
  --backup-r2-bucket NAME           Database backup bucket (default: mindleaf-prod-backups).
  --backup-r2-path PATH             Database backup prefix (default: db).
  --admin-password-file FILE        Optional protected file for the initial password.
  --timeout SECONDS                 Timeout for migration/bootstrap phases.
  --dry-run                         Show the deploy plan without changing services.
  -h, --help                        Show this help.

Safety:
  - Existing /opt/mindleaf/.env is never replaced automatically.
  - The curl one-liner keeps its checkout in /opt/mindleaf-source.
  - Existing data is restored only in explicit migration mode.
  - The underlying deployer creates snapshots and health-checks the release.
  - Secrets are read from environment values or one prompt phase and are never printed by this script.
  - Fresh setup creates missing R2 buckets and fails if the token cannot access them.
  - Fresh setup generates the initial admin password and stores it at
    /var/lib/mindleaf/admin-credentials.txt with mode 0600.
HELP
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --mode)
            [[ $# -ge 2 ]] || { err "--mode requires auto, fresh, deploy, or migrate"; exit 64; }
            MODE="$2"; shift 2 ;;
        --env-file)
            [[ $# -ge 2 ]] || { err "--env-file requires a path"; exit 64; }
            ENV_FILE="$2"; shift 2 ;;
        --source-dir)
            [[ $# -ge 2 ]] || { err "--source-dir requires a path"; exit 64; }
            SOURCE_DIR="$2"; shift 2 ;;
        --source-cache)
            [[ $# -ge 2 ]] || { err "--source-cache requires a path"; exit 64; }
            SOURCE_CACHE="$2"; shift 2 ;;
        --repo-url)
            [[ $# -ge 2 ]] || { err "--repo-url requires a URL"; exit 64; }
            REPO_URL="$2"; shift 2 ;;
        --ref)
            [[ $# -ge 2 ]] || { err "--ref requires a branch, tag, or commit"; exit 64; }
            REPO_REF="$2"; shift 2 ;;
        --pull) PULL=1; shift ;;
        --no-restore) NO_RESTORE=1; shift ;;
        --no-migrate) NO_MIGRATE=1; shift ;;
        --skip-public-check) SKIP_PUBLIC_CHECK=1; shift ;;
        --non-interactive) NON_INTERACTIVE=1; shift ;;
        --r2-bucket)
            [[ $# -ge 2 ]] || { err "--r2-bucket requires a name"; exit 64; }
            R2_BUCKET="$2"; shift 2 ;;
        --backup-r2-bucket)
            [[ $# -ge 2 ]] || { err "--backup-r2-bucket requires a name"; exit 64; }
            BACKUP_R2_BUCKET="$2"; shift 2 ;;
        --backup-r2-path)
            [[ $# -ge 2 ]] || { err "--backup-r2-path requires a path"; exit 64; }
            BACKUP_R2_PATH="$2"; shift 2 ;;
        --admin-password-file)
            [[ $# -ge 2 ]] || { err "--admin-password-file requires a path"; exit 64; }
            ADMIN_PASSWORD_FILE_INPUT="$2"; shift 2 ;;
        --timeout)
            [[ $# -ge 2 ]] || { err "--timeout requires seconds"; exit 64; }
            PHASE_TIMEOUT="$2"; shift 2 ;;
        --dry-run) DRY_RUN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) err "unknown argument: $1"; usage >&2; exit 64 ;;
    esac
done

case "$MODE" in auto|fresh|deploy|migrate) ;; *) err "invalid --mode: $MODE"; exit 64 ;; esac
[[ "$PHASE_TIMEOUT" =~ ^[1-9][0-9]*$ ]] || { err "--timeout must be a positive integer"; exit 64; }
[[ "$NON_INTERACTIVE" =~ ^[01]$ ]] || { err "MINDLEAF_NON_INTERACTIVE must be 0 or 1"; exit 64; }
[[ "$SOURCE_CACHE" == /* && "$SOURCE_CACHE" != *[!A-Za-z0-9_./-]* ]] || { err "invalid source cache"; exit 64; }
valid_bucket_name() { [[ "$1" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ && "$1" != *..* ]]; }
valid_bucket_name "$R2_BUCKET" || { err "invalid attachment bucket name"; exit 64; }
valid_bucket_name "$BACKUP_R2_BUCKET" || { err "invalid backup bucket name"; exit 64; }
[[ "$BACKUP_R2_PATH" =~ ^[A-Za-z0-9._/-]+$ && "$BACKUP_R2_PATH" != /* && "$BACKUP_R2_PATH" != */ ]] || { err "invalid backup R2 path"; exit 64; }

# When invoked as `curl ... | sudo bash`, stdin is the script itself and
# there is no checkout containing the remaining files. Clone once into a
# persistent, root-protected source directory, then run the same orchestrator
# from that checkout. Keeping the checkout makes future `--pull` deployments
# possible; unlike a temporary clone it is not deleted after setup completes.
SCRIPT_FILE="${BASH_SOURCE[0]:-}"
if [[ "${MINDLEAF_SETUP_BOOTSTRAPPED:-0}" != 1 && ! -f "$SCRIPT_FILE" ]]; then
    [[ $EUID -eq 0 ]] || { err "the piped one-liner must run through sudo"; exit 1; }
    if [[ "$DRY_RUN" -eq 1 ]]; then
        log "would clone the repository into $SOURCE_CACHE and continue with a fresh-install preview"
        exit 0
    fi
    command -v git >/dev/null 2>&1 || {
        export DEBIAN_FRONTEND=noninteractive
        apt-get update -y
        apt-get install -y --no-install-recommends ca-certificates git
    }
    if [[ -e "$SOURCE_CACHE" && ! -d "$SOURCE_CACHE/.git" ]]; then
        err "source cache exists but is not a Git checkout: $SOURCE_CACHE"
        err "choose another path with --source-cache or remove it manually"
        exit 66
    fi
    if [[ ! -d "$SOURCE_CACHE/.git" ]]; then
        install -d -m 0755 "$(dirname "$SOURCE_CACHE")"
        git clone --depth 1 --branch "$REPO_REF" "$REPO_URL" "$SOURCE_CACHE"
    fi
    if [[ "$OPERATOR_USER" != root ]]; then
        chown -R "$OPERATOR_USER:$(id -gn "$OPERATOR_USER")" "$SOURCE_CACHE"
    fi
    # Do not forward --source-dir if the caller supplied one: the piped
    # invocation owns the persistent checkout it just selected.
    filtered_args=()
    skip_next=0
    for arg in "${ORIGINAL_ARGS[@]}"; do
        if [[ "$skip_next" -eq 1 ]]; then skip_next=0; continue; fi
        if [[ "$arg" == "--source-dir" ]]; then skip_next=1; continue; fi
        filtered_args+=("$arg")
    done
    bash "$SOURCE_CACHE/scripts/setup.sh" \
        "${filtered_args[@]}" \
        --source-dir "$SOURCE_CACHE" \
        --source-cache "$SOURCE_CACHE" \
        --repo-url "$REPO_URL" \
        --ref "$REPO_REF"
    exit $?
fi

if [[ -n "$SOURCE_DIR" ]]; then
    SOURCE_ROOT="$(cd "$SOURCE_DIR" && pwd -P)"
elif [[ -f "$SCRIPT_FILE" ]]; then
    SOURCE_ROOT="$(cd "$(dirname "$SCRIPT_FILE")/.." && pwd -P)"
else
    err "cannot determine source checkout"
    exit 66
fi
[[ -f "$SOURCE_ROOT/scripts/deploy.sh" ]] || { err "scripts/deploy.sh not found in $SOURCE_ROOT"; exit 66; }
[[ -f "$SOURCE_ROOT/scripts/migrate-vps.sh" ]] || { err "scripts/migrate-vps.sh not found in $SOURCE_ROOT"; exit 66; }

# Fail before provisioning if one of the delegated operational scripts is
# syntactically invalid. This keeps the public one-click entrypoint from
# partially changing a VPS and discovering a broken migration/deploy phase
# only after packages or services have already been modified.
for delegated_script in \
    "$SOURCE_ROOT/scripts/migrate-vps.sh" \
    "$SOURCE_ROOT/scripts/deploy.sh" \
    "$SOURCE_ROOT/deploy/scripts/bootstrap.sh" \
    "$SOURCE_ROOT/deploy/scripts/backup.sh"; do
    bash -n "$delegated_script" || {
        err "invalid shell syntax in delegated script: $delegated_script"
        exit 65
    }
done

RUNTIME_ENV="$INSTALL_ROOT/.env"
export INSTALL_ROOT
export DEPLOY_ROOT="$INSTALL_ROOT"
if [[ "$MODE" == auto ]]; then
    if [[ -f "$RUNTIME_ENV" ]]; then
        [[ -z "$ENV_FILE" ]] || { err "runtime already exists; use --mode deploy or omit --env-file"; exit 64; }
        MODE="deploy"
    elif [[ -n "$ENV_FILE" ]]; then
        MODE="migrate"
    else
        MODE="fresh"
    fi
fi

if [[ "$MODE" == migrate || "$MODE" == fresh ]]; then
    [[ $EUID -eq 0 ]] || { err "--mode $MODE must run as root (use sudo)"; exit 1; }
fi

if [[ "$MODE" == deploy && ! -f "$RUNTIME_ENV" ]]; then
    err "$RUNTIME_ENV does not exist; use fresh mode or provide --env-file for migration"
    exit 66
fi
if [[ "$MODE" == migrate && -z "$ENV_FILE" ]]; then
    err "migration requires --env-file with the original production secrets"
    exit 64
fi
if [[ "$MODE" == migrate && "$NO_RESTORE" -eq 1 ]]; then
    warn "migration will skip the R2 dump restore; an existing target database is not deleted"
fi

operator_user="$OPERATOR_USER"

pull_checkout() {
    [[ "$PULL" -eq 1 ]] || return 0
    command -v git >/dev/null 2>&1 || { err "git is required for --pull"; exit 69; }
    git -C "$SOURCE_ROOT" diff --quiet || { err "checkout has tracked changes; refusing --pull"; exit 65; }
    git -C "$SOURCE_ROOT" diff --cached --quiet || { err "checkout has staged changes; refusing --pull"; exit 65; }
    if [[ $EUID -eq 0 && "$operator_user" != root && "$(id -u "$operator_user" 2>/dev/null || echo 0)" -ne 0 ]]; then
        sudo -u "$operator_user" -H git -C "$SOURCE_ROOT" pull --ff-only
    else
        git -C "$SOURCE_ROOT" pull --ff-only
    fi
}

show_fresh_requirements() {
    cat >&2 <<'WARNING'

======================================================================
Mindleaf fresh setup — CHECK PREREQUISITES BEFORE CONTINUING
======================================================================
This command will install packages, PostgreSQL, Caddy, Node.js, rclone,
a system user, services, runtime secrets, and the first admin account.
It must be run on a new Ubuntu VPS with root/sudo access.

You must have ready:
  1. A domain DNS A/AAAA record already pointing to this VPS.
  2. Inbound TCP ports 80 and 443 open in the VPS/provider firewall.
  3. Outbound internet access for apt, GitHub, NodeSource, Caddy,
     PostgreSQL repositories, and Cloudflare R2.
  4. Cloudflare R2 account ID, access key, and secret key.
  5. R2 token permission to create/read/write the attachment and backup
     buckets. Object-only R2 tokens are not sufficient for fresh setup.

Default R2 destinations:
  attachment bucket: mindleaf-prod
  backup bucket:    mindleaf-prod-backups
  backup path:      db

The initial admin password is generated automatically unless a protected
password file is supplied. It will be saved at:
  /var/lib/mindleaf/admin-credentials.txt (mode 0600)

Setup will NOT report success unless PostgreSQL, Mindleaf, and Caddy are
active, local/public HTTPS healthchecks pass, and both R2 buckets are
reachable. If DNS/TLS or an external prerequisite is not ready, setup exits
with an error; it does not silently mark the deployment completed.

For an existing installation or existing encrypted data, do not use fresh
mode: use the normal deploy or migration command instead.
======================================================================

WARNING
}

verify_runtime() {
    step "Verifying completed installation"
    local check_sudo=()
    if [[ $EUID -ne 0 ]]; then
        command -v sudo >/dev/null || { err "sudo is required for final verification"; return 1; }
        check_sudo=(sudo -n)
    fi
    "${check_sudo[@]}" systemctl is-active --quiet mindleaf
    "${check_sudo[@]}" systemctl is-active --quiet caddy
    "${check_sudo[@]}" systemctl is-active --quiet postgresql
    curl --fail --silent --show-error --max-time 10 http://localhost:8787/healthz >/dev/null

    local runtime_origin=""
    runtime_origin="$("${check_sudo[@]}" awk -F= '$1 == "ALLOWED_ORIGIN" { value=$2; sub(/^\047/, "", value); sub(/\047$/, "", value); sub(/^\042/, "", value); sub(/\042$/, "", value); sub(/\/$/, "", value); print value; exit }' "$RUNTIME_ENV")"
    [[ "$runtime_origin" =~ ^https://[^/[:space:]]+$ ]] || { err "runtime ALLOWED_ORIGIN is invalid"; return 1; }
    curl --fail --silent --show-error --max-time 30 "$runtime_origin/healthz" >/dev/null

    local runtime_bucket="" backup_bucket="" backup_path=""
    runtime_bucket="$("${check_sudo[@]}" awk -F= '$1 == "R2_BUCKET" { print $2; exit }' "$RUNTIME_ENV")"
    backup_bucket="$("${check_sudo[@]}" awk -F= '$1 == "BACKUP_R2_BUCKET" { print $2; exit }' "$RUNTIME_ENV")"
    backup_path="$("${check_sudo[@]}" awk -F= '$1 == "BACKUP_R2_PATH" { print $2; exit }' "$RUNTIME_ENV")"
    runtime_bucket="${runtime_bucket:-mindleaf-prod}"
    backup_bucket="${backup_bucket:-mindleaf-prod-backups}"
    backup_path="${backup_path:-db}"
    [[ -n "$runtime_bucket" && -n "$backup_bucket" && -n "$backup_path" ]] || { err "runtime R2 configuration is incomplete"; return 1; }
    if [[ $EUID -eq 0 ]]; then
        RCLONE_CONFIG="$INSTALL_ROOT/.config/rclone/rclone.conf" rclone lsf --max-depth 1 "r2:$runtime_bucket" >/dev/null
        RCLONE_CONFIG="$INSTALL_ROOT/.config/rclone/rclone.conf" rclone lsf --max-depth 1 "r2:$backup_bucket" >/dev/null
    else
        "${check_sudo[@]}" -u mindleaf rclone --config "$INSTALL_ROOT/.config/rclone/rclone.conf" lsf --max-depth 1 "r2:$runtime_bucket" >/dev/null
        "${check_sudo[@]}" -u mindleaf rclone --config "$INSTALL_ROOT/.config/rclone/rclone.conf" lsf --max-depth 1 "r2:$backup_bucket" >/dev/null
    fi
    log "installation verified: services, local/public health, and attachment/backup storage are ready"
}

run_deploy() {
    local args=("$SOURCE_ROOT/scripts/deploy.sh")
    [[ "$NO_MIGRATE" -eq 1 ]] && args+=(--no-migrate)
    [[ "$DRY_RUN" -eq 1 ]] && args+=(--dry-run)
    # A fresh one-liner provisions packages as root, then executes the
    # release as the invoking operator so the persistent checkout and its
    # dependency cache remain usable without root.
    if [[ $EUID -eq 0 && "$operator_user" != root && ("$MODE" == deploy || "$MODE" == fresh) ]]; then
        sudo -u "$operator_user" -H env DEPLOY_ROOT="$INSTALL_ROOT" bash "${args[@]}"
    else
        env DEPLOY_ROOT="$INSTALL_ROOT" bash "${args[@]}"
    fi
}

case "$MODE" in
    deploy)
        step "Deploying an existing Mindleaf installation"
        log "source: $SOURCE_ROOT"
        pull_checkout
        run_deploy
        verify_runtime
        ;;

    migrate)
        step "Migrating an existing Mindleaf installation to this VPS"
        [[ "$DRY_RUN" -eq 0 ]] || { warn "migration dry-run is not supported; use --mode deploy --dry-run to preview a release"; exit 64; }
        args=("$SOURCE_ROOT/scripts/migrate-vps.sh" --source-dir "$SOURCE_ROOT" --env-file "$ENV_FILE" --timeout "$PHASE_TIMEOUT")
        [[ "$NO_RESTORE" -eq 1 ]] && args+=(--no-restore)
        [[ "$SKIP_PUBLIC_CHECK" -eq 1 ]] && args+=(--skip-public-check)
        bash "${args[@]}"
        ;;

    fresh)
        step "Preparing a new Mindleaf installation"
        show_fresh_requirements
        [[ "$DRY_RUN" -eq 0 ]] || { log "would install OS packages, create secrets, provision PostgreSQL/R2, deploy the app, and check health"; exit 0; }
        if [[ "$NON_INTERACTIVE" -eq 0 && ! -t 0 && -r /dev/tty ]]; then
            exec </dev/tty
        fi
        [[ ! -f "$RUNTIME_ENV" ]] || { err "$RUNTIME_ENV already exists; refusing fresh setup"; exit 66; }

        ALLOWED_ORIGIN="${MINDLEAF_ALLOWED_ORIGIN:-${ALLOWED_ORIGIN:-}}"
        R2_ACCOUNT_ID="${MINDLEAF_R2_ACCOUNT_ID:-${R2_ACCOUNT_ID:-}}"
        R2_ACCESS_KEY="${MINDLEAF_R2_ACCESS_KEY:-${R2_ACCESS_KEY:-}}"
        R2_SECRET_KEY="${MINDLEAF_R2_SECRET_KEY:-${R2_SECRET_KEY:-}}"
        prompt_value() {
            local variable="$1" prompt="$2" secret="${3:-0}" value
            value="${!variable:-}"
            if [[ -z "$value" && "$NON_INTERACTIVE" -eq 0 && -t 0 ]]; then
                if [[ "$secret" -eq 1 ]]; then read -r -s -p "$prompt" value; printf '\n';
                else read -r -p "$prompt" value; fi
            fi
            [[ -n "$value" ]] || { err "$variable is required; set it before running with --non-interactive"; exit 64; }
            printf -v "$variable" '%s' "$value"
        }
        prompt_value ALLOWED_ORIGIN "Public app URL (example: https://notes.example.com): "
        ALLOWED_ORIGIN="${ALLOWED_ORIGIN%/}"
        [[ "$ALLOWED_ORIGIN" =~ ^https://[^/[:space:]]+$ ]] || {
            err "public app URL must start with https:// and contain only a hostname"
            exit 64
        }
        prompt_value R2_ACCOUNT_ID "Cloudflare R2 account ID: "
        prompt_value R2_ACCESS_KEY "Cloudflare R2 access key: "
        prompt_value R2_SECRET_KEY "Cloudflare R2 secret key: " 1
        ADMIN_PASSWORD=""
        if [[ -n "$ADMIN_PASSWORD_FILE_INPUT" ]]; then
            [[ -f "$ADMIN_PASSWORD_FILE_INPUT" ]] || { err "admin password file not found"; exit 66; }
            [[ -r "$ADMIN_PASSWORD_FILE_INPUT" ]] || { err "admin password file is not readable"; exit 66; }
            ADMIN_PASSWORD="$(cat "$ADMIN_PASSWORD_FILE_INPUT")"
        else
            ADMIN_PASSWORD="$(openssl rand -hex 18)"
        fi
        [[ ${#ADMIN_PASSWORD} -ge 8 ]] || { err "admin password must be at least 8 characters"; exit 64; }

        export ALLOWED_ORIGIN R2_ACCOUNT_ID R2_ACCESS_KEY R2_SECRET_KEY R2_BUCKET BACKUP_R2_BUCKET BACKUP_R2_PATH INSTALL_ROOT DEPLOY_ROOT="$INSTALL_ROOT"
        log "running first-time VPS provisioning; generated secrets will be stored in $RUNTIME_ENV"
        (cd "$SOURCE_ROOT" && bash "$SOURCE_ROOT/deploy/scripts/bootstrap.sh")
        if [[ ! -f "$RUNTIME_ENV" ]]; then
            err "bootstrap did not create $RUNTIME_ENV"
            exit 66
        fi
        operator_home="$(getent passwd "$operator_user" | cut -d: -f6)"
        [[ -n "$operator_home" ]] || { err "cannot resolve home directory for $operator_user"; exit 66; }
        log "installing dependencies before account creation"
        sudo -u "$operator_user" -H env HOME="$operator_home" bash -c \
            "cd '$SOURCE_ROOT' && env -u NODE_ENV -u NPM_CONFIG_PRODUCTION -u NPM_CONFIG_OMIT npm ci --include=dev --prefer-offline --no-audit --no-fund"
        log "applying the schema before account creation"
        sudo -u mindleaf -H env HOME=/home/mindleaf bash -c \
            "cd '$SOURCE_ROOT' && set -a && source '$RUNTIME_ENV' && set +a && npm run ownership:prepare --workspace=@mindleaf/server && npm run db:push --workspace=@mindleaf/server -- --force"
        log "creating the first account through the server-side CLI"
        install -d -o "$operator_user" -g "$(id -gn "$operator_user")" -m 0700 "$(dirname "$CREDENTIAL_FILE")"
        umask 077
        SEED_PASSWORD_FILE="$(mktemp /tmp/.mindleaf-seed-password.XXXXXX)"
        printf '%s\\n' "$ADMIN_PASSWORD" > "$SEED_PASSWORD_FILE"
        chown mindleaf:mindleaf "$SEED_PASSWORD_FILE"
        chmod 600 "$SEED_PASSWORD_FILE"
        cleanup_admin_password() { rm -f "$SEED_PASSWORD_FILE"; }
        trap cleanup_admin_password EXIT
        sudo -u mindleaf -H env HOME=/home/mindleaf MINDLEAF_SEED_PASSWORD_FILE="$SEED_PASSWORD_FILE" bash -c \
            "cd '$SOURCE_ROOT' && set -a && source '$RUNTIME_ENV' && set +a && npm run seed --workspace=@mindleaf/server"
        rm -f "$SEED_PASSWORD_FILE"
        trap - EXIT
        {
            printf 'URL=%s\\n' "$ALLOWED_ORIGIN"
            printf 'PASSWORD=%s\\n' "$ADMIN_PASSWORD"
        } > "$CREDENTIAL_FILE"
        chown "$operator_user:$(id -gn "$operator_user")" "$CREDENTIAL_FILE"
        chmod 600 "$CREDENTIAL_FILE"
        log "account created; building and activating the first release"
        run_deploy
        verify_runtime
        log "admin credentials saved securely at $CREDENTIAL_FILE"
        ;;
esac

log "setup complete"
