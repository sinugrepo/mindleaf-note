# Mindleaf 🍃

> A tree-based outliner and note-taking app — your mind's digital garden.
> **Local-first** IndexedDB cache + optional **cloud backend** (Postgres + R2).

Mindleaf started as a 100% local single-page React app. It is now being
migrated to a **hybrid offline-first** architecture: a Hono + Postgres +
Cloudflare R2 backend provides sync, search, and encryption, while
IndexedDB remains the **primary local cache** so the app works fully
offline. See [`CLOUD_MIGRATION_PLAN.md`](./CLOUD_MIGRATION_PLAN.md) for
the full migration plan and progress tracker.

## ✨ Features

- **Tree-structured notes** with nested folders and manual ordering
- **Rich-text editor** (TipTap) — headings, lists, tasks, code, links, **resizable images**
- **Wiki-links** — `[[Note Title]]` with autocomplete and a live **backlinks panel**
- **Tags** — multi-tag chips with AND-filtering from the sidebar
- **Fuzzy search** (Fuse.js) with keyboard-shortcut focus
- **Sort modes** — Manual, Updated, Created, Title
- **Trash** with restore and auto-purge after 30 days
- **Themes** — Light, Dark, or follow-system
- **Export / Import** — single `.treenote` backup (notes + attachments, base64 images)
- **Cloud sync** *(in progress)* — AES-256-GCM server-side encryption, presigned R2 image uploads

## 🧰 Tech Stack

### Frontend (`apps/web`)

**React 19** + **TypeScript** · **Vite 6** · **Tailwind CSS v4** · **TipTap 3**
**Zustand** · **Dexie 4** (IndexedDB) · **Fuse.js** · **lucide-react** · **motion**
Vitest + jsdom + fake-indexeddb

### Backend (`apps/server`) — *new*

**Hono 4** + **Node.js 22** · **Drizzle ORM** + **PostgreSQL 16** · **@node-rs/argon2**
**AES-256-GCM** (Node `crypto`) · **@aws-sdk/client-s3** (Cloudflare R2 / MinIO)
Docker Compose for local dev (Postgres + MinIO)

### Shared (`packages/shared`)

TypeScript types shared between backend (Drizzle result typing) and frontend
(API hook typing) — `NoteDTO`, `AttachmentDTO`, `SyncSnapshot`, etc.

## 🚀 Getting Started

### Prerequisites

- **Node.js** ≥ 22
- **Docker** + **Docker Compose** (for local Postgres + MinIO)

### 1. Install dependencies

```bash
npm install          # installs all workspace packages
```

### 2. Start local infrastructure

```bash
docker compose up -d # PostgreSQL on :5432, MinIO on :9000 (console :9001)
```

### 3. Configure backend secrets

```bash
cp apps/server/.env.example apps/server/.env

# Generate the two required secrets:
openssl rand -base64 32  # → paste into SESSION_SECRET
openssl rand -base64 32  # → paste into MASTER_ENCRYPTION_KEY
```

### 4. Push database schema & create your account

```bash
npm run db:push       # Drizzle Kit syncs schema → Postgres
npm run seed          # prompts for your master password (min 8 chars)
```

### 5. Run the app (frontend + backend)

```bash
npm run dev           # starts both apps/web (Vite :3000) + apps/server (Hono :8787)
```

Or run them separately:

```bash
npm run dev:web       # Vite on http://localhost:3000 (proxies /api → :8787)
npm run dev:server    # Hono backend on http://localhost:8787 (tsx --watch)
```

Open **http://localhost:3000** — the app talks to the backend via Vite's
`/api` proxy (so HttpOnly cookies work seamlessly in dev).

### Scripts

Run from the **repo root** (delegates to workspaces):

