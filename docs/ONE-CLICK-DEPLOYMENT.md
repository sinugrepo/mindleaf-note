# Mindleaf One-Click Deployment & Migration

Status: implementation checklist for the VPS setup/deploy flow.

## Executive summary

Mindleaf has one public operational entrypoint:

```bash
curl -fsSL https://raw.githubusercontent.com/sinugrepo/mindleaf-note/main/scripts/setup.sh | sudo bash
```

`scripts/setup.sh` delegates to the lower-level scripts instead of duplicating
provisioning logic:

- `deploy/scripts/bootstrap.sh` — OS, PostgreSQL, service user, runtime secrets,
  rclone, and initial schema provisioning.
- `scripts/deploy.sh` — build, atomic release staging, service configuration,
  restart, healthcheck, snapshots, and automatic rollback.
- `scripts/migrate-vps.sh` — data-preserving migration from an R2 PostgreSQL
  dump using the original production secrets.
- `deploy/scripts/backup.sh` — scheduled PostgreSQL backup to R2.

This separation is intentional. A single public command is easier for users,
while separate authoritative phases remain easier to test, troubleshoot, and
recover safely.

## Current one-click modes

| Situation | Selected mode | Current behavior |
| --- | --- | --- |
| New VPS with no `/opt/mindleaf/.env` | `fresh` | Collects the public URL and R2 credentials in one input phase, generates application/database/admin secrets, creates and verifies both R2 destinations, provisions PostgreSQL/Caddy/rclone, builds, deploys, and refuses success until local/public health and all services pass. |
| Existing installation with `/opt/mindleaf/.env` | `deploy` | Optionally fast-forwards the persistent checkout, builds, stages a release, applies schema, restarts the service, and health-checks. |
| New VPS with existing encrypted data | `migrate` | Requires the original secret bundle, validates R2, selects/restores a dump, deploys locally, and checks local/public health. |

### Fresh install prerequisites

The script can install the VPS software, but the operator must still provide:

- an Ubuntu VPS with root/sudo access and outbound internet;
- DNS pointing the application hostname to the VPS;
- inbound TCP 80/443;
- Cloudflare R2 credentials;
- an R2 API token with permission to create/read/write the attachment and backup buckets; setup creates missing buckets.

> ⚠️ `setup.sh` prints the same prerequisite warning before provisioning. It
> stops with an error if DNS, ports, R2 permissions, local services, or public
> HTTPS are not ready; it never reports a partial deployment as completed.

Fresh setup uses safe defaults (`mindleaf-prod`, `mindleaf-prod-backups`, `db`), accepts overrides through `--r2-bucket`, `--backup-r2-bucket`, and `--backup-r2-path`, and creates/verifies those destinations with `rclone`. The R2 token therefore needs bucket-management permission for the first install; object-only credentials are rejected before setup claims completion. Existing installations keep their current `.env` and are never silently rewritten.

### Data-preserving migration constraint

A migration cannot generate a new `MASTER_ENCRYPTION_KEY`. The database dump
contains encrypted note content, so the original key is required to read the
restored data. The migration also preserves the original session secret unless
the operator intentionally rotates it after recovery.

The secret bundle must contain, at minimum:

```text
DATABASE_URL
MASTER_ENCRYPTION_KEY
SESSION_SECRET
R2_ACCOUNT_ID
R2_ACCESS_KEY
R2_SECRET_KEY
ALLOWED_ORIGIN
```

The bundle must be kept outside Git and protected with mode `0600`.

## Implemented in this update

- Corrected the documented/raw GitHub one-liner to use the actual repository:
  `sinugrepo/mindleaf-note`.
- Fixed the `scripts/migrate-vps.sh` shell syntax error that prevented the
  migration script from passing `bash -n`.
- Added a setup preflight that syntax-checks every delegated operational script
  before fresh provisioning or migration work begins.
- Kept the existing secret-safe behavior: values are read from prompts or an
  env file and are not printed by the orchestrator.
- Added a regression-oriented checklist below so future setup changes are not
  considered complete without shell and application validation.

## Prioritized update checklist

### P0 — blockers and safety gates

- [x] Use the correct repository URL in the public one-liner and setup help.
- [x] Make `scripts/migrate-vps.sh` pass `bash -n`.
- [x] Make operational scripts executable where direct execution is documented.
- [x] Run `bash -n` on delegated scripts before provisioning.
- [x] Add a dependency-light `scripts/validate-deploy-scripts.sh` validator and expose it as `npm run validate:deploy`.
- [x] Run `npm run validate:deploy` in automated CI on pushes and pull requests (`.github/workflows/validate-deploy.yml`).
- [x] Keep CI's backend integration-test limitation explicit: the 12 destructive PostgreSQL/R2 tests remain skipped unless isolated `TEST_DATABASE_URL` and `TEST_R2_*` credentials are provisioned.
- [ ] Add a separate isolated CI integration job with disposable PostgreSQL and R2-compatible storage.
- [ ] Add a safe migration dry-run that validates inputs and shows the restore
      plan without changing packages, services, or the database.

### P1 — one-click user experience

