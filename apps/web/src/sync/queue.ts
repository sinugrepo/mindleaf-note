/**
 * Sync queue — the single entry point for ALL IndexedDB writes.
 *
 * Every mutation to `db.notes` or `db.attachments` MUST go through
 * this module so that:
 *   1. The local cache is updated optimistically (UI responds instantly).
 *   2. A `PendingMutation` row is enqueued for the drainer to push.
 *
 * The existing `notes.ts` helpers (createRootNote, softDeleteNote, etc.)
 * are rewritten here to route through the queue. Components call these
 * functions instead of touching `db.notes` directly.
 *
 * When the backend is unreachable (offline) or no session exists,
 * the mutation is still enqueued — the drainer will push it later
 * when connectivity is restored. This is the core of offline-first.
 */

import { v4 as uuidv4 } from 'uuid';
import { db, type PendingMutation } from '../db/db';
import type { Note, Attachment } from '../types';
import type { TombstoneDTO } from '@mindleaf/shared';
import { shouldSync } from '../api/client';
import { notifyDrainer } from './drainer';
import { withSyncLock } from './coordination';
import { isHistoryReplay, recordNoteChange } from '../lib/note-history';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Enqueue a pending mutation. Does NOT touch the notes/attachments
 * tables — the caller is responsible for the optimistic write.
 */
async function enqueue(
  type: PendingMutation['type'],
  resourceId: string,
  payload: Record<string, unknown>,
  baseVersion: number | null = null,
): Promise<void> {
  const mutation: PendingMutation = {
    id: uuidv4(),
    type,
    resourceId,
    payload: JSON.stringify(payload),
    baseVersion,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
    status: 'pending',
  };
  await db.pendingMutations.add(mutation);
  // Notify the drainer immediately so the mutation is pushed without
  // waiting for the next 5-second interval tick. The drainer's
  // `draining` guard prevents concurrent drains.
  notifyDrainer();
}

// ---------------------------------------------------------------------------
// Note mutations (optimistic + enqueue)
// ---------------------------------------------------------------------------

// Autosave can fire many times before the previous request has reached the
// server. Serialize patches per note so each mutation observes the optimistic
// version written by the preceding mutation and receives a unique If-Match.
const patchChains = new Map<string, Promise<void>>();

/**
 * Create a new note. Writes to IndexedDB immediately, enqueues a
 * `create_note` mutation for the drainer to POST to the backend.
 *
 * Returns the created note (with the optimistic version=1).
 */
export async function queuedCreateNote(
  note: Note,
): Promise<Note> {
  const now = Date.now();
  const enriched: Note = {
    ...note,
    version: 1,
    dirty: true,
    updatedAt: now,
  };
  await db.notes.add(enriched);
  await enqueue(
    'create_note',
    note.id,
    {
      id: note.id,
      parentId: note.parentId,
      title: note.title,
      isFolder: note.isFolder ?? false,
      content: note.content,
      tags: note.tags ?? [],
      orderIdx: note.order,
    },
  );
  return enriched;
}

/**
 * Patch a note (title, content, isExpanded, order, parentId, tags).
 * Writes optimistically to IndexedDB, enqueues a `patch_note` mutation
 * with the current version for `If-Match` optimistic locking.
 */
