#!/usr/bin/env bash
# Validate the invariants behind Mindleaf's one-click deployment entrypoint.
# This is intentionally dependency-light so it can run locally and in CI.
set -Eeuo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd -P)"
EXPECTED_RAW_URL="https://raw.githubusercontent.com/sinugrepo/mindleaf-note/main/scripts/setup.sh"

scripts=(
  "$REPO_ROOT/scripts/setup.sh"
  "$REPO_ROOT/scripts/migrate-vps.sh"
  "$REPO_ROOT/scripts/deploy.sh"
  "$REPO_ROOT/scripts/restart.sh"
  "$REPO_ROOT/deploy/scripts/bootstrap.sh"
  "$REPO_ROOT/deploy/scripts/backup.sh"
)

for script in "${scripts[@]}"; do
  [[ -f "$script" ]] || { echo "missing deployment script: $script" >&2; exit 1; }
  bash -n "$script"
  [[ -x "$script" ]] || { echo "deployment script is not executable: $script" >&2; exit 1; }
done

grep -Fq "$EXPECTED_RAW_URL" "$REPO_ROOT/scripts/setup.sh" || {
  echo "setup.sh does not contain the canonical raw GitHub URL" >&2
  exit 1
}

grep -RFnq "$EXPECTED_RAW_URL" \
  "$REPO_ROOT/README.md" \
  "$REPO_ROOT/scripts/setup.sh" \
  "$REPO_ROOT/docs/ONE-CLICK-DEPLOYMENT.md" || {
  echo "canonical raw GitHub URL is missing from user-facing documentation" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# Invariants that `bash -n` cannot catch. Each of these broke a real VPS
# provisioning run: the failure only shows up on the target machine, long
# after CI, so assert on the exact lines that keep the install working.
# ---------------------------------------------------------------------------
require_literal() {
  local file="$1" needle="$2" why="$3"
  grep -Fq -- "$needle" "$file" || {
    echo "missing from ${file#"$REPO_ROOT"/}: $needle" >&2
    echo "  why: $why" >&2
    exit 1
  }
}

forbid_literal() {
  local file="$1" needle="$2" why="$3"
  if grep -Fq -- "$needle" "$file"; then
    echo "forbidden pattern in ${file#"$REPO_ROOT"/}: $needle" >&2
    echo "  why: $why" >&2
    exit 1
  fi
}

BOOTSTRAP="$REPO_ROOT/deploy/scripts/bootstrap.sh"
DEPLOY="$REPO_ROOT/scripts/deploy.sh"
SETUP="$REPO_ROOT/scripts/setup.sh"

require_literal "$SETUP" 'umask 022' \
  "fresh mode clones the checkout and runs sudo -u mindleaf npm run ... inside it; under umask 077 those files are 0700/0600 and mindleaf is refused with EACCES"

require_literal "$BOOTSTRAP" 'umask 022' \
  "migrate-vps.sh invokes bootstrap directly under its own umask 077, and gpg --dearmor then writes 0600 APT keyrings that apt reports as NO_PUBKEY"
require_literal "$BOOTSTRAP" 'chmod 0644 "$dest"' \
  "every APT keyring must end up world-readable or apt cannot verify the PostgreSQL and Caddy repositories"
require_literal "$BOOTSTRAP" "CREATE ROLE mindleaf LOGIN PASSWORD :'db_password';" \
  "psql interpolates :'var' only when reading SQL from a file or stdin, so the statement must arrive through a heredoc"
forbid_literal "$BOOTSTRAP" '-c "CREATE ROLE' \
  "psql sends -c strings verbatim, which fails with 'syntax error at or near :'"
forbid_literal "$BOOTSTRAP" '-c "ALTER ROLE' \
  "psql sends -c strings verbatim, which fails with 'syntax error at or near :'"

require_literal "$DEPLOY" 'umask 022' \
  "migrate mode starts deploy.sh without sudo, so an inherited umask 077 produces a 0600 Caddyfile and a 0700 frontend dist that caddy cannot read"
require_literal "$DEPLOY" 'sudo chmod 0644 /etc/caddy/Caddyfile' \
  "caddy.service runs as User=caddy and refuses a Caddyfile it cannot read"
require_literal "$DEPLOY" 'sudo chmod 0644 /etc/cron.d/mindleaf-backup' \
  "the cron entry must keep the documented 0644 mode"

printf 'deployment script validation passed\n'
