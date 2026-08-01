/**
 * Shared types for the Mindleaf monorepo.
 *
 * These types are consumed by:
 *   - `apps/server`  — Drizzle query result typing, API response shapes
 *   - `apps/web`     — API hook return types, sync snapshot typing
 *
 * Keeping them in `packages/shared` means a breaking change in one side
 * surfaces as a TypeScript error on the other side without needing an
 * OpenAPI spec or manual DTO sync.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * URI scheme used inside TipTap image `src` attributes for attachments.
 * Stored as exactly `${ATTACHMENT_SRC_PREFIX}${id}` with no separator.
 * Distinct from `data:`, `blob:`, and `http(s):` so the NodeView
 * pass-through logic can skip the IndexedDB/R2 lookup for any
 * non-attachment source.
 *
 * MUST match the frontend's `src/types.ts` value.
 */
export const ATTACHMENT_SRC_PREFIX = 'attachment:';

// ---------------------------------------------------------------------------
// Note
// ---------------------------------------------------------------------------

/**
 * Canonical note shape as seen by the frontend (decrypted, cache-ready).
 * The backend's Drizzle schema stores `content` as AES-256-GCM ciphertext
 * (`content_ct` + `content_nonce`); the shared type reflects the DECRYPTED
 * form that the API returns and that IndexedDB caches.
 */
export interface NoteDTO {
  id: string;
  parentId: string | null;
  title: string;
  /** Decrypted TipTap HTML content. */
  content: string;
  isFolder: boolean;
  isExpanded: boolean;
  /** Manual drag-drop ordering (epoch ms used as a sortable float). */
  orderIdx: number;
  /** Normalized kebab-case tags. */
  tags: string[];
  /** Soft-delete timestamp (epoch ms); null = active. */
  deletedAt: number | null;
  createdAt: number;
  updatedAt: number;
  /** Server-side optimistic-lock version. Increments on every write. */
  version: number;
}

// ---------------------------------------------------------------------------
// Attachment
// ---------------------------------------------------------------------------

/**
 * Attachment metadata. The actual binary lives in Cloudflare R2 (prod)
 * or MinIO (dev). The frontend resolves `attachment:<id>` refs in note
 * content by fetching the blob via a presigned GET URL or from the
 * IndexedDB blob cache.
 */
export interface AttachmentDTO {
  id: string;
  noteId: string;
  /** R2 object key, e.g. `u/<user>/a/<uuid>.png`. */
  r2Key: string | null;
  mime: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

export interface LoginRequest {
  password: string;
}

export interface LoginResponse {
  ok: true;
}

export interface MeInfoResponse {
  createdAt: number;
  noteCount: number;
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/** Stable cursor for one ordered sync stream. */
export interface SyncStreamCursor {
  updatedAt: number;
  id: string;
}

/** Cursor state for the three independently paginated sync streams. */
export interface SyncCursor {
  boundary: number;
  notes: SyncStreamCursor | null;
  attachments: SyncStreamCursor | null;
  tombstones: SyncStreamCursor | null;
}

export interface TombstoneDTO {
  resourceType: 'note' | 'attachment';
  resourceId: string;
  deletedAt: number;
}

/**
 * Delta-sync snapshot returned by `GET /api/sync/snapshot`.
 * Each stream is ordered by `(updatedAt, id)` and bounded by `boundary`.
 * The client must continue with `nextCursor` while `hasMore` is true.
 */
export interface SyncSnapshot {
  serverNow: number;
  notes: NoteDTO[];
  attachments: AttachmentDTO[];
  tombstones: TombstoneDTO[];
  hasMore: boolean;
  nextCursor: SyncCursor | null;
}

// ---------------------------------------------------------------------------
// Upload
// ---------------------------------------------------------------------------

export interface PresignRequest {
  /** Client-generated UUID shared by IndexedDB, Postgres, and the note HTML ref. */
  attachmentId?: string;
  filename: string;
  mime: string;
  sizeBytes: number;
  noteId: string;
}

export interface PresignResponse {
  attachmentId: string;
  uploadUrl: string;
  r2Key: string;
}

export interface AttachmentUrlResponse {
  r2Key: string;
  mime: string;
  /** Presigned GET URL with a short TTL (e.g. 10 minutes). */
  url: string;
}

// ---------------------------------------------------------------------------
// API error
// ---------------------------------------------------------------------------

export interface ApiErrorResponse {
  error: string;
  /** Present on 409 Conflict — the remote note that won the race. */
  remote?: NoteDTO;
}

// ---------------------------------------------------------------------------
// Backup (Phase 7 — Export/Import .treenote bulk via backend)
// ---------------------------------------------------------------------------

/**
 * Single-user app backup format version. Bumped only on
 * backward-incompatible schema changes. v2 already supports both
 * `notes` and `attachments` (with inline base64 data). The backend
 * phase-7 `/api/export/full` + `/api/import/full` endpoints use this
 * exact format so a backup file exported from local-cache (sidebar
 * local export) is byte-compatible with a cloud export.
 */
export const BACKUP_VERSION_V2 = 2;

/**
 * Wire format of one attachment row inside a `.treenote` backup payload.
 * Inline base64 so the file is a self-contained single artifact —
 * portable across devices, syncs via any file-transfer mechanism.
 */
export interface BackupAttachmentV2 {
  id: string;
  noteId: string;
  mime: string;
  name: string;
  createdAt: number;
  dataBase64: string;
}

/**
 * Top-level body of a `.treenote` v2 backup file. Identical to what
 * `apps/web/src/lib/notes-io.ts` writes when exporting from local
 * IndexedDB cache — Phase 7 ensures server export is byte-compatible.
 */
export interface BackupPayloadV2 {
  version: typeof BACKUP_VERSION_V2;
  notes: NoteDTO[];
  attachments: BackupAttachmentV2[];
}

/**
 * Server presigned-PUT URL returned for one attachment that the
 * browser still needs to upload to R2 after `/api/import/full`
 * accepted the .treenote payload. The frontend uploads each blob
 * directly to R2 with this URL, then the sync layer's regular flow
 * sees the synced attachment on the next pull.
 */
export interface BackupAttachmentUpload {
  attachmentId: string;
  uploadUrl: string;
  r2Key: string;
}

/**
 * Response from `POST /api/import/full` after the server has parsed
 * the .treenote payload, inserted notes (encrypted server-side), and
 * created attachment rows. The frontend then PUTs each blob to its
 * matching `uploadUrl` directly to R2 (server never proxies the
 * bytes — keeps the backend out of the bandwidth path).
 */
export interface BackupImportResponse {
  /** Number of notes inserted/updated server-side. */
  notesImported: number;
  /** Number of attachment rows created; each still needs PUT. */
  attachmentsCreated: number;
  /** Presigned PUT URLs — one per attachment, parallel-safe. */
  uploads: BackupAttachmentUpload[];
}