export function queuedPatchNote(
  noteId: string,
  updates: Partial<Pick<Note, 'title' | 'content' | 'isExpanded' | 'order' | 'parentId' | 'tags'>>,
  now: number = Date.now(),
): Promise<void> {
  const previous = patchChains.get(noteId) ?? Promise.resolve();
  const operation = previous.catch(() => undefined).then(async () => {
    const { current, currentVersion, before } = await withSyncLock(async () => {
      const current = await db.notes.get(noteId);
      const currentVersion = current?.version ?? 0;
      const optimisticVersion = currentVersion + 1;

      // Map `order` → `orderIdx` in the API payload (the backend column
      // is `order_idx`, the DTO field is `orderIdx`).
      const apiPayload: Record<string, unknown> = { ...updates };
      if (updates.order !== undefined) {
        apiPayload.orderIdx = updates.order;
        delete apiPayload.order;
      }

      const before: Partial<Pick<Note, 'title' | 'content' | 'isExpanded' | 'order' | 'parentId' | 'tags'>> = {};
      for (const field of Object.keys(updates) as Array<keyof typeof updates>) {
        if (current && current[field] !== undefined) {
          (before as Record<string, unknown>)[field] = current[field];
        }
      }

      await db.notes.update(noteId, {
        ...updates,
        updatedAt: now,
        version: optimisticVersion,
        dirty: true,
      });

      // Coalesce every not-yet-started patch for this note. Keeping the
      // earliest mutation preserves its original baseVersion, while merging
      // the payloads in creation order preserves the latest value per field.
      // The cross-tab sync lock covers the read/merge/delete/write sequence;
      // without it, two tabs could each select a different first row and
      // leave stale patches behind.
      const queuedPatches = await db.pendingMutations
        .where('resourceId')
        .equals(noteId)
        .filter((mutation) => mutation.type === 'patch_note' && mutation.status === 'pending')
        .sortBy('createdAt');
      if (queuedPatches.length > 0) {
        const [first, ...rest] = queuedPatches;
        let mergedPayload: Record<string, unknown> = {};
        for (const queued of queuedPatches) {
          try {
            mergedPayload = { ...mergedPayload, ...JSON.parse(queued.payload) };
          } catch {
            // Keep valid fields from other queue records if one old payload is malformed.
          }
        }
        mergedPayload = { ...mergedPayload, ...apiPayload };
        await db.transaction('rw', db.pendingMutations, async () => {
          await db.pendingMutations.update(first.id, {
            payload: JSON.stringify(mergedPayload),
            lastError: null,
          });
          if (rest.length > 0) {
            await db.pendingMutations.bulkDelete(rest.map((queued) => queued.id));
          }
        });
        notifyDrainer();
      } else {
        await enqueue('patch_note', noteId, apiPayload, currentVersion);
      }
      return { current, currentVersion, before };
    });

    // TipTap maintains its own character-level content history. Keep the
    // shared queue history focused on tree/title/tag changes so autosave does
    // not create one global history entry per keystroke.
    if (!isHistoryReplay()) {
      const historyBefore = { ...before };
      delete historyBefore.content;
      const historyAfter = { ...updates };
      delete historyAfter.content;
      recordNoteChange({ noteId, before: historyBefore, after: historyAfter });
    }

    // Keep variables explicit for the queue's optimistic-lock comments and
    // to make this operation's result easy to inspect in a debugger.
    void current;
    void currentVersion;
  });
  const tracked = operation.finally(() => {
    if (patchChains.get(noteId) === tracked) patchChains.delete(noteId);
  });
  patchChains.set(noteId, tracked);
  return tracked;
}

/**
 * Soft-delete a note + descendants. Stamps `deletedAt` locally,
 * enqueues a `delete_note` mutation.
 *
 * NOTE: The descendant cascade is computed locally (same logic as the
 * existing `softDeleteNote` in notes.ts). The backend also cascades
 * via recursive CTE, so the push is idempotent.
 */
export async function queuedDeleteNote(
  noteId: string,
  descendantIds: string[],
  now: number = Date.now(),
): Promise<void> {
  const allIds = [noteId, ...descendantIds];
  const deleteRows = await db.notes.bulkGet(allIds);
  await db.notes.bulkUpdate(
    allIds.map((id, index) => ({
      key: id,
      changes: {
        deletedAt: now,
        updatedAt: now,
        version: (deleteRows[index]?.version ?? 0) + 1,
        dirty: true,
      },
    })),
  );
  // Only enqueue one mutation for the root — the backend cascades.
  // Include descendantIds so push.ts can clear `dirty` on all affected
  // rows after the server confirms the cascade.
  await enqueue('delete_note', noteId, { descendantIds });
}

/**
 * Restore a note from trash. Clears `deletedAt` locally, enqueues
 * a `restore_note` mutation.
 */