- [ ] Add an explicit interactive mode selector when `--mode auto` cannot
      unambiguously identify the intended operation.
- [x] Collect attachment bucket, backup bucket, and backup path with safe
      defaults (`mindleaf-prod`, `mindleaf-prod-backups`, `db`) and CLI/env overrides.
- [x] Create and validate R2 destinations before setup completes.
- [x] Generate the initial admin password when none is supplied, seed without a
      prompt, and save it in a protected credentials file.
- [ ] List available `.dump` objects during migration and require explicit
      confirmation of the selected restore object.
- [ ] Add a password confirmation prompt for the first account, without putting
      the password in a command line or persistent log.
- [x] Show final completion output containing the credential-file location;
      verification gates cover service status, healthchecks, and both R2 targets.
- [x] Add `--non-interactive` plus `MINDLEAF_*` environment inputs; missing
      external values fail before provisioning rather than opening a hidden prompt.
- [x] Add final completion gates for active PostgreSQL/Mindleaf/Caddy services,
      local/public health, and attachment/backup storage.

### P1 — data-preserving migration

- [ ] Require an explicit confirmation before `pg_restore --clean`.
- [ ] Verify the final backup object and record its name in the migration log.
- [ ] Verify PostgreSQL readiness, R2 access, local health, public health, and
      restored note count before declaring success.
- [ ] Keep the previous VPS offline during cutover and document the maintenance
      window in the command output.
- [ ] Add a recovery path for partial `pg_restore` failure that leaves the
      target service stopped until the operator confirms the next action.

### P2 — cloud/resource automation

- [x] Create missing R2 buckets during fresh setup using the supplied token;
      object-only tokens fail clearly before completion.
- [x] Add configurable attachment/backup bucket and path values instead of
      relying only on the historical hard-coded default.
- [ ] Validate bucket names and prevent accidental use of a production bucket
      as an integration-test bucket.

### P2 — observability and maintainability

- [ ] Add shell tests for mode selection, argument validation, secret-file
      permission checks, and dry-run behavior using isolated temporary paths.
- [ ] Add a documented `--version`/release identifier to setup output.
- [ ] Keep lower-level scripts authoritative and make `setup.sh` an orchestrator
      rather than copying implementation details into the public wrapper.
- [ ] Add a post-deploy smoke test for login, note creation, attachment upload,
      and backup access where isolated credentials are available.

## Validation checklist for every setup/deploy change

```bash
# Deployment invariants
npm run validate:deploy

# Shell syntax (the validator above runs these checks too)
bash -n scripts/setup.sh
bash -n scripts/migrate-vps.sh
bash -n scripts/deploy.sh
bash -n deploy/scripts/bootstrap.sh
bash -n deploy/scripts/backup.sh

# Safe help/dry-run checks
bash scripts/setup.sh --help
bash scripts/setup.sh --dry-run       # on a suitable VPS/operator context
bash scripts/deploy.sh --help
bash scripts/deploy.sh --dry-run      # on a suitable VPS/operator context
bash scripts/migrate-vps.sh --help

# Application validation
npm --prefix apps/web run test:run
npm --prefix apps/web run lint
npm --prefix apps/web run build
npm --prefix apps/server run test:run
# Optional destructive integration coverage requires isolated TEST_DATABASE_URL/TEST_R2_*.
npm --prefix apps/server run lint
npm --prefix apps/server run build

git diff --check
```

Never run a real fresh install or migration as a test on a production VPS.
Use an isolated disposable VPS or a mocked/temp-path shell test for destructive
phases. Never commit `.env`, `.pgpass`, rclone configuration, or generated
manifest/backup artifacts.

## Recommended user-facing commands

Fresh VPS (the script prints a prerequisite warning first; interaction is only
for missing external values):

```bash
curl -fsSL https://raw.githubusercontent.com/sinugrepo/mindleaf-note/main/scripts/setup.sh | sudo bash
```

Fully non-interactive fresh VPS (recommended for automation; do not put this
command with real secrets in shell history):

```bash
sudo env \
  MINDLEAF_NON_INTERACTIVE=1 \
  MINDLEAF_ALLOWED_ORIGIN=https://notes.example.com \
  MINDLEAF_R2_ACCOUNT_ID=... \
  MINDLEAF_R2_ACCESS_KEY=... \
  MINDLEAF_R2_SECRET_KEY=... \
  MINDLEAF_ADMIN_PASSWORD_FILE=/root/mindleaf-admin-password \
  bash /opt/mindleaf-source/scripts/setup.sh --mode fresh
```

The password file should be mode `0600` and must not be committed. If
`MINDLEAF_ADMIN_PASSWORD_FILE` is omitted, setup generates one and stores it at
`/var/lib/mindleaf/admin-credentials.txt` with mode `0600`.

Redeploy existing checkout:

```bash
sudo bash /opt/mindleaf-source/scripts/setup.sh --pull
```

Migrate existing encrypted data:

```bash
sudo bash scripts/setup.sh \
  --mode migrate \
  --env-file /root/mindleaf.env
```

The migration command still requires the original production secret bundle by
design. A wizard can collect those values in a later phase, but it cannot
recover a secret that the operator no longer possesses.
