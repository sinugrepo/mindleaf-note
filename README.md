# Mindleaf 🍃

> A local-first tree outliner and note-taking app for growing a digital garden.

Mindleaf keeps notes in the browser with IndexedDB so editing continues offline.
When configured and signed in, a Hono/PostgreSQL backend becomes the cloud
canonical store and Cloudflare R2 stores attachments.

## 🚀 The easiest deployment: one script

For a **new Ubuntu VPS**, first prepare the DNS and firewall:

- Point your domain's A/AAAA record to the VPS.
- Allow inbound TCP ports 80 and 443.
- Create two Cloudflare R2 buckets: `mindleaf-prod` for attachments and
  `mindleaf-prod-backups` for database backups.

Then run this one command as root:

```bash
curl -fsSL https://raw.githubusercontent.com/sinugrepo/mindleaf/main/scripts/setup.sh | sudo bash
```

The script will:

1. Download the project.
2. Ask for the public app URL and Cloudflare R2 credentials.
3. Install Node.js, PostgreSQL, Caddy, rclone, and required packages.
4. Create the protected `mindleaf` service account.
5. Generate and store application/database secrets in `/opt/mindleaf/.env`.
6. Configure PostgreSQL, backups, Caddy, and systemd.
7. Create the first account through the server-side `npm run seed` command.
8. Build the backend and frontend.
9. Generate the Caddy configuration from the domain you entered.
10. Start the application and verify `/healthz`.

The script is safe to run again. It detects the existing installation and performs
a normal release deployment instead of generating new secrets. Existing
`/opt/mindleaf/.env` is never replaced automatically. The one-line installer
keeps the checkout at `/opt/mindleaf-source`, so later updates can use the same
script without cloning the project again.

### Deploy a new release

From the checkout created by the one-line installer:

```bash
sudo bash /opt/mindleaf-source/scripts/setup.sh --pull
```

If you cloned the repository somewhere else, run the same command from that
checkout instead.

Use `--pull` to fetch the latest fast-forwardable commit from `main`. Without it,
the script deploys the checkout exactly as it is. To preview the deployment first:

```bash
sudo bash scripts/setup.sh --dry-run
```

### Move an existing installation to a new VPS

Migration is different from a fresh install because encrypted notes require the
original production secrets. Copy the old `.env` from a password manager or the
old server, then run:

```bash
sudo bash scripts/setup.sh \
  --mode migrate \
  --env-file /root/mindleaf.env
```

This restores the latest database backup from R2. The original
`MASTER_ENCRYPTION_KEY` must be supplied; without it, encrypted note content
cannot be read. To provision without importing the R2 database (this does not delete an
existing target database):

```bash
sudo bash scripts/setup.sh \
  --mode migrate \
  --env-file /root/mindleaf.env \
  --no-restore
```

If DNS/TLS is not ready yet, add `--skip-public-check`. Keep the original backup
and secret bundle until the new server has been verified.

### What the one script selects automatically

| Situation | Selected operation |
| --- | --- |
| `/opt/mindleaf/.env` does not exist and no `--env-file` is supplied | Fresh install |
| `/opt/mindleaf/.env` already exists | Deploy current checkout |
| `--mode migrate --env-file ...` is supplied | Data-preserving VPS migration |

The public entrypoint is [`scripts/setup.sh`](./scripts/setup.sh). It delegates
to the lower-level scripts that are still available for operators who need them.
Most users do not need to call those internal scripts directly:

- `deploy/scripts/bootstrap.sh` — low-level first-time VPS provisioning.
- `scripts/deploy.sh` — release build, atomic staging, service restart, health check,
  snapshots, and automatic rollback.
- `scripts/migrate-vps.sh` — low-level data-preserving VPS migration.

The default backup remote is `r2:mindleaf-prod-backups/db`; keep that backup
bucket/path unless you also update the migration script's `RCLONE_REMOTE`.

The one-line installer expects the default paths `/opt/mindleaf` and
`/opt/mindleaf-source`; this keeps the service files, cron backup, and runtime
paths consistent. The production service remains at `/opt/mindleaf`; do not
move that directory without also updating the systemd and backup configuration.
The backend binds only to `127.0.0.1:8787` in production and is exposed publicly
through Caddy, not through the Node port directly.

## 🖥️ Local development

Local development does not need a VPS or Cloudflare account.

### Requirements

- Node.js 22 or newer
- npm
- Docker and Docker Compose

### Start local services

```bash
npm install
docker compose up -d
```

This starts PostgreSQL on `localhost:5432` and MinIO on `localhost:9000` (the
MinIO console is on `localhost:9001`).

Create the local backend configuration:

```bash
cp apps/server/.env.example apps/server/.env
openssl rand -base64 32   # replace SESSION_SECRET
openssl rand -base64 32   # replace MASTER_ENCRYPTION_KEY
```

For local development, the example file already contains development-only
PostgreSQL/MinIO credentials. Do not reuse them in production.