export async function queuedRestoreNote(
  noteId: string,
  descendantIds: string[],
  now: number = Date.now(),
): Promise<void> {
  const allIds = [noteId, ...descendantIds];
  const restoreRows = await db.notes.bulkGet(allIds);
  await db.notes.bulkUpdate(
    allIds.map((id, index) => ({
      key: id,
      changes: {
        deletedAt: null,
        updatedAt: now,
        version: (restoreRows[index]?.version ?? 0) + 1,
        dirty: true,
      },
    })),
  );
  await enqueue('restore_note', noteId, { descendantIds });
}

/**
 * Permanently delete a note from trash. Hard-deletes locally,
 * enqueues a `permanent_delete_note` mutation.
 */
export async function queuedPermanentDeleteNote(
  noteId: string,
  descendantIds: string[],
): Promise<void> {
  const allIds = [noteId, ...descendantIds];
  // Cascade-delete attachments locally.
  const attachments = await db.attachments
    .where('noteId')
    .anyOf(allIds)
    .toArray();
  if (attachments.length > 0) {
    await db.attachments.bulkDelete(attachments.map((a) => a.id));
  }
  await db.notes.bulkDelete(allIds);
  // Only enqueue for the root — backend cascades.
  await enqueue('permanent_delete_note', noteId, {});
}

// ---------------------------------------------------------------------------
// Attachment mutations
// ---------------------------------------------------------------------------

/**
 * Bulk-import notes from a backup file. Writes all notes to IndexedDB
 * with `dirty: true`, enqueues a `create_note` mutation for each.
 * If a note already exists on the server, the create will fail with
 * a 409 or 400 — the drainer will leave it as `failed` for investigation.
 * For a fresh device this is the correct behavior: all imported notes
 * are pushed to the server as new creates.
 *
 * Attachments are also bulk-put; only attachments WITHOUT an existing
 * r2Key get an `upload_attachment` mutation (already-synced attachments
 * don't need re-uploading).
 *
 * Everything runs in a single Dexie transaction across notes,
 * attachments, and pendingMutations so the import is atomic — if the
 * app crashes mid-way, no partial state is left behind.
 */
export async function queuedImportNotes(
  notes: Note[],
  attachments: Attachment[] = [],
): Promise<void> {
  // Stamp all imported notes with sync metadata.
  const stamped = notes.map((n) => ({
    ...n,
    version: n.version ?? 1,
    dirty: true,
  }));

  // Partition attachments: already-synced (skip upload) vs local-only.
  const stampedAtts = attachments.map((a) => ({
    ...a,
    r2Key: a.r2Key ?? null,
    syncStatus: a.syncStatus ?? 'local_only',
  }));
  const needsUpload = stampedAtts.filter((a) => !a.r2Key);

  // Build all mutation rows up-front so we can insert them in one
  // transaction with the note/attachment writes.
  const noteMutations: PendingMutation[] = stamped.map((note) => ({
    id: uuidv4(),
    type: 'create_note',
    resourceId: note.id,
    payload: JSON.stringify({
      id: note.id,
      parentId: note.parentId,
      title: note.title,
      isFolder: note.isFolder ?? false,
      content: note.content,
      tags: note.tags ?? [],
      orderIdx: note.order,
    }),
    baseVersion: null,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
    status: 'pending',
  }));

  const attMutations: PendingMutation[] = needsUpload.map((att) => ({
    id: uuidv4(),
    type: 'upload_attachment',
    resourceId: att.id,
    payload: JSON.stringify({
      noteId: att.noteId,
      mime: att.mime,
      name: att.name,
    }),
    baseVersion: null,
    createdAt: Date.now(),
    attempts: 0,
    lastError: null,
    status: 'pending',
  }));

  await db.transaction(
    'rw',
    db.notes,
    db.attachments,
    db.pendingMutations,
    async () => {
      await db.notes.bulkPut(stamped);
      if (stampedAtts.length > 0) {
        await db.attachments.bulkPut(stampedAtts);
      }
      if (noteMutations.length > 0) {
        await db.pendingMutations.bulkAdd(noteMutations);
      }
      if (attMutations.length > 0) {
        await db.pendingMutations.bulkAdd(attMutations);
      }
    },
  );

  // Notify the drainer once after the transaction commits.
  if (noteMutations.length > 0 || attMutations.length > 0) {
    notifyDrainer();
  }
}

