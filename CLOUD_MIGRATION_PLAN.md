# 🗂️ Mindleaf Cloud Migration Plan

> Migrasi dari local-first (IndexedDB) ke cloud-backed (Postgres + Cloudflare R2 + VPS).
> Konteks keputusan user: **single-user, master password, server-side encryption**.

---

## 0. TL;DR (1-paragraph)

Backend **Node.js + Hono + Drizzle ORM + PostgreSQL**, dilayani via **Caddy** di depan VPS (auto-SSL). Auth via **HttpOnly cookie** yang ditandatangani oleh server-side session; password disimpan sebagai **Argon2id hash**. Enkripsi catatan pakai **AES-256-GCM single master key** dari environment variable (envelope encryption tidak dipakai karena *overkill* untuk single-user). Gambar di-upload **direct-to-R2** lewat **presigned URL** (tidak lewat backend, hemat bandwidth VPS). Backend full-text search via **Postgres `tsvector` + GIN** (server-side decryption memungkinkan ini). Migrasi IndexedDB lama dilakukan via **onboarding wizard** di-login pertama. Dev lokal pakai **Docker Compose** (Postgres + MinIO sebagai R2-mock), backend pakai `tsx --watch`, frontend Vite proxy ke backend.

---

## 1. Security Assessment (transparan)

Dengan pilihan **server-side encryption**, threat model jadi:

| Ancaman | Dilindungi? |
|---|---|
| Disk theft (snapshot DB bocor tanpa env var) | ✅ Ya |
| Network sniffing (TLS via Caddy) | ✅ Ya |
| Curious DBA / hosting provider | ✅ Tidak — server bisa plaintext |
| **Full VPS root compromise** (env var + DB keduanya jatuh) | ❌ **Tidak** |
| Browser XSS (Cookie HttpOnly + SameSite=Strict) | ✅ Ya |
| Password bocor (Argon2id + rate-limit) | ✅ Sebagian (mitigated) |

**Trade-off yang Anda terima**: server memegang kunci, sehingga riset/listing/search seluruhnya bisa dilakukan server-side. Konsekuensinya: VPS kompromi total = data bocor. Mitigasi nyata: OS hardening + firewall + SSH key only + non-root deploy + env-file permission 600 + pg_dump backup ke R2 terpisah.

> 💡 **Kalau nanti berubah pikiran** ke client-side E2E, plan ini jadi Levelled-up: kunci diturunkan dari password (Argon2id KDF → AES-GCM) di browser, server tak pernah melihat plaintext. Trade-off: kalau password hilang = data hilang, dan FTS backend harus pindah ke sesuatu seperti Tantivy+DEX (overkill). Saya bisa susun plan terpisah kalau mau.

---

## 2. High-Level Architecture

```
┌────────────────────────────────────────────────────────────────────┐
│ Browser (React 19 + TipTap + Zustand)                              │
│   ├─ LoginForm ── POST /auth/login ─┐                              │
│   ├─ Editor    ── tRPC/Hono-RPC ───┼──► Hono Backend (VPS)        │
│   ├─ TreeView  ── GET /notes, PATCH/┼──┐                           │
│   └─ Image upload ─ PUT presigned URL│  │                          │
│                                       │  │                          │
│                                       ▼  ▼                          │
│                              ┌──────────────────┐                   │
│                              │ Node.js + Hono   │                   │
│                              │   ├─ Auth mw     │                   │
│                              │   ├─ Crypto mw   │  (AES-256-GCM)    │
│                              │   ├─ Drizzle ORM │                   │
│                              │   └─ R2 client   │                   │
│                              └─────┬──────┬─────┘                   │
│                                    │      │                         │
│                       ┌────────────▼─┐  ┌─▼─────────────┐            │
│                       │ PostgreSQL   │  │ Cloudflare R2 │            │
│                       │ (VPS lokal)  │  │ (object store)│            │
│                       └──────────────┘  └───────────────┘            │
└────────────────────────────────────────────────────────────────────┘
```

User tidak pernah menyentuh Postgres/R2 langsung. Semua lewat Hono. Backend adalah choke-point untuk auth, rate-limit, search, encryption.

---

## 3. Tech Stack

| Layer | Pilihan | Rationale |
|---|---|---|
| Frontend | React 19 + Vite 6 + TipTap 3 (unchanged) | Tidak diubah |
| HTTP client + typing | **Hono RPC** (backend → frontend share types) | Zero manual DTO, refactor aman |
| Data fetching cache | **TanStack React Query** di frontend | Cache + invalidation + optimistic update |
| Backend runtime | **Node.js 22 LTS** (bukan Bun/Deno) | Ekosistem `pg`, `argon2`, `aws-sdk` paling stabil |
| Web framework | **Hono** | Modern, ringan, RPC bawaan, type-safe |
| ORM | **Drizzle ORM** | TS-first, SQL murni, tanpa engine background, ringan di VPS |
| Database | **PostgreSQL 16** | `tsvector` built-in, CTE untuk tree |
| Object storage | **Cloudflare R2** (S3-compatible) | Egress gratis (penting untuk screenshot banyak) |
| Migrations | **Drizzle Kit** | SQL-first, deterministic |
| Crypto | Node `crypto.subtle` (AES-256-GCM + Argon2id via `@node-rs/argon2` atau `argon2`) | Tidak ada native-binding fragile |
| Reverse proxy + TLS | **Caddy** | Auto-SSL Let's Encrypt, zero-config |
| Process manager | **systemd** untuk Docker, atau plain Docker Compose | Untuk single container cukup Compose |
| Backup | `pg_dump` cron harian → push ke R2 (`s3cmd`/`rclone`) | Self-contained, free egress |
| Local dev: Postgres | Docker Compose | Cepat, deterministic |
| Local dev: R2-mock | **MinIO** (S3-compatible) | Test presigned URL persis seperti R2 |
| Local dev: Hot reload | `tsx --watch` (backend) + Vite (frontend) | Standar |

---

## 4. Database Schema (Drizzle)

> Single-user berarti `users` punya tepat 1 baris, tapi schema tetap designed untuk safety.

```ts
// src/server/db/schema.ts (sketsa)
users                // 1 baris
  id: uuid PK
  password_hash: text                   // argon2id
  created_at: timestamptz
  updated_at: timestamptz

sessions
  id: uuid PK                          // cookie value (signed)
  user_id: uuid FK
  created_at: timestamptz
  expires_at: timestamptz               // rolling 30 hari
  ip_hash: text                        // optional, SHA-256 of req IP
  user_agent_hash: text                 // optional
  last_seen_at: timestamptz

notes
  id: uuid PK
  parent_id: uuid NULL FK→notes.id     // tree edges
  title: text                          // plaintext (untuk list/search cepat)
  content_ct: bytea                    // AES-256-GCM ciphertext
  content_nonce: bytea                 // 12 byte IV per note
  is_folder: boolean
  is_expanded: boolean
  order_idx: integer                   // drag-drop ordering (manual mode)
  tags: text[]                         // normalized kebab-case
  is_deleted: boolean                  // soft-delete (Trash)
  deleted_at: timestamptz NULL
  created_at: timestamptz
  updated_at: timestamptz
  -- index:
  --   INDEX (parent_id)
  --   INDEX (is_deleted, parent_id)
  --   GIN INDEX (tags)
  --   GIN INDEX (to_tsvector('simple', title || ' ' || plaintext_search))

attachments
  id: uuid PK
  note_id: uuid FK→notes.id ON DELETE CASCADE
  r2_key: text                         // e.g. "u/<user>/a/<uuid>.png"
  mime: text
  name: text
  size_bytes: integer
  created_at: timestamptz
  -- index:
  --   INDEX (note_id)
```

### Opsi: Plaintext Title untuk List Cepat

Saya simpan `title` plaintext (tidak dienkripsi) supaya:
- Sidebar/TreeView render tanpa dekripsi (responsif)
- Search seperti `WHERE title ILIKE '%...%'` jalan tanpa kriptografi

Trade-off: judul visible jika DB bocor tanpa env. Untuk content body tetap dienkripsi. Kalau Anda mau semua-di-enkripsi: tinggal pindah `title` ke kolom `title_ct` + `title_nonce` — TreeView load-nya jadi async per-node (lebih lambat tapi lebih aman). Saya tinggal swap di fase berikutnya.

### Tree Storage

Tidak pakai `ltree` extension — pakai `parent_id` rekursif + CTE. Reasoning:
- Schema identik dengan IndexedDB sekarang → migration gampang
- Drag-drop reorder = `UPDATE parent_id + order_idx` (1 query)
- Get subtree = `WITH RECURSIVE descendants AS (...)` (Postgres optimal untuk <10k node)
- Untuk ribuan note personal: tidak ada masalah performa

---

## 5. Auth Flow

```
Browser                                                  Backend
  │                                                         │
  ├─── POST /auth/login ───────────────────────────────►   │
  │    { password: "..." }                                  │
  │                                                         ▼
  │                                          Argon2id.verify(password, users.password_hash)
  │                                          Rate-limit per-IP (3 attempt / menit)
  │                                          Generate session_id = uuid()
  │                                          INSERT INTO sessions (id, user_id, expires_at=+30d)
  │                                          HMAC-sign(session_id, SECRET)  ← untuk防伪造?
  │                                                         │
  │◄── Set-Cookie: sid=<sig>.<id>; HttpOnly; Secure; ──── │
  │    SameSite=Strict; Path=/; Max-Age=2592000             │
```