| Script | Purpose |
| --- | --- |
| `npm run dev` | Start frontend + backend concurrently |
| `npm run dev:web` | Frontend only (Vite :3000) |
| `npm run dev:server` | Backend only (Hono :8787, hot reload) |
| `npm run build` | Production build (web → `apps/web/dist`, server → `apps/server/dist`) |
| `npm run lint` | TypeScript type-check (`tsc --noEmit`) for all workspaces |
| `npm run test` | Vitest (watch mode, frontend) |
| `npm run test:run` | Vitest single run (frontend) |
| `npm run clean` | Remove all `dist/` directories |
| `npm run db:push` | Drizzle Kit: sync schema → Postgres |
| `npm run db:studio` | Drizzle Studio: visual DB browser |
| `npm run seed` | Create/update the single user with a master password |

Backend-only scripts (run via `npm run <script> --workspace=apps/server`):

| Script | Purpose |
| --- | --- |
| `db:generate` | Generate SQL migration files from schema changes |
| `db:migrate` | Apply generated migrations |
| `start` | Run compiled backend (`node dist/index.js`) |

## ⌨️ Shortcuts

| Shortcut | Action |
| --- | --- |
| `Ctrl` / `Cmd + N` | New root note |
| `Ctrl` / `Cmd + Shift + N` | New child note under active note |
| `Ctrl` / `Cmd + F` | Focus search |
| `Ctrl` / `Cmd + S` | Suppressed — autosave handles persistence |

The `[[` autocomplete popover intercepts `↑` / `↓`, `Enter`, and `Esc` while open.

## 📁 Project Layout

```
mindleaf/
├── apps/
│   ├── web/                      # Frontend (React + Vite + TipTap)
│   │   ├── src/
│   │   │   ├── components/       # Layout, Sidebar, TreeView, Editor, …
│   │   │   ├── extensions/       # TipTap: ResizableImage, WikiLink
│   │   │   ├── hooks/            # useResizablePanel, useGlobalKeyboardShortcuts, …
│   │   │   ├── lib/              # Pure logic — notes, tree-ops, wikilink, tags, …
│   │   │   ├── api/              # Fetch-based API client for backend (auth, notes, sync)
│   │   │   ├── sync/             # Offline-first sync engine (queue, drainer, pull, push, conflict)
│   │   │   ├── db/db.ts          # Dexie schema + migrations + GC (v1 → v5)
│   │   │   ├── store/            # Zustand store (theme, sort, filter, active note)
│   │   │   └── test/             # Vitest setup (jsdom + fake-indexeddb)
│   │   ├── vite.config.ts        # Vite + /api proxy → backend :8787
│   │   └── vitest.config.ts
│   └── server/                   # Backend (Hono + Drizzle + Postgres) — NEW
│       ├── src/
│       │   ├── index.ts          # Hono entry, route mounting, /healthz
│       │   ├── env.ts            # AppEnv type (Hono Variables)
│       │   ├── crypto.ts         # AES-256-GCM encrypt/decrypt
│       │   ├── r2.ts             # S3 client (R2/MinIO) + presigned URL helpers
│       │   ├── db/
│       │   │   ├── schema.ts     # Drizzle schema: users, sessions, notes, attachments
│       │   │   └── index.ts      # postgres-js + Drizzle instance
│       │   ├── routes/
│       │   │   ├── auth.ts       # POST /login, /logout, /setup (Argon2id)
│       │   │   ├── notes.ts      # CRUD + recursive CTE + optimistic locking
│       │   │   ├── upload.ts     # Presigned PUT/GET for R2 image uploads
│       │   │   ├── search.ts     # ILIKE title search (FTS deferred to Phase 6)
│       │   │   └── sync.ts       # Delta sync snapshot endpoint
│       │   ├── middleware/
│       │   │   ├── auth.ts       # Session middleware (HMAC cookie, rolling expiry)
│       │   │   └── ratelimit.ts  # In-memory token-bucket rate limiter
│       │   └── seed.ts           # User creation script
│       ├── drizzle.config.ts
│       └── .env.example
├── packages/
│   └── shared/                   # Shared TypeScript types (NoteDTO, SyncSnapshot, …)
│       └── src/index.ts
├── docker-compose.yml            # PostgreSQL 16 + MinIO for local dev
├── CLOUD_MIGRATION_PLAN.md       # Full migration plan + progress tracker
└── package.json                  # npm workspaces root
```

