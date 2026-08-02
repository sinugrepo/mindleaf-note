# Mindleaf 🍃

> A local-first tree outliner and note-taking app for growing a digital garden.

Mindleaf stores the working copy of your notes in the browser with IndexedDB, so
editing remains available offline. When the backend is configured and the user is
signed in, a Hono/PostgreSQL service becomes the cloud canonical store and
Cloudflare R2 stores attachments. The frontend and backend are maintained in this
monorepo.

## ✨ Current features

- **Nested notes and folders** with expand/collapse, manual ordering, and drag-and-drop moves.
- **Context-menu actions** on every tree row: add child note/folder, move up/down, rename, and delete.
- **Bulk actions** for selected notes: add tags, move, export, and move to Trash.
- **Rich-text editor** powered by TipTap: headings, lists, task lists, code, links, and resizable images.
- **Wiki-links** such as `[[Note Title]]`, autocomplete, and a backlinks panel.
- **Tags** with normalized tag values, tag chips, and multi-tag AND filtering.
- **Search** with local fuzzy search and a PostgreSQL full-text-search endpoint for cloud operations.
- **Sorting** by manual order, updated time, created time, or title, in ascending or descending direction.
- **Saved views** that preserve the active tag filter and sort settings in the browser.
- **Trash** with restore and automatic purge after 30 days.
- **Themes**: Light, Dark, or System (follows the operating system preference).
- **Backup and restore** using `.treenote` files; cloud export includes synced notes and attachment metadata when available, with local-cache fallback when the backend is unavailable.
- **Offline-first sync** with a pending mutation queue, pagination, optimistic locking, conflict actions, remote-deletion recovery, and cross-tab coordination.
- **Authentication** using an Argon2id password hash and an HttpOnly, HMAC-signed session cookie.

## 🧱 Architecture

### Frontend — `apps/web`

- React 19 + TypeScript + Vite 6
- Tailwind CSS v4
- TipTap 3
- Zustand for UI preferences and local state
- Dexie 4 for IndexedDB
- Fuse.js for local fuzzy search
- Vitest + Testing Library + fake IndexedDB for tests

The browser cache is the primary editing surface. Notes, attachments, pending
mutations, and sync state are stored locally. UI preferences such as theme,
sort, tag filters, and saved views are persisted with Zustand/localStorage.

### Backend — `apps/server`

- Hono 4 on Node.js 22
- PostgreSQL 16 with Drizzle ORM
- Argon2id password hashing
- AES-256-GCM encryption for note content at rest
- Cloudflare R2 or another S3-compatible store for attachments
- Pino JSON logs sent to journald in production

### Shared package — `packages/shared`

Shared TypeScript DTOs and sync/backup contracts used by the frontend and
backend.

## 🚀 Local development

### Prerequisites

- Node.js 22 or newer
- npm
- Docker and Docker Compose for local PostgreSQL and MinIO

### 1. Install dependencies

```bash
npm install
```

### 2. Start local services

```bash
docker compose up -d
```

This starts PostgreSQL on `localhost:5432` and MinIO on `localhost:9000`
(with the MinIO console on `localhost:9001`).

### 3. Configure the backend

```bash
cp apps/server/.env.example apps/server/.env
```

Set values appropriate for local development. Generate the two cryptographic
secrets rather than using the placeholders:

```bash
openssl rand -base64 32   # SESSION_SECRET
openssl rand -base64 32   # MASTER_ENCRYPTION_KEY
```

The web `.env.example` documents `VITE_API_URL`; in development, Vite proxies
`/api` to `http://localhost:8787` by default, so an additional web env file is
usually not needed.

### 4. Create the schema and initial account

The root package does not wrap workspace database commands. Run them explicitly:

```bash
npm --prefix apps/server run db:push
npm --prefix apps/server run seed
```

The seed command prompts for the initial master password. The application also
supports the browser onboarding/setup flow for a new installation.