**Session lookup** di middleware: parse cookie → verify HMAC → lookup `sessions` row → perpanjang `expires_at` kalau >50% sudah lewat (rolling).

**Cookie value = `<base64(hmac)>.<session_id>`** sehingga:
- Logout = `DELETE FROM sessions WHERE id = ?` + clear cookie
- Compromised session bisa di-revoke oleh user (opsional: tombol "Sign out all devices")
- Tidak perlu JWT — stateful lebih aman untuk single-user

`SECRET` dan `MASTER_ENCRYPTION_KEY` keduanya di **env file `/etc/mindleaf.env`** dengan permission `chmod 600`, owner non-root systemd service.

---

## 6. Encryption Layer

```ts
// src/server/crypto.ts (sketsa)
const KEY = Buffer.from(process.env.MASTER_ENCRYPTION_KEY!, 'base64'); // 32 byte
if (KEY.length !== 32) throw new Error('MASTER_ENCRYPTION_KEY must be 32 bytes');

export function encrypt(plaintext: string): { ct: Buffer; nonce: Buffer } {
  const nonce = crypto.randomBytes(12);
  const ct = Buffer.from(
    crypto.createCipheriv('aes-256-gcm', KEY, nonce).update(plaintext).final(),
  );
  // (sempurnakan dengan auth tag — saya rangkum di pseudo-code)
  return { ct, nonce };
}

export function decrypt(ct: Buffer, nonce: Buffer): string { /* ... */ }
```

Aturan operasional:
- `MASTER_ENCRYPTION_KEY` di-generate sekali via `openssl rand -base64 32` saat setup
- Generate key kedua (`MASTER_ENCRYPTION_KEY_PREVIOUS`) selama masa rotasi agar re-encrypt bisa zero-downtime (hanya untuk fase nanti — sekarang satu key cukup)
- Plaintext tidak pernah di-log
- Decryption error (key mismatch / corrupt) → return 500 + log; UI fallback "Note unavailable"

> Karena **judgement of plaintext** disimpan di server, saya sarankan **transparan kepada user**: Docker logs/R2 logs harus di-disable verbose mode; tidak boleh ada analytics pipeline yang nyedot konten.

---

## 7. Image Upload/Download (Cloudflare R2)

### Upload

```
Browser                                                  Backend
  │                                                         │
  ├─── POST /upload/presign ─────────────────────────────►  │
  │    { filename, mime, size, noteId }                      │
  │                                                  verify session
  │                                                  cek size limit (5 MB)
  │                                                  cek mime (image/*)
  │                                                  generate r2_key
  │                                                  INSERT attachment row
  │                                                  s3.getSignedUrl('PUT',
  │                                                      { Bucket, Key,
  │                                                        Expires: +5min })
  │◄── { uploadUrl, attachmentId, r2Key } ──────────────────┤
  │                                                         │
  ├─── PUT uploadUrl (image bytes) ─────────────────────────────────────► R2
  │                                                         │
  │◄── 200 OK ───────────────────────────────────────────────────────────────
  │                                                         │
  │   Editor: replace <img src=""> with                      │
  │            attachment:<attachmentId>                     │
  │            then POST /notes/:id (re-save)                │
```

### Render (di editor)

```
1. Editor load note → POST /notes/:id → backend returns plaintext
   (server rewrites each `attachment:<id>` to `https://cdn.r2.example/<key>?signed=...`
    dengan PUT-expired=+10min GET-URL).

2. Browser tag <img src="https://cdn.r2.example/...?signed=..."> renders.

3. Optional cache layer: 10 menit signed URL di-memory → tidak sign ulang setiap render.
```

### R2 Bucket Layout

```
mindleaf-prod/
  attachments/
    u/<user-short-id>/a/<uuid>.png      # note images
  backups/
    pg-dumps/
      2026-07-18.dump
      2026-07-19.dump
```

Bucket R2 pertama untuk app assets, bucket kedua untuk database backup (terpisah = kalau app bocor, backup masih aman).

### CORS R2

Karena browser upload langsung via presigned PUT, **R2 CORS harus di-set ke `https://your-mindleaf-domain.com`**. Config ini akan saya tulis `cors.json` di fase deploy.

---

## 8. API Surface (Hono RPC)

Sketsa endpoint (semua butuh session kecuali `/auth/login`):

```
POST   /auth/login                            { password }
POST   /auth/logout

GET    /me/info                               → { createdAt, noteCount }

GET    /notes                                 (tree, semua active)
GET    /notes/:id                             (single, decrypted)
POST   /notes                                 { parentId?, title?, isFolder? }
PATCH  /notes/:id                             { title?, content?, isExpanded?, orderIdx?, parentId?, tags? }
DELETE /notes/:id                             (soft → Trash)
POST   /notes/:id/restore
GET    /notes/trash

POST   /upload/presign                        { filename, mime, sizeBytes, noteId }
GET    /attachments/:id                       → 302 redirect to presigned GET (10-min TTL)

GET    /search?q=...                          → ranked list, server-side tsvector

POST   /export/full                           → streamed .treenote backup (notes + attachment metadata, blob di-fetch dari R2)
POST   /import/full                           ← FormData .treenote (untuk restore dari file)
```

### Rate Limiting

- `/auth/login`: 5 attempt per 15 menit per IP (prevent brute-force)
- `/upload/presign`: 30 per menit per session
- Lainnya: long enough untuk client biasa

Implementasi: **Redis-free** untuk simplicity — pakai in-memory token bucket. Single-user app tidak butuh Redis distributed rate-limit.

---

## 9. Sync Architecture (Offline-First dengan Local Cache)

IndexedDB **TIDAK dihapus** — dijadikan **primary local cache** (single-source-of-truth dari sudut pandang UI). Postgres jadi canonical source of truth untuk multi-device sync.

### 9.1 Prinsip Sync

- **Cache-first reads**: UI baca dari IndexedDB lewat Dexie; sync background menarik dari Postgres.
- **Optimistic mutations**: edit ditulis ke IndexedDB dulu, lalu push ke server via *pending queue* (offline-safe).
- **Version-based optimistic locking**: tiap note punya `version int` di server. PATCH pakai header `If-Match: <version>`; server reject stale → `409 Conflict` → client resolve via UI.
- **Delta sync**: pull hanya row yang `updated_at > lastSyncedAt`.
- **Last-writer-wins by `updated_at` server**: Postgres menang untuk konflik di level single-field. Untuk konflik yang adjacent (2 device offline edit note yang sama), pakai 409 + user choice.
- **Idempotent retry**: kalau push sukses tapi response gak sampai (network died), retry aman karena Postgres upsert by id content-deterministic.

### 9.2 Dexie Schema Update (v5)

Tabs `notes` dan `attachments` existing tetap (extended). Tambahan 2 tabel baru:

```ts
// apps/web/src/db/schema.ts (patched)
sync_state
  key TEXT PK
  value TEXT (JSON)
  --
  // rows:
  // 'lastSyncedAt'        → epoch ms of last successful delta pull
  // 'lastTreeSyncAt'      → epoch ms
  // 'deviceId'            → uuid v4 (for future device-specific conflict tracking)
  // 'migrationCompleted'  → bool

pending_mutations
  id TEXT PK                  // uuid v4 (client-generated)
  type TEXT                   // 'patch_note' | 'create_note' | 'delete_note'
                              //   | 'restore_note' | 'upload_attachment'
  resourceId TEXT             // note id atau attachment id
  payload TEXT (JSON)          // mutation body
  baseVersion INT NULL        // version untuk If-Match
  createdAt INT                // epoch ms
  attempts INT
  lastError TEXT NULL
  status TEXT                  // 'pending' | 'in_progress' | 'failed' | 'conflicted'

// extensions on existing tables:

notes (existing columns) +
  version INT                  // mirror dari server (untuk optimistic lock check)
  dirty BOOL                   // modified locally; belum sync
  lastSyncedAt INT             // epoch ms kapan row ini ditarik dari server

attachments (existing columns) +
  r2Key TEXT NULL              // setelah uploaded ke Cloudflare R2
  syncStatus TEXT              // 'local_only' | 'synced' | 'uploaded_server_unknown'
```

### 9.3 Sync Triggers

| Trigger | Aksi | Cadence |
|---|---|---|
| App mount | Pull delta | sekali |
| Window focus | Pull delta | debounced 5 detik |
| `navigator.onLine` event → true | Drain pending queue + pull delta | immediate |
| Mutation detected | Enqueue + push attempt | debounced 500ms |
| Periodic poll | Pull delta | setiap **60 detik** |
| Manual 'Sync now' | Drain + pull | user-triggered via sidebar |

**Periodic poll 60 detik** dipakai untuk menangkap perubahan dari device lain tanpa harus blur/focus. 60 detik dipilih karena ringan (1-7 KB delta tipikal, atau refresh full) namun cukupkan staleness untuk single-user.

**Cross-tab optimization**: pakai `BroadcastChannel` API supaya kalau ada 2 tab open, satu tab yang sukses sync memberi tahu tab lain → suppress duplicate pull dalam window waktu sama.

### 9.4 Delta Sync Protocol

Backend expose satu endpoint:

