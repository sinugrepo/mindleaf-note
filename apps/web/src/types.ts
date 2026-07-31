export interface Note {
  id: string;
  parentId: string | null;
  title: string;
  content: string;
  order: number;
  isExpanded: boolean;
  createdAt: number;
  updatedAt: number;
  isFolder?: boolean;
  /**
   * Soft-delete marker for the Trash/Recycle Bin feature.
   *   - `undefined` (existing notes pre-trash) or `null` = active.
   *   - number = the timestamp (epoch ms) at which the user deleted the
   *     note. Auto-purged by `purgeOldTrash()` after TRASH_RETENTION_MS.
   *
   * Cheap filter rule used everywhere in the UI: `note.deletedAt == null`
   * matches both undefined and null (loose equality) so legacy notes
   * stay active without explicit migration.
   */
  deletedAt?: number | null;
  /**
   * Multi-label tags for the Tags feature. Each entry is a normalized
   * tag string (lowercase, no leading `#`, single-space-separated
   * kebab-case; helper lives in src/lib/tags.ts). Empty / undefined
   * means "no tags" — Dexie serializes arrays as `[]` so we never
   * have a `tags: undefined` vs `tags: []` mismatch on rewrite.
   *
   * The v4 schema indexes `*tags` so a `where('tags').anyOf(...)`
   * query is O(matching-notes) rather than a full-table scan.
   */
  tags?: string[];
  // --- Sync fields (v5 schema) ---
  /** Server-side optimistic-lock version. Mirrors the backend's
   * `version` column. Incremented locally on every optimistic write;
   * replaced with the server's version when the push succeeds. */
  version?: number;
  /** True when the note has been modified locally but not yet synced
   * to the backend. The drainer clears this after a successful push. */
  dirty?: boolean;
  /** Epoch ms of the last successful sync pull for this row. Used by
   * the delta-sync apply logic to decide whether to overwrite local
   * with server or skip (local is newer). */
  lastSyncedAt?: number;
}

/**
 * A binary attachment (typically an image referenced from a note's HTML).
 * Stored in a separate Dexie table so note.content stays free of IndexedDB's
 * per-key size limit on indexed fields (rationale pinned in db.ts v2
 * comment, regression-guarded by db.test.ts).
 *
 * Referenced from note.content via the URL form `${ATTACHMENT_SRC_PREFIX}${id}`
 * (see the constant below). The TipTap NodeView for images resolves that
 * scheme to a `blob:` URL at render time and caches it for the lifetime of
 * the tab — see ResizableImage.tsx for details.
 */
export interface Attachment {
  id: string;
  noteId: string;
  blob: Blob;
  mime: string;
  name: string;
  createdAt: number;
  // --- Sync fields (v5 schema) ---
  /** R2 object key once the blob has been uploaded to the backend.
   * Null for local-only attachments that haven't been synced yet. */
  r2Key?: string | null;
  /** Sync status of this attachment:
   *  - `local_only`: blob exists only in IndexedDB, not yet pushed to R2.
   *  - `synced`: blob is in both IndexedDB and R2; r2Key is set.
   *  - `uploaded_server_unknown`: upload succeeded but server
   *    confirmation hasn't arrived yet (transient state). */
  syncStatus?: 'local_only' | 'synced' | 'uploaded_server_unknown';
}

/**
 * URI scheme used inside TipTap image `src` attributes for attachments.
 * Stored on disk as exactly `${ATTACHMENT_SRC_PREFIX}${id}` with no
 * separator. Distinct from `data:`, `blob:`, and `http(s):` so the NodeView
 * pass-through logic can skip the IndexedDB lookup for any non-attachment
 * source (legacy inline base64, external URLs).
 */
export const ATTACHMENT_SRC_PREFIX = 'attachment:';

export type Theme = 'light' | 'dark' | 'system';
