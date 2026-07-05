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