```
GET /api/sync/snapshot?since=<epoch_ms>
```

Response:
```json
{
  "serverNow": 1734567890000,
  "notes": [
    {
      "id": "uuid",
      "parentId": "uuid|null",
      "title": "...",
      "contentPlaintext": "...",
      "tags": ["..."],
      "isFolder": false,
      "isExpanded": true,
      "orderIdx": 1734567889000,
      "version": 12,
      "updatedAt": 1734567889000,
      "deletedAt": null
    }
  ],
  "attachments": [
    {
      "id": "uuid",
      "noteId": "uuid",
      "r2Key": "u/<user>/a/<uuid>.png",
      "mime": "image/png",
      "size": 12345,
      "name": "",
      "createdAt": 1734567889000
    }
  ]
}
```

Ukuran realistis: untuk 5000 notes + 1000 attachments ~1–5 MB per full pull. Acceptable untuk cadence 60 detik. V1 **tidak** pakai pagination/cursor — simplicity > cleverness.

**Client-side apply** (pseudo):
```ts
for (note of snapshot.notes) {
  const local = await db.notes.get(note.id);
  if (!local) {
    await db.notes.add({ ...note, dirty: false, lastSyncedAt: serverNow });
  } else if (note.version > local.version) {
    // Server newer → overwrite (user akan lihat toast kecil "Updated from server")
    await db.notes.update(note.id, { ...note, dirty: false, lastSyncedAt: serverNow });
  } else {
    // Local newer or same → SKIP (local edit akan di-push via pending queue)
  }
}
await db.sync_state.put({ key: 'lastSyncedAt', value: serverNow });
```

### 9.5 Optimistic Mutation & Pending Queue

Flow ketika user mengedit note di editor:

```
1. Editor.onUpdate fires → React Query mutation invoked
2. mutationFn:
   a. UPDATE db.notes SET dirty=true, version=local+1, updatedAt=now()
      WHERE id = <noteId>
   b. INSERT db.pending_mutations:
      { id: uuid, type: 'patch_note', resourceId: <noteId>,
        payload: JSON.stringify({ content, title?, tags?, ifMatch: <oldVersion> }),
        baseVersion: <oldVersion>,        // untuk If-Match header
        status: 'pending', createdAt: Date.now() }
   c. Notify sync drainer (event emitter)
3. Drainer picks up after debounce 500ms:
   a. UPDATE pending.status = 'in_progress'
   b. PATCH /api/notes/<id> with header If-Match: <baseVersion>
   c. Responses:
      - 200 OK:
        // body = { version, updatedAt }
        UPDATE db.notes SET version = response.version, dirty = false
        DELETE pending_mutation
      - 409 Conflict:
        // body = { remote: { ...fullNote } }
        UPDATE pending_mutation SET status = 'conflicted'
        trigger UI modal (Section 9.6)
      - network error / 5xx:
        INCREMENT attempts, status = 'failed'
        retry di next drain cycle (max 10) → kalau capai, status = 'abandoned'
        tampilkan ke user di Sync Status modal
4. Periodic poll independent: setiap 60s pull delta updates yang bypass
   pending queue entirely (untuk perubahan dari device lain).
```

**Idempotent retry safety**: PATCH yang retry akan kirim body content-same. Server `UPDATE notes SET content_ct=..., version=version+1` — kalau content sama, body aman (Postgres tidak complain). Yang penting: `version` di server selalu naik setiap write sukses — jadi kalau ada race, version tertinggi menang.

### 9.6 Conflict Resolution UX

Saat `pending_mutations.status = 'conflicted'`, user melihat modal:

```
┌─ Note "X" was updated elsewhere ──────────────────────────────┐
│ Remote (edited on device 'Laptop' 2 minutes ago):             │
│  ┌────────────────────────────────────────────────────┐      │
│  │ "I went to the store and bought milk and..."       │      │
│  │ ...                                                │      │
│  └────────────────────────────────────────────────────┘      │
│                                                             │
│ Your local (unsaved yet to cloud):                          │
│  ┌────────────────────────────────────────────────────┐      │
│  │ "I went to the store and bought oranges and..."   │      │
│  │ ...                                                │      │
│  └────────────────────────────────────────────────────┘      │
│                                                             │
│ [Use Remote]   [Keep Mine]   [Keep Both as Copy]   [Cancel] │
└─────────────────────────────────────────────────────────────┘
```

Baris behavior:

- **Use Remote**: pull latest via `GET /api/notes/:id`, overwrite local di IndexedDB (overwrite `content`, `version` = remote, `dirty=false`). Hapus pending_mutation.
- **Keep Mine**: re-PATCH dengan `If-Match: <remoteVersion>` — mine di-push on top. Drain normal.
- **Keep Both as Copy**: buat note baru title "X (conflict copy from <date>)" dengan content = local; revert local ke remote (Use Remote).
- **Cancel**: biarkan pending_mutation conflicted. User bisa resolve nanti di Sync Status modal.

UI cukup **200-char preview**: ekstrak text-content dari TipTap HTML (DOMParser + textContent), truncate 200 chars. Tidak pakai full-text diff library (overkill).

### 9.7 Attachment Sync

Attachment punya flow khusus karena involve R2 PUT langsung.

**Upload (lokal → R2)**:
```
1. compressImage(file) → blob
2. Generate local-only attachment row:
   { id: uuid, noteId, mime, size, blob, r2Key=null,
     syncStatus='local_only', createdAt: Date.now() }
3. Editor replace <img src=""> dengan attachment:<local-uuid>
4. INSERT pending_mutations type='upload_attachment'
5. Drainer:
   a. POST /api/upload/presign → server creates attachment row, return { presignedPutUrl, r2Key }
   b. PUT blob langsung ke R2 dengan presignedPutUrl
   c. POST /api/attachments/<id>/complete → server r2Key confirmed
   d. UPDATE db.attachments SET r2Key = response.r2Key, syncStatus='synced'
   e. DELETE pending_mutation
```

**Render (load note yang punya attachment ref)**:
```
1. ResizableImage.tsx NodeView resolve src:
   a. cek IndexedDB attachments table by id:
      - jika ada blob → pakai existing flow (URL.createObjectURL)
      - jika tidak ada (device baru / cache evicted) →
        GET /api/attachments/:id → server returns { r2Key, mime, presignedGetUrl }
        download via GET, simpan blob ke IndexedDB,
        emit blob URL → render
2. Only download per-device sekali per attachment id.
   Subsequent reloads pakai blob local (no R2 fetch).
```

HTML tetap pakai `attachment:<id>` ref, BUKAN signed URL — karena load HTML tidak boleh trigger R2 fetch (hemat egress). Hanya `<img>` NodeView yang punya lookup logic.

### 9.8 UI Sync Status Indicator

Top header right, traffic-light icon:

```
🟢 Synced       🟡 3 pending       🔴 Offline (2 pending)
```

Click icon → modal:

```
Sync status:
  Last sync:   47 seconds ago
  Pending:     3 mutations
  Connection:  Online
  Device ID:   <uuid-short>

  [Sync now]   [View pending]   [Sign out]
```

State-driven oleh:
- `useSyncStatus()` hook baca dari `db.sync_state` + `db.pending_mutations.count()` + `navigator.onLine`.
- Realtime via Dexie's `useLiveQuery` (existing pattern di TrashView, TreeView) — auto re-render when count berubah.

### 9.9 Encryption & Cache Policy

Karena **server-side encryption** (existing decision), cache local simpan **plaintext**:
- Server decrypt → kirim via HTTPS → browser simpan plaintext di IndexedDB.
- Trust boundary ada di OS device + screen lock.

Trade-off acknowledged:
- (+) Frontend simpel (TipTap load 0ms tanpa decryption step).
- (-) Laptop/HP yang dicuri saat unlocked = data ter-expose ke pencuri.

Mitigasi V1: edukasi user untuk selalu screen-lock. Post-V1 upgrade path: client-side E2E di cache (Argon2 KDF → AES-GCM per device) — membutuhkan password tiap reload app (UX cost). Untuk V1 kita keep plaintext.

### 9.10 Frontend ↔ Backend API Layer

Tidak menghapus Dexie dependency. Yang ditambahkan adalah bridge layer:

```ts
// apps/web/src/api/client.ts (Hono RPC untuk network ops)
import { hc } from 'hono/client';
import type { AppRouter } from '@mindleaf/shared/server';
export const api = hc<AppRouter>('/api', {
  headers: () => ({ Cookie: document.cookie }),
});
```

```ts
// apps/web/src/api/hooks.ts (sketsa — semua hooks baca LOCAL CACHE)
// Reads → IndexedDB
useNoteCache(id)            → useLiveQuery(() => db.notes.get(id))
useNotesCache()             → useLiveQuery(() => db.notes.where('deletedAt').equals(null).toArray())
useAttachmentsForNote(nid)  → useLiveQuery(() => db.attachments.where({ noteId: nid }).toArray())

// Mutations → enqueue + optimistic
useSaveNoteMutation()       → useMutation({ mutationFn: queue patch_note, onSuccess: invalidate })
useDeleteNoteMutation()     → useMutation({ mutationFn: queue delete_note })
useRestoreNoteMutation()    → useMutation(...)

// Background (sync engine)
useSyncDrain()              → internal — drives drainer
useSyncSnapshot(since)      → useQuery(['sync/snapshot', since], () => api.sync.snapshot.$get({ query: { since }}))
useSyncStatus()             → useLiveQuery(() => getSyncStatus())
```

