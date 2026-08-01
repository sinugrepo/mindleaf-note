/**
 * Conflict resolution — when a push returns 409 Conflict, the user
 * chooses how to resolve it via a modal.
 *
 * Three resolution paths:
 *   1. "Use Remote" — overwrite local with server data, delete mutation.
 *   2. "Keep Mine" — re-push with the remote's version as If-Match.
 *   3. "Keep Both as Copy" — create a new note with local content,
 *      revert local to remote (same as Use Remote).
 */

import { v4 as uuidv4 } from 'uuid';
import { db, type PendingMutation } from '../db/db';
import { api } from '../api/client';
import { notifyDrainer, queuedImportNotes } from './queue';
import { ATTACHMENT_SRC_PREFIX, type Attachment, type Note } from '../types';

/**
 * Resolve a conflict by keeping the remote version.
 * Overwrites the local note with the server's data and deletes
 * the pending mutation.
 */
export async function resolveUseRemote(
  mutationId: string,
  remoteNote: {
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
): Promise<void> {
  // `update()` is a no-op when a local row was removed while the conflict
  // was waiting. Put the complete snapshot instead so Use Remote always
  // leaves a coherent local note and clears the stale mutation.
  await db.transaction('rw', db.notes, db.attachments, db.pendingMutations, async () => {
    await db.notes.put({
      id: remoteNote.id,
      parentId: remoteNote.parentId,
      title: remoteNote.title,
      content: remoteNote.content,
      order: remoteNote.orderIdx,
      isExpanded: remoteNote.isExpanded,
      isFolder: remoteNote.isFolder,
      tags: remoteNote.tags,
      deletedAt: remoteNote.deletedAt,
      createdAt: remoteNote.createdAt,
      updatedAt: remoteNote.updatedAt,
      version: remoteNote.version,
      dirty: false,
      lastSyncedAt: Date.now(),
    });
    // Drop every queued mutation for this note, including attachment
    // uploads whose resourceId is the attachment id rather than note id.
    const attachments = await db.attachments.where('noteId').equals(remoteNote.id).toArray();
    const referencedAttachmentIds = new Set<string>();
    const attachmentPattern = new RegExp(`${ATTACHMENT_SRC_PREFIX}([^"'\\s<]+)`, 'g');
    for (const match of remoteNote.content.matchAll(attachmentPattern)) {
      referencedAttachmentIds.add(match[1]);
    }
    const orphanAttachments = attachments.filter(
      (attachment) => !referencedAttachmentIds.has(attachment.id),
    );
    const resourceIds = [
      remoteNote.id,
      ...attachments.map((attachment) => attachment.id),
    ];
    const queued = await db.pendingMutations
      .where('resourceId')
      .anyOf(resourceIds)
      .toArray();
    await db.pendingMutations.bulkDelete(queued.map((record) => record.id));
    if (orphanAttachments.length > 0) {
      await db.attachments.bulkDelete(orphanAttachments.map((attachment) => attachment.id));
    }
  });
}

/**
 * Resolve a conflict by keeping the local version.
 * Re-enqueues the mutation with the remote's version as the new
 * If-Match base, so the next push will overwrite the server.
 */
export async function resolveKeepMine(
  mutationId: string,
  remoteVersion: number,
): Promise<void> {
  const mutation = await db.pendingMutations.get(mutationId);
  if (!mutation) throw new Error('Sync conflict no longer exists');
  const local = await db.notes.get(mutation.resourceId);
  if (!local) throw new Error('Local note is no longer available');

  // Collapse every queued patch for this note into one full local snapshot.
  // This rebases later optimistic edits on the remote version instead of
  // replaying stale If-Match bases one by one.
  const payload = {
    title: local.title,
    content: local.content,
    isExpanded: local.isExpanded,
    orderIdx: local.order,
    parentId: local.parentId,
    tags: local.tags ?? [],
  };
  const rebased: PendingMutation = {
    ...mutation,
    id: uuidv4(),
    type: 'patch_note',
    payload: JSON.stringify(payload),
    baseVersion: remoteVersion,
    attempts: 0,
    lastError: null,
    status: 'pending',
    createdAt: Date.now(),
  };

  await db.transaction('rw', db.notes, db.pendingMutations, async () => {
    await db.notes.update(local.id, { version: remoteVersion, dirty: true });
    await db.pendingMutations.where('resourceId').equals(local.id).delete();
    await db.pendingMutations.add(rebased);
  });
  notifyDrainer();
}

/**
 * Resolve a conflict by keeping both — create a new note with the
 * local content, then revert local to the remote version.
 *
 * The new note gets a title suffix " (conflict copy)".
 */
/**
 * Mark all queued mutations for a note as remote-missing after GET /notes/:id
 * returns 404. The record stays available for explicit recovery, but it no
 * longer appears as an ordinary 409 conflict that will keep failing.
 */
export async function markRemoteMissing(mutationId: string): Promise<void> {
  const mutation = await db.pendingMutations.get(mutationId);
  if (!mutation) throw new Error('Sync conflict no longer exists');
  // A probe may finish after the user already resolved the conflict. Never
  // resurrect a completed/deleted mutation as remote_missing.
  if (mutation.status !== 'conflicted') return;
  await db.pendingMutations
    .where('resourceId')
    .equals(mutation.resourceId)
    .modify({
      status: 'remote_missing' as const,
      lastError: 'Remote note no longer exists (404)',
    });
}

/**
 * Recover a conflict whose remote note has been deleted (GET returned 404)
 * by recreating the local snapshot with the same stable id. This keeps
 * offline edits instead of silently throwing them away.
 */
export async function resolveRemoteMissingKeepMine(
  mutationId: string,
  localNote: Note,
): Promise<void> {
  const mutation = await db.pendingMutations.get(mutationId);
  if (!mutation || mutation.status !== 'remote_missing' || mutation.type !== 'patch_note') throw new Error('Remote-missing note conflict no longer exists');

  const attachments = await db.attachments.where('noteId').equals(localNote.id).toArray();
  const affectedResourceIds = [localNote.id, ...attachments.map((attachment) => attachment.id)];
  const oldMutationIds = new Set(
    (
      await db.pendingMutations
        .where('resourceId')
        .anyOf(affectedResourceIds)
        .toArray()
    ).map((queued) => queued.id),
  );

  // Quarantine stale records before the replacement queue is notified. Only
  // the note mutation is `remote_recovering`; attachment records remain
  // `remote_missing` so the UI never treats an attachment id as a note id.
  await db.pendingMutations
    .where('resourceId')
    .anyOf(affectedResourceIds)
    .modify((record) => {
      record.status = record.type === 'patch_note' ? 'remote_recovering' : 'remote_missing';
      record.lastError = record.type === 'patch_note'
        ? 'Recreating note after remote deletion'
        : 'Attachment belongs to a remotely deleted note';
    });

  // A remote deletion also invalidates previously synced attachment
  // metadata. Requeue the local blobs as local-only so the recreated note
  // uploads both its content and images again.
  const attachmentsToRecreate = attachments.map((attachment) => ({
    ...attachment,
    r2Key: null,
    syncStatus: 'local_only' as const,
  }));

  try {
    // queuedImportNotes is atomic for the replacement snapshot and its
    // attachment uploads. Only remove the stale records after it succeeds;
    // otherwise a failed recovery would leave the user with no retry path.
    await queuedImportNotes([
      {
        ...localNote,
        version: 1,
        dirty: true,
        updatedAt: Date.now(),
      },
    ], attachmentsToRecreate);

    await db.transaction('rw', db.pendingMutations, async () => {
      await db.pendingMutations.bulkDelete(Array.from(oldMutationIds));
    });
  } catch (error) {
    // Preserve any replacement mutations created before the failure. Only
    // return the original quarantined records to actionable remote_missing.
    await db.pendingMutations.bulkGet(Array.from(oldMutationIds)).then(async (records) => {
      const originalIds = records.filter(Boolean).map((record) => record!.id);
      if (originalIds.length > 0) {
        await db.pendingMutations.bulkUpdate(originalIds.map((id) => ({
          key: id,
          changes: {
            status: 'remote_missing' as const,
            lastError: 'Remote note no longer exists (404)',
          },
        })));
      }
    });
    throw error;
  }
}

/**
 * Resolve a conflict whose remote note has been deleted by deleting the
 * local copy and every queued mutation for that note. This is the explicit
 * destructive counterpart to resolveRemoteMissingKeepMine.
 */
export async function resolveRemoteMissingDeleteLocal(
  mutationId: string,
  noteId: string,
): Promise<void> {
  const mutation = await db.pendingMutations.get(mutationId);
  if (!mutation || mutation.status !== 'remote_missing' || mutation.type !== 'patch_note') throw new Error('Remote-missing note conflict no longer exists');
  if (mutation.resourceId !== noteId) throw new Error('Conflict note mismatch');

  await db.transaction('rw', db.notes, db.attachments, db.pendingMutations, async () => {
    const attachments = await db.attachments.where('noteId').equals(noteId).toArray();
    const resourceIds = [noteId, ...attachments.map((attachment) => attachment.id)];
    // Attachment uploads use attachment.id as resourceId, so deleting only
    // the note mutation would leave orphan upload retries behind.
    const queued = await db.pendingMutations
      .where('resourceId')
      .anyOf(resourceIds)
      .toArray();
    await db.pendingMutations.bulkDelete(queued.map((record) => record.id));
    if (attachments.length > 0) {
      await db.attachments.bulkDelete(attachments.map((attachment) => attachment.id));
    }
    await db.notes.delete(noteId);
  });
}

export async function resolveKeepBoth(
  mutationId: string,
  localNote: Note,
  remoteNote: {
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
): Promise<void> {
  // 1. Create a new note with the local content. Attachment references
  // must be rewritten to fresh ids; otherwise the copy would point at
  // rows owned by the original note and could become an unavailable image
  // after either note is edited or purged.
  const copyId = uuidv4();
  const attachmentIds = Array.from(
    localNote.content.matchAll(
      new RegExp(`${ATTACHMENT_SRC_PREFIX}([^"'\\s<]+)`, 'g'),
    ),
  ).map((match) => match[1]);
  const sourceAttachments = attachmentIds.length
    ? await db.attachments.where('id').anyOf(attachmentIds).toArray()
    : [];
  const clonedBySourceId = new Map<string, Attachment>();
  for (const source of sourceAttachments) {
    let blob = source.blob;
    if (blob.size === 0 && source.r2Key) {
      const attachmentUrl = await api.getAttachmentUrl(source.id);
      const response = await fetch(attachmentUrl.url);
      if (!response.ok) throw new Error(`Unable to download attachment ${source.id}`);
      blob = await response.blob();
    }
    if (blob.size === 0) throw new Error(`Attachment ${source.id} is unavailable`);
    const clone: Attachment = {
      ...source,
      id: uuidv4(),
      noteId: copyId,
      blob,
      r2Key: null,
      syncStatus: 'local_only',
    };
    clonedBySourceId.set(source.id, clone);
  }
  const rewrittenContent = localNote.content.replace(
    new RegExp(`${ATTACHMENT_SRC_PREFIX}([^"'\\s<]+)`, 'g'),
    (full, sourceId: string) => {
      const clone = clonedBySourceId.get(sourceId);
      return clone ? `${ATTACHMENT_SRC_PREFIX}${clone.id}` : full;
    },
  );
  const copyNote: Note = {
    ...localNote,
    id: copyId,
    content: rewrittenContent,
    title: `${localNote.title} (conflict copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await queuedImportNotes([copyNote], Array.from(clonedBySourceId.values()));

  // 2. Revert local to remote (same as resolveUseRemote)
  await resolveUseRemote(mutationId, remoteNote);
}
