ONE-COMMAND VPS MIGRATION
==========================

On a new Ubuntu VPS, as root:

  sudo bash scripts/migrate-vps.sh --env-file /root/mindleaf.env

The env file must be copied from the old VPS/password manager and must retain:
- MASTER_ENCRYPTION_KEY (required to decrypt existing notes)
- SESSION_SECRET
- DATABASE_URL
- R2_ACCOUNT_ID, R2_ACCESS_KEY, R2_SECRET_KEY
- ALLOWED_ORIGIN

The command clones main from GitHub, installs PostgreSQL/Caddy/rclone/Node,
creates the mindleaf service account and cron prerequisites, configures PostgreSQL
and R2, restores the latest database dump from r2:mindleaf-prod-backups/db,
builds and deploys locally, enables services, and verifies local/public health.
It refuses to continue if an existing /opt/mindleaf/.env differs from --env-file,
and explicitly supplies /opt/mindleaf/.pgpass for unattended DB restore/backup.

Options:
  --source-dir /path/to/checkout   Use a local/private checkout instead of clone.
  --backup-object FILE.dump        Restore an exact R2 dump instead of latest.
  --skip-public-check               Use while DNS/TLS is not ready yet.
  --no-restore                      Provision an empty database (new installation).
  --timeout 1200                    Kill a stuck bootstrap/deploy phase (with
                                     a 30-second child-process kill grace).

The script does not modify application source files. It only installs the source
and infrastructure artifacts on the target VPS. Never commit the env file.
It synchronizes the existing PostgreSQL role password to DATABASE_URL on the
replacement VPS and explicitly uses /opt/mindleaf/.pgpass for TCP connections.
The deploy migration uses Drizzle `--force` for unattended operation; keep the
R2 backup and inspect schema changes before deploying unrelated schema edits.