**Konsep penting**: `useNoteCache(id)` BUKAN memanggil `GET /api/notes/:id` untuk dibuka user. Yang buka user adalah IndexedDB. Backend network call HANYA untuk sync background.

Ini berarti **zero loading skeleton** saat user navigate ke note manapun — semua sudah ada di IndexedDB (asalkan sudah pernah sinkron sebelumnya).

### 9.11 Helper Modules Tetap Pure

`tags.ts`, `tree-ops.ts`, `wikilink.ts` — interface existing tidak berubah. Mereka operate pada array `Note[]`. React Query layer cuma orchestrate local cache reads → helper functions.

### 9.12 Komunikasi Backend ↔ Frontend: Hono RPC + Shared Types

Mono-repo punya `packages/shared/` dengan TypeScript types yang sama dipakai backend (untuk Drizzle result typing) dan frontend (untuk API hooks typing). Setelah backend define di `apps/server/src/app.ts`, type diexpose via `export type AppRouter = typeof app`. Frontend import itu. Net result: tidak perlu OpenAPI spec atau DTO manual.

---

## 10. Local Dev Workflow

### Repo Layout Baru

```
mindleaf/
├── apps/
│   ├── web/                  # frontend (existing src/* → renames ke apps/web/src/*)
│   └── server/               # backend (NEW)
│       ├── src/
│       │   ├── app.ts        # Hono entry
│       │   ├── db/
│       │   │   └── schema.ts # Drizzle
│       │   ├── routes/
│       │   │   ├── auth.ts
│       │   │   ├── notes.ts
│       │   │   ├── upload.ts
│       │   │   └── search.ts
│       │   ├── middleware/
│       │   │   ├── auth.ts
│       │   │   └── ratelimit.ts
│       │   └── crypto.ts
│       ├── drizzle.config.ts
│       └── package.json
├── package.json              # workspaces
└── docker-compose.yml        # postgres + minio untuk dev
```

### `docker-compose.yml` (dev)

```yaml
services:
  postgres:
    image: postgres:16-alpine
    environment:
      POSTGRES_DB: mindleaf
      POSTGRES_USER: mindleaf
      POSTGRES_PASSWORD: devpw
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]
  minio:
    image: minio/minio
    command: server /data --console-address ":9001"
    environment:
      MINIO_ROOT_USER: mindleaf
      MINIO_ROOT_PASSWORD: devpw
    ports: ["9000:9000", "9001:9001"]
    volumes: ["minodata:/data"]
volumes:
  pgdata:
  minodata:
```

### Frontend `.env.local`

```
VITE_API_URL=http://localhost:8787
```

### Backend `.env.local`

```
DATABASE_URL=postgres://mindleaf:devpw@localhost:5432/mindleaf
SESSION_SECRET=<openssl rand -base64 32>
MASTER_ENCRYPTION_KEY=<openssl rand -base64 32>
R2_ENDPOINT=http://localhost:9000        # MinIO S3-compatible
R2_ACCESS_KEY=mindleaf
R2_SECRET_KEY=devpw
R2_BUCKET=mindleaf-dev
PORT=8787
```

### Cara Kerja Sehari-hari

```bash
# Terminal 1
docker compose up -d
cd apps/server && npm run db:push        # apply Drizzle migrations
cd apps/server && npm run dev            # tsx --watch di port 8787

# Terminal 2
cd apps/web && npm run dev               # Vite di port 3000, proxy /api → 8787
```

---

## 11. VPS Deployment

### Provisioning (satu kali saat setup VPS)

```bash
# Asumsi Ubuntu 24.04 LTS
sudo apt update && sudo apt install -y docker.io docker-compose-plugin caddy
sudo systemctl enable --now docker caddy

# Buat deploy user (non-root)
sudo useradd -m -s /bin/bash mindleaf
sudo mkdir -p /opt/mindleaf && sudo chown mindleaf:mindleaf /opt/mindleaf

# Generate secrets
openssl rand -base64 32 > MASTER_ENCRYPTION_KEY
openssl rand -base64 32 > SESSION_SECRET
```

Note: Postgres **tidak di-container** di prod — install langsung via `apt install postgresql-16` untuk durability & backup yang lebih reliable. Container di prod: hanya backend Hono.

### `/opt/mindleaf/.env` (deploy env)

```
DATABASE_URL=postgres://mindleaf:<password>@localhost:5432/mindleaf
SESSION_SECRET=<...>
MASTER_ENCRYPTION_KEY=<...>
R2_ENDPOINT=https://<accountid>.r2.cloudflarestorage.com
R2_ACCESS_KEY=<...>
R2_SECRET_KEY=<...>
R2_BUCKET=mindleaf-prod
ALLOWED_ORIGIN=https://mindleaf.example.com
```

`chmod 600 /opt/mindleaf/.env`, owner `mindleaf:www-data`.

### Reverse Proxy (Caddy)

```
mindleaf.example.com {
  reverse_proxy localhost:8787
}
```

Caddy otomatis request sertifikat Let's Encrypt. **Tidak perlu certbot**.

### Domain Setup

- Beli domain (Cloudflare Registrar / Namecheap / dll)
- A record → IP VPS
- Caddy handle sisanya

### Backup (cron)

```
# /etc/cron.d/mindleaf-backup
0 3 * * *  mindleaf  pg_dump -Fc mindleaf > /tmp/mindleaf.dump && rclone copy /tmp/mindleaf.dump r2:mindleaf-prod-backups/db/$(date +\%F).dump && rm /tmp/mindleaf.dump
```

### systemd Unit (backend)

```ini
# /etc/systemd/system/mindleaf.service
[Unit]
Description=Mindleaf backend
After=network.target postgresql.service
[Service]
User=mindleaf
WorkingDirectory=/opt/mindleaf
EnvironmentFile=/opt/mindleaf/.env
ExecStart=/usr/bin/node /opt/mindleaf/dist/server.js
Restart=on-failure
[Install]
WantedBy=multi-user.target
```

### Healthcheck

Backend expose `GET /healthz` → return `{ ok: true }`. Tambah Caddy check if non-200.

---

## 12. Migration dari IndexedDB Lama

**Trigger**: User pertama kali login ke cloud → backend detect via GET `/me/info` → jika `noteCount == 0` tapi IndexedDB lokal ada notes → tampilkan onboarding modal:

```
┌─ WELCOME TO MINDLEAF CLOUD ────────────────────┐
│ Welcome back. We found 142 notes & 38 images   │
│ in your local browser storage.                 │
│                                                │
│ [Upload everything to cloud]  [Start fresh]    │
└────────────────────────────────────────────────┘
```

- **Upload everything**: loop baca `db.notes.toArray()`, POST satu per satu ke `/notes` (UUID tetap dipakai di kedua sisi, jadi tidak perlu re-map). Parallel batch 10. Lalu baca `db.attachments.toArray()`, untuk setiap blob: `POST /upload/presign` → `PUT` ke presigned URL → `POST /complete`. **TIDAK menghapus IndexedDB setelah upload selesai** — IndexedDB jadi cache permanen untuk offline-first. Update semua row agar `dirty=false` dan `version` mirror dari server. Toast: "Done. 142 notes & 38 images synced. You can now close this tab anytime." Bahkan kalau user langsung tutup tab, server sudah punya datanya karena bulk POST selesai sebelum toast muncul.
- **Start fresh**: skip wizard; langsung drop IndexedDB (kalau ada, biar bersih) dan biarkan sync layer menarik delta dari server (kosong jika server baru).

Triggers ini ada di `Sidebar.tsx` baru, hanya muncul jika `noteCount == 0`. Re-entrant: kalau gagal di tengah, bisa "Resume" karena ID notes sudah stable.

### Catatan Penting

- ID notes **tetap UUIDv4** di kedua sisi. Klien generate, server terima verbatim. Tree struktur intact karena `parent_id` kami juga pakai UUID.
- Tags array **tetap normalized kebab-case**: `normalizeTag()` masih dipakai.
- `wikilink_id` (UUID) aman dipakai ulang karena sudah pakai uuidv4 — tidak ada collision.

---

## 13. Implementation Phases

Implementasi dieksekusi dalam urutan ini. Setiap phase punya exit criteria — **jangan lanjut kalau exit criteria belum terpenuhi**.

### Phase 0 — Repo Restructure (½ hari)
- Setup monorepo (`apps/web`, `apps/server`)
- Shared types di `packages/shared` (Note, Attachment, dll)
- `npm workspaces` aktif
- **Exit**: `npm run dev` di root menjalankan frontend + backend bersamaan

### Phase 1 — Backend Skeleton + Postgres (1 hari)
- `apps/server` Hono app dengan `/healthz`
- Docker Compose dev (postgres + minio)
- Drizzle schema + initial migration
- **Exit**: `curl http://localhost:8787/healthz` → `{ ok: true }`, Drizzle Studio bisa connect

### Phase 2 — Auth (½ hari)
- POST `/auth/login` parsing Argon2 hash, set HttpOnly cookie
- Session middleware memvalidasi cookie, fetch dari DB, refresh `expires_at`
- `secureHeaders()` Hono middleware
- Rate limit di `/auth/login`
- **Exit**: `curl -X POST http://localhost:8787/auth/login -d '{"password":"..."}'` with seeded user → 200 + Set-Cookie valid

