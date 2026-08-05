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

printf 'deployment script validation passed\n'