// ---------------------------------------------------------------------------
// Attachment mutations
// ---------------------------------------------------------------------------

/**
 * Add a new attachment (image paste/drop). Writes the blob to
 * IndexedDB immediately, enqueues an `upload_attachment` mutation
 * for the drainer to presign + PUT to R2.
 */
export async function queuedAddAttachment(
  attachment: Attachment,
): Promise<void> {
  await db.attachments.add({
    ...attachment,
    r2Key: null,
    syncStatus: 'local_only',
  });
  await enqueue('upload_attachment', attachment.id, {
    noteId: attachment.noteId,
    mime: attachment.mime,
    name: attachment.name,
  });
}

// ---------------------------------------------------------------------------
// Direct writes (no queue — used by sync pull and import)
// ---------------------------------------------------------------------------

/**
 * Apply a server snapshot note to the local cache. Used by the
 * delta-sync pull layer. Does NOT enqueue a mutation — this is a
 * server → client write, not a user-initiated edit.
 *
 * Overwrites the local row only if the server version is newer.
 * If the local row is dirty (has pending edits), it is NOT overwritten
 * — the pending mutation will push the local version to the server.
 */
export async function applyServerNote(
  serverNote: {
    id: string;
    parentId: string | null;
    title: string;
    content: string;
    isFolder: boolean;
    isExpanded: boolean;
    orderIdx: number;
    tags: string[];
    deletedAt: number | null;
    createdAt: number;
    updatedAt: number;
    version: number;
  },
  serverNow: number,
): Promise<void> {
  const local = await db.notes.get(serverNote.id);

  if (!local) {
    // New note from server — insert directly.
    await db.notes.add({
      id: serverNote.id,
      parentId: serverNote.parentId,
      title: serverNote.title,
      content: serverNote.content,
      order: serverNote.orderIdx,
      isExpanded: serverNote.isExpanded,
      isFolder: serverNote.isFolder,
      tags: serverNote.tags,
      deletedAt: serverNote.deletedAt,
      createdAt: serverNote.createdAt,
      updatedAt: serverNote.updatedAt,
      version: serverNote.version,
      dirty: false,
      lastSyncedAt: serverNow,
    });
    return;
  }

  // Don't overwrite local edits — the pending mutation will push them.
  if (local.dirty) return;

  // Server is newer → overwrite.
  if (serverNote.version > (local.version ?? 0)) {
    await db.notes.update(serverNote.id, {
      parentId: serverNote.parentId,
      title: serverNote.title,
      content: serverNote.content,
      order: serverNote.orderIdx,
      isExpanded: serverNote.isExpanded,
      isFolder: serverNote.isFolder,
      tags: serverNote.tags,
      deletedAt: serverNote.deletedAt,
      updatedAt: serverNote.updatedAt,
      version: serverNote.version,
      dirty: false,
      lastSyncedAt: serverNow,
    });
  }
}

/**
 * Apply a server attachment to the local cache. Updates metadata
 * (r2Key, syncStatus) but does NOT download the blob — that happens
 * lazily in ResizableImage.tsx when the image is actually rendered.
 */
/**
 * Apply a permanent server deletion. Dirty local rows are preserved and
 * surfaced as an explicit remote-missing mutation instead of being erased.
 */