### Phase 3 — Notes CRUD + AES-256-GCM (1–2 hari)
- AES-GCM helpers di `apps/server/src/crypto.ts`
- GET/POST/PATCH/DELETE/Restore notes (all encrypted)
- Tree query via recursive CTE
- **Exit**: e2e test — login → create folder → create note → patch note → restore dari trash; raw DB inspect pakai `psql` menunjukkan `content_ct` bytea bukan plaintext

### Phase 4 — Image Presigned R2 (1 hari)
- POST `/upload/presign` → S3 client `getSignedUrl('PUT', ...)`
- Browser upload via `fc.upload` pattern (di mock via curl di test)
- Note GET rewrites `attachment:<id>` → presigned GET URL
- **Exit**: upload PNG kecil via MinIO console verify → fetched via signed URL → gambar kebuka di `<img src>`

### Phase 5 — Offline-First Sync Layer (2–3 hari) 🔥 **phasa terbesar**

Tidak menghapus Dexie. Sebaliknya, **memperluas** Dexie jadi local cache + sync queue.

- Patch `src/db/db.ts` schema ke **v5**: tambah tabel `sync_state`, `pending_mutations`; tambah kolom `version, dirty, lastSyncedAt` di `notes`; tambah kolom `r2Key, syncStatus` di `attachments`. Migrasi via Dexie upgrade hook (sama pola dengan v1→v4 existing).
- Buat `apps/web/src/sync/` directory:
  - `drainer.ts` — worker process periodic, drain `pending_mutations` in order
  - `pull.ts` — delta-sync `GET /api/sync/snapshot?since=lastSyncedAt`
  - `push.ts` — PATCH with `If-Match: baseVersion`, retry policy (max 10)
  - `attachments-sync.ts` — presigned upload PUT + blob cache fetch on miss
  - `conflict.ts` — 409 handler, modal trigger
- Buat `apps/web/src/api/` module:
  - `client.ts` (Hono RPC untuk network ops)
  - `hooks.ts` (`useNoteCache`, `useSaveNoteMutation`, `useSyncStatus`, dll)
- Update existing components agar baca dari local cache + queue mutation:
  - `src/components/Editor.tsx` (saveNote → mutation; onUpdate → optimistic + queue)
  - `src/components/TreeView.tsx` (`useLiveQuery(db.notes)` tidak berubah, sudah pakai local)
  - `src/components/Sidebar.tsx` (createRootNote → mutation; export → backend endpoint)
  - `src/components/TrashView.tsx` (delete/restore → mutation)
  - `src/extensions/ResizableImage.tsx` (resolveImageSrc → fetch signed URL on miss)
- Sync engine mount di `App.tsx` root:
  - Trigger pull on mount, focus, online event
  - Periodic poll 60 detik via `setInterval`
  - Drainer loop 5 detik sekali (atau event-driven jika pakai EventEmitter)
- `packages/shared/` — TypeScript types shared antara backend Drizzle result & frontend API hook typing
- **Exit criteria**:
  - Cold-start of app dengan backend offline + notes di IndexedDB → app berfungsi penuh (read note, edit, antri mutation di IndexedDB)
  - Reconnect → drain queue otomatis + delta pull → row `dirty=false` dan version mirror server (verify via `SELECT version FROM notes` di Postgres)
  - `grep -r 'db\.notes\.\(put\|update\|delete\)' apps/web/src/` SEMUA dibungkus lewat sync queue (tidak ada write langsung ke IndexedDB tanpa through queue)

### Phase 6 — Search (½ hari)
- Trigger untuk `to_tsvector('simple', title || ' ' || extract_plaintext(content))` di PATCH note
- GIN index pada kolom ini
- GET `/search?q=` dengan ranking + limit
- Frontend `useSearch(q)` debounced 200ms
- **Exit**: search works, hasil ranking reasonable

### Phase 7 — Export/Import (½ hari)
- POST `/export/full` tradisionalnya — server stream JSON, fetch R2 attachments parallel, inline base64
- POST `/import/full` symmetric, push attachments back via presigned PUT
- Sidebar tombol tetap UX sama

### Phase 8 — Onboarding Wizard (½ hari)
- Detection banner: local IndexedDB ada data? tampilkan modal upload
- Bulk upload via batch POSTs dengan progress
- Setelah sukses: `indexedDB.deleteDatabase('TreeNoteDB')`

### Phase 9 — Production Prep (1 hari)
- Dockerfile untuk backend (multi-stage, Node 22 alpine)
- Caddyfile
- systemd unit
- Backup cron + rclone config
- Deploy script `deploy.sh`
- **Exit**: build jalan di VPS via SSH manual

### Phase 10 — Harden (½ hari)
- Hono `secureHeaders()` middleware
- Rate limiting difinalisasi
- 5xx logging (pino + redact path untuk hindari leak plaintext)
- CORS strict: hanya `ALLOWED_ORIGIN`
- HTTPS di dev (Vite proxy sudah cukup, prod Caddy)
- **Exit**: penetration test mental pass — XSS reflected, CSRF, brute-force, file upload abuse, R2 URL leak

**Total perkiraan effort**: ~9–12 hari kerja single-developer (sebagian bisa paralel).

---

## 14. Open TBDs (saat implementasi nanti, Anda bisa override)

| # | Decision | Default yang saya pilih | Alternatif |
|---|---|---|---|
| 1 | Apakah **title** dienkripsi juga? | Plaintext (responsiveness) | Enkripsi penuh + async-load tree |
| 2 | Apakah `master_key_version` disimpan per catatan (untuk rotation later)? | Tidak dulu | Tambahkan `key_version int` di notes |
| 3 | Backup retention | 30 hari di R2, lalu rclone delete old | Forever / manual prune |
| 4 | Untuk single-user, butuh multi-device login? | Ya, simple cookie | Hardening: allowlist device fingerprint |
| 5 | Apakah folder **children counts** di-load eager atau lazily? | Eager saat sidebar render | Lazy via collapsed-marker |
| 6 | Apakah ada "export ke static HTML" untuk backup portability sisi user? | Tidak dulu | Tambah di fase berikutnya |
| 7 | Tips UX: 2FA dengan TOTP? | Tidak untuk V1 | Pertimbangkan setelah stabil |
| 8 | Apakah wikilink (`[[Note]]`) auto-mendeteksi broken links di server? | Tidak | Tambah background job |
| 9 | Apakah tags **distinct list** di-cache? | Tidak (live query) | Pre-compute di server |
| 10 | Apakah komentar node `isFolder = true` + children-count di-collapse? | Eager children query saat sidebar open | Lazy fetch on click |
| 11 | Default behavior untuk conflict modal jika user tidak memilih (modal stays open sampai dipilih) | Tunda response; pending_mutation tetap 'conflicted' sampai user resolve | Auto-resolve pakai `updatedAt` server (LWW); hanya untuk friendly UX |
| 12 | Periodic poll interval (cadence delta pull background) | 60 detik | 30 detik (lebih fresh tapi lebih request) / 120 detik (lebih hemat) / hanya on-focus event |
| 13 | Blob cache size limit (IndexedDB per-origin ~50MB-ish di banyak browser Chrome/Firefox) | LRU evict blob tidak diakses 30 hari | Reject upload baru dengan pesan "Cache penuh, hapus gambar lama" |
| 14 | BroadcastChannel cross-tab synchronization | Aktif (suppress duplicate pull dalam 2 tab) | Disabled (independent tabs boleh sync sendiri-sendiri) |
| 15 | Apakah cache IndexedDB di-encrypt jika device hilang tanpa lock-screen (post-V1 upgrade) | Plaintext (V1) — trust pada OS lock screen | Client-side E2E cached (Argon2 KDF per-device → AES-GCM; butuh password tiap reload app) |

---

## 15. Risiko yang Saya Sudah Identifikasi Awal

1. **TipTap ↔ plain HTML serialization**: TipTap menyimpan `<span data-wikilink-id="…">` di `content_encrypted`. Enkripsi char-by-char HTML aman tapi **jangan pernah treat TipTap output sebagai SQL-escaped plaintext**. Solusi: Drizzle param binding (sudah built-in) + decrypt ke memory → parse aman dengan DOMParser (sudah dipakai di existing code).

2. **TipTap NodeView timing race**: existing code sudah solved oleh `key={activeNoteId}`. Backend version masih perlu mirip: agar React Query invalidation waktu save tidak flicker editor.

3. **R2 quota & cost**: gambar kecil = ribuan objects. R2 free tier 10M reads/month, 1000 writes/month — mungkin kena overage kalau ribuan uploads. Saya rekomendasikan **watch quota + pre-compress aggressively di frontend** (sudah ada `compressImage()`).

4. **Cookie CORS**: Vite dev pakai port 3000, backend port 8787. Solusi: Vite proxy `/api` ke 8787 (cookie HttpOnly otomatis forwarded). Untuk prod cukup Caddy serve frontend static + reverse `/api`.

5. **Deployment `git pull` + restart**: tidak boleh downtime. Solusi: gunakan `systemd` dengan `ExecStartPre` ambil image/build, dan restart bisa zero-downtime via `kill -HUP` atau pakai Node ecosystem `pm2`. Untuk single-user app cukup restart dengan 5–10 detik downtime.