### 5. Run the frontend and backend

Run each process in its own terminal:

```bash
# Terminal 1 — backend
npm --prefix apps/server run dev

# Terminal 2 — frontend
npm --prefix apps/web run dev
```

Open <http://localhost:3000>. The Vite development server proxies `/api` calls
to the backend on port `8787`, preserving cookie-based authentication.

## 🧪 Validation and tests

The frontend has the automated test suite. The server currently exposes test
script placeholders and does not yet have a server integration-test suite.
Recommended checks from the repository root are:

```bash
npm --prefix apps/web run test:run
npm --prefix apps/web run lint
npm --prefix apps/server run lint
npm --prefix apps/server run build
npm --prefix apps/web run build
git diff --check
```

`lint` runs TypeScript with `--noEmit`; it is a typecheck rather than a stylistic
linter. See [`docs/STABILITY-ROADMAP.md`](./docs/STABILITY-ROADMAP.md) for the
remaining server integration-test and scale-fixture work.

## 🔄 Sync and recovery behavior

When signed in, the sync engine pushes queued local mutations and pulls server
deltas. The protocol uses a fixed server boundary, stable `(timestamp, id)`
stream cursors, and bounded pages. A page accepts up to 500 records; the client
continues through every page before advancing its local cursor.

Important safeguards:

- Repeated offline edits to one note are coalesced in the local queue.
- Two tabs coordinate queue draining with Web Locks and an IndexedDB lease fallback.
- Permanent deletions are represented by server tombstones.
- A remote `404` is treated as a remote-deletion recovery case rather than an
  ordinary conflict that can be resolved with a useless request.
- Tombstones are retained for 90 days by default (`TOMBSTONE_RETENTION_DAYS`).
- If a device cursor is older than the retained deletion history, the server
  returns `410` and the client persists a visible **Recovery required** state.
  The client does **not** reset the cursor or delete local data automatically.
  Preserve/export the local data and perform an explicit full-recovery procedure
  before clearing that state.

## 📦 Data and operational limits

These limits protect the single-user VPS deployment from unbounded memory and
storage work:

| Area | Current limit |
| --- | --- |
| Individual attachment upload | 5 MB; MIME type and actual object size are verified |
| Backup import file | 100 MB parsed-file limit, within a 150 MB request ceiling |
| Notes in one backup import | 50,000 |
| Attachments in one backup import | 50,000 |
| Cloud export attachment budget | 150 MB total binary attachment data |
| Sync page size | 250 by default, 500 maximum |
| Backend search response | 50 ranked notes |
| Search results rendered in the sidebar | 100 notes |
| Trash retention | 30 days locally |
| Sync tombstone retention | 90 days by default |

Backup import currently commits work incrementally and does not yet provide
resume/checkpoint support. For large or important restores, keep the original
backup and verify the result before deleting the source copy.

## ⌨️ Keyboard shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` / `Cmd + N` | Create a new root note |
| `Ctrl` / `Cmd + Shift + N` | Create a child note under the active note |
| `Ctrl` / `Cmd + F` | Focus search |
| `Delete` | Open delete confirmation for the active tree row |
| `F2` | Open rename for the active tree row |
| `Ctrl` / `Cmd + S` | No-op; changes are autosaved |

When wiki-link autocomplete is open, `↑`, `↓`, `Enter`, and `Esc` are handled by
the autocomplete popover.

## 🛠️ Useful commands

Run frontend commands with `npm --prefix apps/web ...` and backend commands with
`npm --prefix apps/server ...`.