export async function applyServerTombstone(tombstone: TombstoneDTO): Promise<boolean> {
  if (tombstone.resourceType === 'attachment') {
    const local = await db.attachments.get(tombstone.resourceId);
    if (local?.syncStatus === 'local_only') {
      const existing = await db.pendingMutations
        .where('resourceId')
        .equals(tombstone.resourceId)
        .toArray();
      if (!existing.some((mutation) => mutation.status === 'remote_missing')) {
        await db.pendingMutations.add({
          id: uuidv4(),
          type: 'upload_attachment',
          resourceId: tombstone.resourceId,
          payload: JSON.stringify({ noteId: local.noteId, mime: local.mime, name: local.name }),
          baseVersion: null,
          createdAt: Date.now(),
          attempts: 0,
          lastError: 'Remote attachment was permanently deleted',
          status: 'remote_missing',
        });
      }
      return false;
    }
    await db.transaction('rw', db.attachments, db.pendingMutations, async () => {
      await db.attachments.delete(tombstone.resourceId);
      await db.pendingMutations.where('resourceId').equals(tombstone.resourceId).delete();
    });
    return true;
  }

  const local = await db.notes.get(tombstone.resourceId);
  if (local?.dirty) {
    const existing = await db.pendingMutations
      .where('resourceId')
      .equals(tombstone.resourceId)
      .toArray();
    if (!existing.some((mutation) => mutation.status === 'remote_missing')) {
      await db.pendingMutations.add({
        id: uuidv4(),
        type: 'patch_note',
        resourceId: tombstone.resourceId,
        payload: JSON.stringify({
          title: local.title,
          content: local.content,
          isExpanded: local.isExpanded,
          orderIdx: local.order,
          parentId: local.parentId,
          tags: local.tags ?? [],
        }),
        baseVersion: local.version ?? null,
        createdAt: Date.now(),
        attempts: 0,
        lastError: 'Remote note was permanently deleted',
        status: 'remote_missing',
      });
    }
    return false;
  }

  const attachments = await db.attachments
    .where('noteId')
    .equals(tombstone.resourceId)
    .toArray();
  await db.transaction('rw', db.notes, db.attachments, db.pendingMutations, async () => {
    await db.pendingMutations.where('resourceId').equals(tombstone.resourceId).delete();
    if (attachments.length > 0) {
      const attachmentIds = attachments.map((attachment) => attachment.id);
      await db.pendingMutations.where('resourceId').anyOf(attachmentIds).delete();
      await db.attachments.bulkDelete(attachmentIds);
    }
    await db.notes.delete(tombstone.resourceId);
  });
  return true;
}

export async function applyServerAttachment(
  serverAtt: {
    id: string;
    noteId: string;
    r2Key: string | null;
    mime: string;
    name: string;
    sizeBytes: number;
    createdAt: number;
  },
): Promise<void> {
  const local = await db.attachments.get(serverAtt.id);
  if (!local) {
    // Attachment exists on server but not in local cache.
    // We don't download the blob here — ResizableImage will fetch
    // it on demand via the presigned GET URL. Insert a metadata-only
    // row with a placeholder empty blob so Dexie doesn't complain.
    await db.attachments.add({
      id: serverAtt.id,
      noteId: serverAtt.noteId,
      blob: new Blob([], { type: serverAtt.mime }),
      mime: serverAtt.mime,
      name: serverAtt.name,
      createdAt: serverAtt.createdAt,
      r2Key: serverAtt.r2Key,
      syncStatus: 'synced',
    });
    return;
  }

  // Update metadata (r2Key may have been set by a completed upload).
  if (serverAtt.r2Key && !local.r2Key) {
    await db.attachments.update(serverAtt.id, {
      r2Key: serverAtt.r2Key,
      syncStatus: 'synced',
    });
  }
}

// ---------------------------------------------------------------------------
// Sync state helpers
// ---------------------------------------------------------------------------

export async function getSyncState(key: string): Promise<string | null> {
  const row = await db.syncState.get(key);
  return row?.value ?? null;
}

export async function setSyncState(key: string, value: string): Promise<void> {
  await db.syncState.put({ key, value });
}

// `shouldSync` is re-exported from api/client.ts to avoid a circular
// import: drainer.ts imports shouldSync from here, and if we defined it
// here, queue.ts → drainer.ts → queue.ts would be circular. By importing
// it from api/client.ts, the dependency graph is acyclic.
export { shouldSync } from '../api/client';
export { notifyDrainer } from './drainer';