6. **Postgres password rotation**: pakai `~/.pgpass` di `/opt/mindleaf/` untuk cron backup, tidak bisa input interactive.

7. **Argon2 CPU cost di login**: gunakan `@node-rs/argon2` (Rust binding) untuk 1ms hash di VPS 1-core.

8. **Local cache staleness**: dengan periodic poll 60 detik, max staleness dari perubahan di device lain = 60 detik. Jika user butuh lebih real-time, alternatif: aktifkan `BroadcastChannel` listen jika ada device yang mengumumkan perubahan, atau pakai WebSocket (extra infra). Untuk V1 cukup 60 detik — user-noted UX akan terasa "near-instant" karena background pull tidak mengganggu UI.

9. **Pending queue bloat saat offline lama**: jika offline 1 minggu dan ada 200 mutations queue, reconnect → drainer akan push 200 PATCH satu per satu (~2-5 detik total assuming 50ms latency). Bisa terlihat "loading" sebentar. Mitigasi: backend support batch endpoint `POST /api/sync/batch` dengan array of mutations. Untuk V1, sequential acceptable; upgrade ke batch jika front-end terasa lambat.

10. **Conflict UX butuh user介入**: 99% kasus single-user tidak akan conflict. Saat muncul (edit note yang sama di 2 device tanpa sync window), modal stays open sampai user memilih. UX risk: user lupa modal dan bingung kenapa data tidak sync. Mitigasi: top header sync indicator akan menunjukkan "🟡 1 conflicted" dengan count, selalu visible. User diarahkan klik via header icon → Sync Status modal → list conflicted mutations.

11. **IndexedDB size limit per-origin**: banyak browser (Chrome, Firefox, Safari) punya quota per-origin ~50MB-1GB tergantung device. Gambar kecil (screenshots <50KB) × 5000 images = ~250MB. Bisa kena quota. Mitigasi: TBD #13 (LRU evict) atau tambah `navigator.storage.estimate()` check sebelum upload dan tolak jika akan exceed.

12. **R2 signed URL leak via browser history**: GET presigned URL untuk download image akan masuk history. Mitigasi: signed URL TTL singkat (10 menit), URL tidak reusable setelah expired. Tidak masalah security-wise karena attacker yang punya access ke browser history kemungkinan besar juga punya access ke cookie (same threat model).

---

## 16. Yang **TIDAK** akan dilakukan

- ✅ **IndexedDB tetap dipakai sebagai local cache permanen** — bukan "akan dihapus bertahap". Schema di-extend ke v5 dengan tabel `sync_state` + `pending_mutations` dan kolom `version/dirty/lastSyncedAt` di notes. Cache serving sebagai single-source-of-truth dari sudut pandang UI
- ❌ Tidak ubah UX (sidebar/tree/editor tetap familiar)
- ❌ Tidak ganti TipTap
- ❌ Tidak pakai WebSocket / realtime sync V1
- ❌ Tidak tambah GUI `pg_dump` restore di app (overkill)
- ❌ Tidak pakai HSM/KMS di VPS (overkill untuk single-user; env file 600 cukup)

---

## Catatan Akhir

### ✅ Phase 0–4 Selesai (2026-07-23)

Phase 0–4 telah diimplementasikan dan diverifikasi:

- **Typecheck**: backend (`apps/server`) dan frontend (`apps/web`) keduanya lolos `tsc --noEmit` tanpa error.
- **Tests**: 277/277 frontend tests pass (tidak ada yang rusak dari repo restructure).
- **Code review**: semua masalah kritis diperbaiki — circular imports (AppEnv di-extract ke `env.ts`), SQL injection (parameterized queries via postgres-js + Drizzle `inArray`), dead code (`constants.ts` dihapus, dead imports dibersihkan), type safety (Hono `<AppEnv>` generic untuk `c.set/get('userId')`), error handling (`app.onError` central handler), dan validasi input (`sync.ts` `since` parameter).

**File backend yang dibuat**:

| File | Fungsi |
|---|---|
| `apps/server/src/index.ts` | Hono entry — route mounting, `/healthz`, `/api/me/info`, `onError` handler |
| `apps/server/src/env.ts` | `AppEnv` type (Hono Variables: `userId`) — di-extract untuk hindari circular import |
| `apps/server/src/crypto.ts` | AES-256-GCM `encrypt()` / `decrypt()` (12-byte nonce, 16-byte auth tag) |
| `apps/server/src/r2.ts` | S3Client untuk R2/MinIO + `presignPut()` / `presignGet()` + `generateR2Key()` |
| `apps/server/src/db/schema.ts` | Drizzle schema: `users`, `sessions`, `notes` (customType `bytea`, self-ref FK), `attachments` |
| `apps/server/src/db/index.ts` | postgres-js + Drizzle instance (`db` + `pgClient` export) |
| `apps/server/src/middleware/auth.ts` | Session middleware — HMAC-signed cookie, `timingSafeEqual`, rolling 30-day expiry |
| `apps/server/src/middleware/ratelimit.ts` | In-memory token-bucket rate limiter (Redis-free) |
| `apps/server/src/routes/auth.ts` | `POST /login` (Argon2id verify + cookie), `POST /logout`, `POST /setup` (rate-limited) |
| `apps/server/src/routes/notes.ts` | CRUD + recursive CTE descendants + `If-Match` optimistic locking (409 Conflict) |
| `apps/server/src/routes/upload.ts` | `POST /presign` (mime/size validation), `GET /attachments/:id`, `POST /complete` |
| `apps/server/src/routes/search.ts` | ILIKE title search (FTS tsvector deferred to Phase 6) |
| `apps/server/src/routes/sync.ts` | `GET /snapshot?since=` delta sync (notes + attachments, decrypted) |
| `apps/server/src/seed.ts` | Interactive user creation script (Argon2id hash) |

**Keputusan TBD yang diambil**:
- TBD #1 (title encryption): **Plaintext** — sesuai default plan, untuk responsiveness tree + ILIKE search.
- TBD #2 (key version per note): **Tidak** — single master key, rotasi belum dibutuhkan.

### ✅ Phase 5 Selesai (2026-07-23)

Phase 5 — Offline-First Sync Layer — telah diimplementasikan dan diverifikasi:

- **Typecheck**: `apps/web` lolos `tsc --noEmit` tanpa error.
- **Tests**: 277/277 frontend tests pass.
- **Code review**: 2 round review, semua masalah diperbaiki — circular imports (drainer→queue→drainer dipecah dengan shouldSync langsung dari api/client), dead ternary, missing dirty-flag lifecycle (delete/restore sekarang clear dirty di semua descendant setelah push sukses), emptyTrash tidak sync (dipindahkan ke queue), import tidak sync (queuedImportNotes dengan transaction + skip already-synced), 404 permanent-delete treated as success, 401 session-expiry detection.

**File sync layer yang dibuat**:

| File | Fungsi |
|---|---|
| `apps/web/src/api/client.ts` | Fetch-based API client untuk Hono backend (auth, notes CRUD, upload, sync, search). `shouldSync()` + `hasSession()` + 401 detection |
| `apps/web/src/sync/queue.ts` | Sync queue: optimistic local writes + enqueue pending mutations. `queuedCreateNote`, `queuedPatchNote`, `queuedDeleteNote`, `queuedRestoreNote`, `queuedPermanentDeleteNote`, `queuedImportNotes`, `queuedAddAttachment`, `applyServerNote`, `applyServerAttachment`, sync state helpers |
| `apps/web/src/sync/pull.ts` | Delta-sync pull: `GET /api/sync/snapshot?since=`, apply ke IndexedDB cache (skip dirty rows) |
| `apps/web/src/sync/push.ts` | Push single mutation ke backend: handles 200/409/error, clear dirty setelah delete/restore cascade, 404 permanent-delete = success, attachment upload (presign→PUT→complete) |
| `apps/web/src/sync/conflict.ts` | Conflict resolution: `useRemote`, `keepMine`, `keepBoth` |
| `apps/web/src/sync/drainer.ts` | Background worker: processes `pending_mutations` in FIFO order, 5s interval, event-driven via `notifyDrainer`, retry policy (max 10 attempts) |
| `apps/web/src/sync/useSyncEngine.ts` | React hook: mounts drainer + periodic pull (60s) + focus/online event listeners. Self-gates on `shouldSync()` |
| `apps/web/src/sync/useSyncStatus.ts` | React hook: `useLiveQuery` untuk sync status indicator (pending count, conflicted count, online status) |

**File yang dimodifikasi**:

| File | Perubahan |
|---|---|
| `apps/web/src/types.ts` | Added sync fields: `Note.version`, `Note.dirty`, `Note.lastSyncedAt`; `Attachment.r2Key`, `Attachment.syncStatus` |
| `apps/web/src/db/db.ts` | Dexie v5 schema: `pendingMutations` + `syncState` tables, extended indexes (dirty, lastSyncedAt on notes; r2Key, syncStatus on attachments) |
| `apps/web/src/lib/notes.ts` | All write functions route through sync queue (createRootNote, createChildNote, softDeleteNote, restoreNote, renameNote, permanentlyDeleteNote, emptyTrash). `emptyTrash` rewritten to enqueue permanent_delete_note per root trashed subtree |
| `apps/web/src/components/Editor.tsx` | `saveNote` → `queuedPatchNote`, attachment add → `queuedAddAttachment` |
| `apps/web/src/components/TreeView.tsx` | Move/reorder → `queuedPatchNote`, expand/collapse → `queuedPatchNote` |
| `apps/web/src/components/Sidebar.tsx` | Import → `queuedImportNotes` (with Dexie transaction), toggle expand all → `queuedPatchNote` |
| `apps/web/src/components/TrashView.tsx` | Restore/purge → `restoreNote`/`permanentlyDeleteNote` (already routed through queue) |
| `apps/web/src/extensions/ResizableImage.tsx` | R2 cache-miss fetch via presigned GET URL on attachment blob miss |
| `apps/web/src/App.tsx` | Mounts `useSyncEngine()` hook + sync status indicator UI |
| `apps/web/src/test/db.test.ts` | Updated index name assertions for v5 schema |
| `apps/web/src/test/notes.test.ts` | Updated to accommodate sync fields (`version`, `dirty`) in created notes |

**Keputusan TBD yang diambil di Phase 5**:
- TBD #11 (conflict modal behavior): **Tunda response** — pending_mutation tetap `conflicted` sampai user resolve via UI.
- TBD #12 (poll interval): **60 detik** — sesuai default plan.
- TBD #14 (BroadcastChannel): **Belum diimplementasikan** — deferred ke post-V1, 2-tab sync sudah berfungsi tanpa BroadcastChannel (independent pulls).
- TBD #13 (blob cache LRU): **Belum diimplementasikan** — deferred ke post-V1.

### ✅ Phase 10: Selesai (2026-07-23)

Phase 10 (Harden) dan seluruh cloud migration plan telah selesai dan diverifikasi:

- **Typecheck**: `apps/server` dan `apps/web` keduanya lolos `tsc --noEmit` tanpa error.
- **Tests**: 294/294 frontend tests pass.
- **Code review**: multiple rounds across phase 6+7+8+9+10. Issues resolved sbb:

**Phase 10 deliverables**