| Command | Purpose |
| --- | --- |
| `npm --prefix apps/web run dev` | Start Vite on port 3000 |
| `npm --prefix apps/server run dev` | Start Hono on port 8787 with watch mode |
| `npm --prefix apps/web run build` | Build the production SPA |
| `npm --prefix apps/server run build` | Compile the backend to `apps/server/dist` |
| `npm --prefix apps/web run test:run` | Run the frontend tests once |
| `npm --prefix apps/web run test` | Run frontend tests in watch mode |
| `npm --prefix apps/web run lint` | Typecheck the frontend |
| `npm --prefix apps/server run lint` | Typecheck the backend |
| `npm --prefix apps/server run db:push` | Apply the current Drizzle schema |
| `npm --prefix apps/server run db:generate` | Generate Drizzle migrations |
| `npm --prefix apps/server run db:migrate` | Apply generated migrations |
| `npm --prefix apps/server run db:studio` | Open Drizzle Studio |
| `npm --prefix apps/server run seed` | Create/update the initial user |

The root `package.json` still contains a small set of frontend-oriented Vite
scripts. Use the workspace commands above for the full monorepo workflow.

## 🚢 Production deployment

Production uses a VPS-local release flow:

- Caddy serves the built SPA and reverse-proxies `/api`.
- The Hono backend runs as the `mindleaf` systemd service on `localhost:8787`.
- PostgreSQL runs as a host service.
- Cloudflare R2 stores attachments and database backups.
- A daily cron job creates compressed PostgreSQL backups and applies retention.

From an existing, provisioned VPS checkout, run:

```bash
./scripts/deploy.sh
```

The script builds the backend and frontend, stages the SPA, synchronizes the
schema by default, installs/validates service configuration, restarts the
backend, checks `http://localhost:8787/healthz`, and can roll back if health
checks fail.

Useful options:

```bash
./scripts/deploy.sh --dry-run       # show the plan without changing services
./scripts/deploy.sh --no-migrate    # skip Drizzle schema synchronization
./scripts/deploy.sh --rollback      # restore the newest runtime snapshot
./scripts/deploy.sh --pull          # fetch/pull before deploying
```

For first-time provisioning, VPS migration, Caddy, backups, rollback, and
incident recovery, use [`docs/DEPLOY.md`](./docs/DEPLOY.md) and
[`docs/MIGRASI-VPS.md`](./docs/MIGRASI-VPS.md). After a release, verify:

```bash
curl --fail http://localhost:8787/healthz
```

Expected response:

```json
{"ok":true}
```

## 📁 Repository layout

```text
mindleaf-note/
├── apps/
│   ├── web/                 React/Vite frontend, IndexedDB, sync client, tests
│   └── server/              Hono API, Drizzle schema, auth, sync, backup, R2
├── packages/shared/         Shared DTOs and sync/backup types
├── deploy/                  Caddy, systemd, cron, and VPS bootstrap assets
├── scripts/                 Deployment and VPS migration entrypoints
├── docs/                    Deployment and stability runbooks
├── docker-compose.yml       Local PostgreSQL and MinIO
└── package.json             npm workspace root
```

## 🧭 Stability roadmap

Implemented hardening includes cursor-safe paginated sync, tombstones,
coalesced mutations, cross-tab queue coordination, tree traversal guards,
database indexes, bounded search rendering, upload verification, backup limits,
and the persisted recovery-required gate.

Still intentionally pending:

- Explicit user-confirmed full-resync UX after cursor expiry.
- Server integration tests for sync pagination, tombstone retention, and upload verification.
- Indexed note-link tables and metadata-only queries for very large local datasets.
- Scale fixtures and benchmarks for 1,000–50,000 notes.
- Resumable/checkpointed backup import.
- Attachment metadata/R2 reconciliation and orphan-object cleanup.
- Quotas, automated restore drills, and multi-instance/distributed sync work.

The detailed checklist is maintained in [`docs/STABILITY-ROADMAP.md`](./docs/STABILITY-ROADMAP.md).

## ⚖️ License

No `LICENSE` file is checked in. Treat the source as all-rights-reserved by the
author until a license file is added. Please open an issue before forking or
redistributing.

---

Made with care — keep your mind's garden tidy. 🌿