Create the database and initial account:

```bash
npm --prefix apps/server run db:push
npm --prefix apps/server run seed
```

Run the two applications in separate terminals:

```bash
# Terminal 1
npm --prefix apps/server run dev

# Terminal 2
npm --prefix apps/web run dev
```

Open <http://localhost:3000>. Vite proxies `/api` to the backend on port `8787`.

## ✨ Main features

- Nested notes and folders with expand/collapse, ordering, and drag-and-drop.
- Context-menu actions, bulk actions, Trash, restore, and 30-day local purge.
- Rich-text editor with headings, lists, tasks, code, links, images, and wiki-links.
- Tags, multi-tag filtering, fuzzy search, and backlinks.
- Sorting by manual order, updated time, created time, or title, ascending/descending.
- Saved Views for restoring search, tag filters, and sort preferences.
- Light, dark, and system themes.
- `.treenote` backup/restore with cloud-export fallback to local cache.
- Offline-first sync with queued mutations, pagination, conflicts, tombstones,
  recovery state, and cross-tab coordination.
- Argon2id authentication, HttpOnly signed sessions, and encrypted note content.

## 🧱 Architecture

| Area | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite 6, Tailwind CSS v4, TipTap 3 |
| Local storage | Dexie 4 / IndexedDB |
| State and search | Zustand / Fuse.js |
| Backend | Hono 4 on Node.js 22 |
| Database | PostgreSQL 16 with Drizzle ORM |
| Attachments | Cloudflare R2 or another S3-compatible store |
| Production process | Caddy + systemd + journald |

The repository is organized as:

```text
apps/web/          React SPA, IndexedDB cache, sync client, tests
apps/server/       Hono API, auth, notes, sync, backups, R2 integration
packages/shared/   Shared DTOs and sync/backup contracts
deploy/             Caddy, systemd, cron, bootstrap, backup assets
scripts/            One-command setup, deployment, and migration entrypoints
docs/               Detailed operational runbooks
```

## 🔐 Important safety rules

- Never commit `.env`, `.pgpass`, rclone configuration, or production credentials.
- Keep `MASTER_ENCRYPTION_KEY` in a password manager. It is required to decrypt
  existing encrypted note content after restore or migration.
- Never run fresh-install mode over an existing `/opt/mindleaf` installation.
- The first install needs a domain already pointing to the VPS, ports 80/443
  open, and two R2 buckets: `mindleaf-prod` for attachments and
  `mindleaf-prod-backups` for database backups. Change `R2_BUCKET` or the
  backup remote only in the production configuration if you use different names.
- The first account is created only through the server-side CLI seed flow; never
  expose a public setup endpoint or place the master password in a URL.
- Keep a database backup before schema changes or migration.
- `--no-restore` is for an empty/new database; it is not a replacement for a
  data-preserving migration.
- The deployment script keeps runtime snapshots and rolls back automatically when
  the backend health check fails.

## 🧪 Validation

Run the frontend tests and builds from the repository root:

```bash
npm --prefix apps/web run test:run
npm --prefix apps/web run lint
npm --prefix apps/web run build
npm --prefix apps/server run lint
npm --prefix apps/server run build
git diff --check
```

The backend has a Vitest regression suite for P0 hardening; broader route and
PostgreSQL integration coverage remains tracked in
[`docs/STABILITY-ROADMAP.md`](./docs/STABILITY-ROADMAP.md).

## 🛠️ Useful operational commands

Most users only need `scripts/setup.sh`. A redeploy from an existing checkout
runs as the normal VPS operator and requires the passwordless sudo rule created
by the first-time bootstrap; do not run the service itself as root.


```bash
sudo bash /opt/mindleaf-source/scripts/setup.sh --help
sudo bash /opt/mindleaf-source/scripts/setup.sh --dry-run
sudo bash /opt/mindleaf-source/scripts/setup.sh --pull
```

After a fresh install, open the public HTTPS address in your browser and log in
with the master password entered by the administrator during the server-side
`npm run seed` step. Account creation is intentionally not exposed as a public
browser endpoint. The local health check only proves that the backend is running;
DNS, HTTPS, and R2 storage must also be ready for the complete application to work.

For detailed troubleshooting, backups, rollback, DNS/TLS, and VPS recovery, see:

- [`docs/DEPLOY.md`](./docs/DEPLOY.md)
- [`docs/MIGRASI-VPS.md`](./docs/MIGRASI-VPS.md)
- [`scripts/README-migrate-vps.txt`](./scripts/README-migrate-vps.txt)

Health check after deployment:

```bash
curl --fail http://localhost:8787/healthz
```

Expected response:

```json
{"ok":true}
```

## ⚖️ License

No `LICENSE` file is checked in. Treat the source as all-rights-reserved by the
author until a license file is added. Please open an issue before forking or
redistributing.

---

Made with care — keep your mind's garden tidy. 🌿