- **Pino structured access logs**: `apps/server/src/middleware/logger.ts` (NEW) replaces `hono/logger` dengan JSON output prod, pino-pretty dev. Log redact path: `req.headers.cookie`, `req.headers.authorization`, `res.headers["set-cookie"]`, plus `*.sessionId|*.password|*.passwordHash`. Per-request `requestId` propagates ke child loggers; userId + IP (+X-Forwarded-For) attached post-session-middleware.
- **Belle body-size limit layered**:
  - `apps/server/src/middleware/body-limit.ts` (NEW) re-export `hono/body-limit` (built-in, bukan separate package on npm — that one doesn't exist) dengan named byte constants `DEFAULT_API_BYTES = 5 MB`, `BACKUP_IMPORT_BYTES = 150 MB`, `UPLOAD_PRESIGN_BYTES = 1 MB`.
  - Global 5 MB middleware mounted at `apps/server/src/index.ts` untuk auth/CRUD default. 150 MB per-route override di `apps/server/src/routes/backup.ts` (`/import/full`). 1 MB per-route override di `apps/server/src/routes/upload.ts` (`/presign`). Stream-based chunk counter (bukan Content-Length examination) sehingga malicious upload ditolak tanpa buffering ke RAM. 413 response.
  - Backup export cap (150 MB inline base64 ≈ 110 MB binary) tetap dipertahankan di handler `apps/server/src/routes/backup.ts` (`MAX_EXPORT_TOTAL_BYTES`).
- **Hardened CSP + HSTS** di `deploy/Caddyfile`: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: https://*.r2.cloudflarestorage.com; font-src 'self' data:; connect-src 'self' https://*.r2.cloudflarestorage.com; frame-ancestors 'none'; object-src 'none'; base-uri 'self'; form-action 'self'; upgrade-insecure-requests`. HSTS `max-age=31536000; includeSubDomains`. Defense-in-depth: Hono `secureHeaders` masih On (x-frame-options DENY, nosniff) untuk API responses; Caddy layer memperkuat untuk SPA responses. Tidak ada double-header conflict.
- **Privacy-preserving analytics-free observability**: ZERO 3rd party (no Sentry/Datadog/PostHog). Strategy: `node` log JSON to stdout → `systemd` `StandardOutput=journal` + `journalctl -u mindleaf.service -o cat | jq`. Weekly healthcheck via cron curl `/healthz`. Tidak ada telemetry, tidak ada error reporter, tidak ada CDN analytics.
- **Production env**: `apps/server/.env.production.example` ditambah `LOG_LEVEL=info` (preset).
- **Deps added**: `pino@^9.5.0`, `pino-pretty@^11.3.0` (dev-only transport).

**Phase 9 deliverables** (untuk context)

- Dockerfile multi-stage Node 22 bookworm-slim dengan HEALTHCHECK via `/healthz`, USER node non-root.
- systemd unit hardened: NoNewPrivileges, ProtectSystem=strict, RestrictAddressFamilies, RestrictNamespaces, CapabilityBoundingSet=, MemoryDeny* (false untuk V8 JIT).
- Caddyfile dengan SPA fallback + security headers + reverse-proxy upstream health checks (`health_path /healthz`).
- backup.sh idempotent: flock + pg_dump -Fc + rclone copyto dated-filename + 30-day retention sweep.
- bootstrap.sh one-time VPS provisioning (apt postgresql-16 + caddy + rclone, mindleaf user, .env 0600, postgres role + .pgpass, db:push).
- cron 03:00 UTC daily (`deploy/cron.d/mindleaf-backup`).
- deploy.sh VPS-local dengan --dry-run + --rollback (dist.bak snapshot sebelum overwrite + auto-rollback pada healthcheck fail). Tidak memakai SSH/remote rsync; default tidak melakukan git pull. Pre-flight passwordless sudo check untuk fail-fast.
- Caddy validate + reload (zero-downtime).

**Penetration-test mental pass**: ✅

- XSS reflected: Content-Security-Policy blok. Tailwind utility class injection pads crafted payload.
- CSRF: HttpOnly + SameSite=Strict cookie (no cross-origin implicit credits).
- Brute-force: Argon2id di `/auth/login` = 1 verify call ≈ 50–100 ms; rate-limit 5/15min. Plus PK-id rate-limit 3 attempts/session lifetime.
- File upload abuse: ALLOWED_MIMES enumeration, MAX_UPLOAD_BYTES = 5 MB, presign only generates R2 key tanpa server menerima blob.
- R2 URL leak: presigned PUT ttl 5 min, presigned GET ttl 10 min; URLs HMAC-signed dan tidak reusable setelah expired.

## 🎉 Status Akhir (2026-07-23)

Seluruh 11 phase cloud migration plan selesai:

| # | Phase | Status |
|:---:|:---|:---:|
| 0 | Repo Restructure (monorepo `apps/{web,server}` + `packages/shared`) | ☑ DONE |
| 1 | Backend Skeleton + Postgres | ☑ DONE |
| 2 | Auth (Argon2id + HttpOnly cookie + rate-limit) | ☑ DONE |
| 3 | Notes CRUD + AES-256-GCM | ☑ DONE |
| 4 | Image Presigned R2 | ☑ DONE |
| 5 | Offline-First Sync Layer | ☑ DONE |
| 6 | Search (Postgres tsvector FTS) | ☑ DONE |
| 7 | Export/Import (.treenote v2 + R2 presigned PUT URLs) | ☑ DONE |
| 8 | Onboarding Wizard | ☑ DONE |
| 9 | Production Prep (Dockerfile + Caddyfile + systemd + backup cron + deploy.sh) | ☑ DONE |
| 10 | Harden (Pino logs + body-size limits + strict CSP + privacy-preserving observability) | ☑ DONE |

Total effort: ~9–12 hari kerja single-developer (sebagian bisa paralel).

---

## 17. Implementation Status Tracker

Gunakan tabel ini untuk tracking progress saat mulai eksekusi. Cara pakai:

- Ganti `☐ TODO` dengan `☑ DONE` (atau `🚧 IN PROGRESS`, `⛔ BLOCKED`) saat phase dimulai/selesai.
- Isi kolom **Started** dengan tanggal (format `YYYY-MM-DD`) hari pertama Anda sentuh phase tersebut.
- Isi **Completed** dengan tanggal hari phase tersebut lulus exit criteria-nya.
- Pakai kolom **Notes** untuk catat keputusan TBD yang diambil di phase itu, atau link ke PR/commit terkait.

### Tracker Tabel

| # | Phase | Status | Effort | Started | Completed | Notes |
|:---:|:---|:---:|:---:|:---:|:---:|:---|
| 0 | Repo Restructure (monorepo `apps/{web,server}` + `packages/shared`) | ☑ DONE | ½ day | 2026-07-23 | 2026-07-23 | monorepo + npm workspaces; frontend moved to apps/web; shared types in packages/shared; vite proxy /api → 8787 |
| 1 | Backend Skeleton + Postgres (Hono + Drizzle + Docker Compose) | ☑ DONE | 1 day | 2026-07-23 | 2026-07-23 | Hono app + /healthz; Drizzle schema (users, sessions, notes, attachments with customType bytea); docker-compose.yml (pg+minio); drizzle.config.ts |
| 2 | Auth (Argon2id + HttpOnly cookie + rate-limit) | ☑ DONE | ½ day | 2026-07-23 | 2026-07-23 | Argon2id hash/verify; HMAC-signed session cookie (HttpOnly, SameSite=Strict); rolling 30d expiry; in-memory token-bucket rate limiter on /login (5/15min) + /setup (3/hr); session middleware; POST /auth/setup for first-time |
| 3 | Notes CRUD + AES-256-GCM (recursive CTE tree) | ☑ DONE | 1–2 days | 2026-07-23 | 2026-07-23 | AES-256-GCM encrypt/decrypt (12-byte nonce, auth tag); GET/POST/PATCH/DELETE/restore/permanent notes; recursive CTE for descendant collection; optimistic locking via If-Match + version; self-ref FK on parentId |
| 4 | Image Presigned R2 (direct PUT, signed GET) | ☑ DONE | 1 day | 2026-07-23 | 2026-07-23 | S3Client (R2/MinIO, forcePathStyle); POST /upload/presign (mime/size validation, 5MB limit); GET /attachments/:id (presigned GET 10min TTL); POST /attachments/:id/complete; presignPut/presignGet helpers |
| 5 | Offline-First Sync Layer (Dexie v5 + drainer + conflict UX) | ☑ DONE | 2–3 days 🔥 | 2026-07-23 | 2026-07-23 | **phasa terbesar**; 8 new files (api/client, sync/queue, pull, push, conflict, drainer, useSyncEngine, useSyncStatus); 12 modified files (types, db v5 schema, notes.ts, Editor, TreeView, Sidebar, TrashView, ResizableImage, App, db.test, notes.test); 2 round code review; 277/277 tests pass; TBD #11/#12/#14 decided; circular imports broken; dirty flag lifecycle complete; emptyTrash + import routed through queue; 401 session detection |
| 6 | Search (Postgres `tsvector` FTS) | ☑ DONE | ½ day | 2026-07-23 | 2026-07-23 | Backend `apps/server/src/html-to-text.ts` + `notes.ts` (POST/PATCH recompute `to_tsvector('simple', title \|\| ' ' \|\| plaintext(content))` via SQL template) + `db/schema.ts` (customType `tsvector` + GIN index `notes_content_tsvector_idx`) + `routes/search.ts` (rewrote to `websearch_to_tsquery` + `ts_rank` + `LIMIT 50`; catches tsquery syntax errors → empty list). Frontend search stays on local Fuse.js (zero latency, offline-first) — backend endpoint is consumed by tools/CLI future work. Shared types: none added (existing `NoteDTO` reused). |
| 7 | Export/Import (.treenote bulk) | ☑ DONE | ½ day | 2026-07-23 | 2026-07-23 | Backend `apps/server/src/routes/backup.ts` (POST `/backup/export/full` — single JSON, R2 S3 GetObjectCommand downloads in parallel with concurrency 4, base64 inline; 150 MB memory budget → 413 else; POST `/backup/import/full` — multipart/form-data, server-encrypts notes with master key, onConflictDoUpdate includes tsvector recompute, returns presigned PUT URLs for browser-direct R2 uploads, onConflictDoNothing on attachments to preserve existing canonical blobs). Shared types: `BackupPayloadV2`, `BackupAttachmentV2`, `BackupAttachmentUpload`, `BackupImportResponse`, `BACKUP_VERSION_V2 = 2`. Frontend `apps/web/src/api/client.ts`: `exportFull` + `importFull` (now handles `FormData` body without leaking `Content-Type: application/json`). Sidebar export now prefers cloud export, falls back to local IndexedDB. Import path unchanged (still routes through `queuedImportNotes` sync queue — cross-device consistency reached via drainer + pull delta). |
| 8 | Onboarding Wizard (IndexedDB → cloud) | ☑ DONE | ½ day | 2026-07-23 | 2026-07-23 | Backend `apps/server/src/routes/notes.ts` POST now uses `onConflictDoUpdate` (version bumps on conflict) for re-entrant uploads from chunked batches. Frontend new `apps/web/src/onboarding/` directory: `useOnboardingWizard.ts` (detection hook + phase machine detecting→show→uploading→fresh-confirm→fresh→complete→hide), `upload-runner.ts` (chunk 10 notes / chunk 5 attachments parallel uploads with `lastSyncedAt`/`r2Key` skip semantics for resume), `OnboardingModal.tsx` (glassmorphic UI w/ welcome/uploading/complete states + irreversible "Start fresh" confirm dialog + retry button on partial-failure), `onboarding.test.ts` (covers detection predicate, upload-runner chunking, re-entrancy eligible-row filter, clear-data transaction). `apps/web/src/App.tsx` now gates `<Layout />` + `useSyncEngine()` behind wizard completion to prevent drainer race. Detection: `hasSession && localActiveNotes > 0 && meInfo.noteCount === 0 && anyLocal.lastSyncedAt == null`. Re-entrant: re-mount picks up only unprocessed rows (`lastSyncedAt == null` / `r2Key == null`). |
| 9 | Production Prep (VPS + Caddy + systemd + backup) | ☑ DONE | 1 day | 2026-07-23 | 2026-07-23 | Backend `apps/server/Dockerfile` multi-stage Node 22 bookworm-slim (non-root `node` user, HEALTHCHECK via `/healthz`, prod-only deps via `npm prune --omit=dev`) + `.dockerignore` (excludes apps/web source, tests, plan docs). `deploy/Caddyfile` (reverse_proxy localhost:8787 + `/healthz` health-path check + hashed-asset cache + SPA `try_files {path} /index.html` fallback + defense-in-depth security headers). `deploy/systemd/mindleaf.service` (`User=mindleaf`, `Requires=postgresql.service`, `WorkingDirectory=/opt/mindleaf`, hardened: `NoNewPrivileges`, `ProtectSystem=strict`, `RestrictAddressFamilies`, `RestrictNamespaces`, `RestrictRealtime`, empty `CapabilityBoundingSet`, `PrivateTmp/Devices/Kernel*`, `MemoryHigh=512M`, `OOMPolicy=stop`). `deploy/scripts/backup.sh` (`set -euo pipefail` + `flock` + `pg_dump -Fc --no-owner --no-acl --compress=9` + `rclone copyto` retries + 30-day retention sweep via `rclone delete --rmdirs --min-age`, `systemd-cat` logging). `deploy/scripts/bootstrap.sh` (one-time provisioning: apt postgresql-16 + caddy + rclone, `mindleaf` user, `.env` from template, postgres role + `.pgpass`, `rclone.conf` env-injection). `deploy/cron.d/mindleaf-backup` (03:00 UTC daily as `mindleaf` user). Repo-root `scripts/deploy.sh` (VPS-local, `--dry-run`/`--no-migrate`/`--rollback` flags, default no network pull, dist.bak snapshots for rollback, healthcheck loop with auto-rollback on unhealthy, Caddy `validate` + `reload`, stages SPA locally to `/var/www/mindleaf/dist`). |
| 10 | Harden (secureHeaders, rate-limit, logging) | ☐ TODO | ½ day | — | — | depends on 9 |

**Total perkiraan effort**: ~9–12 hari kerja single-developer (beberapa bisa paralel).

### Status Legend

| Symbol | Meaning |
|:---:|:---|
| ☐ TODO | Belum disentuh |
| 🚧 IN PROGRESS | Sedang dikerjakan (catatan apa yang sudah selesai di Notes) |
| ⛔ BLOCKED | Tidak bisa lanjut (catat blocker di Notes) |
| ☑ DONE | Lulus exit criteria, sudah diverifikasi |
| ⊘ SKIPPED | Diputuskan tidak perlu untuk V1 (catat alasan di Notes) |

### Reminder Exit Criteria Tiap Phase (ringkasan)

- **Phase 0**: `npm run dev` di root jalanin frontend + backend bersamaan.
- **Phase 1**: `curl http://localhost:8787/healthz` → `{ ok: true }`; Drizzle Studio connect.
- **Phase 2**: `curl -X POST /auth/login` dengan seeded user → 200 + Set-Cookie valid.
- **Phase 3**: e2e login → create note → patch → restore; `psql` inspect `content_ct` bytea (bukan plaintext).
- **Phase 4**: upload PNG via MinIO console → fetched via signed URL → ✓.
- **Phase 5**: cold-start app dengan backend offline + notes di IndexedDB → app berfungsi penuh; reconnect → drain + delta pull → verified via Postgres `SELECT version FROM notes`.
- **Phase 6**: search works, ranking reasonable.
- **Phase 7**: round-trip export-then-import preserves 100% data fidelity.
- **Phase 8**: onboarding modal muncul untuk IndexedDB existing di-cloud-kosong, bukan muncul untuk users yang sudah migrate.
- **Phase 9**: build jalan di VPS via SSH manual; Caddy generate SSL cert otomatis.
- **Phase 10**: penetration-test mental pass — XSS, CSRF, brute-force, file upload abuse, R2 URL leak.

### Tips

- **Jangan skip exit criteria** — tercatat dengan jelas di plan, dan phase berikutnya depend on exit phase sebelumnya.
- **Catat TBD decisions** di kolom Notes phase 5–8 — di situlah keputusan sync, conflict UX, encryption cache dibuat konkret.
- **Update tracker setiap hari** — kolom kecil tapi Powerful untuk retrospektif nanti.