## 💾 Data & Architecture

### Frontend (IndexedDB — local cache)

- **Notes & attachments** → IndexedDB via Dexie (`apps/web/src/db/db.ts`, schema versions `v1 → v5` with in-place migrations; v5 adds `sync_state` + `pending_mutations` tables and sync fields on notes/attachments).
- **UI prefs** (theme, sort, filter, active note) → `localStorage` via Zustand `persist`.
- On every launch: `gcAttachments()` drops orphaned attachments; `purgeOldTrash()` hard-deletes items soft-deleted > 30 days ago.
- Wiki-links are stored as `<span data-wikilink-id="…">` so the DB stays the source of truth for navigation.
- Tags are normalized to **lowercase kebab-case** (helper functions in `src/lib/tags.ts`, pure/sync for testability).
- Dropping the indexed `notes.content` field in `v2` was deliberate — IndexedDB enforces a per-key size limit that broke image-bearing saves.

### Backend (Postgres + R2 — cloud canonical source)

- **Auth**: Argon2id password hash, HMAC-signed HttpOnly session cookie (SameSite=Strict), rolling 30-day expiry, in-memory rate limiter.
- **Encryption**: Note content is AES-256-GCM encrypted server-side (`content_ct` + `content_nonce` columns). Title stays plaintext for fast tree rendering and ILIKE search.
- **Images**: Browser uploads directly to Cloudflare R2 via presigned PUT URL (bypasses backend → saves VPS bandwidth). Presigned GET URLs (10-min TTL) for rendering.
- **Sync**: `GET /api/sync/snapshot?since=<epoch_ms>` returns delta of notes + attachments. Client applies notes with higher `version` than local cache.
- **Optimistic locking**: `PATCH /api/notes/:id` with `If-Match: <version>` header → 409 Conflict on stale version.
- **Tree**: `parent_id` with recursive CTE (`WITH RECURSIVE descendants`) for subtree operations.

> 📋 See [`CLOUD_MIGRATION_PLAN.md`](./CLOUD_MIGRATION_PLAN.md) for the full 10-phase migration plan, security threat model, sync architecture, and progress tracker.

## 🌡️ Cloud Migration Progress

| Phase | Status | What |
|:---:|:---:|:---|
| 0 | ☑ Done | Monorepo restructure (`apps/{web,server}` + `packages/shared`) |
| 1 | ☑ Done | Backend skeleton (Hono + Drizzle + Docker Compose) |
| 2 | ☑ Done | Auth (Argon2id + HttpOnly cookie + rate-limit) |
| 3 | ☑ Done | Notes CRUD + AES-256-GCM encryption |
| 4 | ☑ Done | Image presigned R2 uploads |
| 5 | ☑ Done | Offline-first sync layer (Dexie v5 + drainer + conflict UX) 🔥 |
| 6 | ☑ Done | Postgres `tsvector` FTS (websearch_to_tsquery + ts_rank + GIN index) |
| 7 | ☑ Done | Backend Export/Import (`.treenote` v2 + R2 presigned PUT URLs) |
| 8 | ☑ Done | Onboarding Wizard (IndexedDB → cloud, re-entrant, App.tsx-gated) |
| 9 | ☑ Done | Production Prep (`Dockerfile`, `Caddyfile`, systemd unit, backup cron, `deploy.sh`) |
| 10 | ☑ Done | Hardening (`pino` JSON logs + cookie/auth redaction, `hono/body-limit` 5/150/1 MB tiered, strict CSP at Caddy, privacy-preserving observability via journald only) |

## ⚖️ License

No `LICENSE` file is checked in. Treat the source as **all-rights-reserved** by the author
until a license file is added. Please open an issue before forking or redistributing.

---

Made with care — keep your mind's garden tidy. 🌿
