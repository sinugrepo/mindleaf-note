import { db } from '../db/db';
import { drainQueue } from './drainer';

export async function retryFailedMutations(): Promise<number> {
  const failed = await db.pendingMutations.where('status').equals('failed').toArray();
  if (failed.length === 0) return 0;
  await db.pendingMutations.bulkUpdate(failed.map((mutation) => ({
    key: mutation.id,
    changes: { status: 'pending' as const, attempts: 0, lastError: null, retryable: undefined },
  })));
  await drainQueue();
  return failed.length;
}

/**
 * Discard a failed/conflicted queue record after the user confirms they do
 * not want this local change uploaded. This is deliberately separate from
 * retry/resolution so data loss is explicit rather than accidental.
 *
 * A discarded create is removed locally because there is no remote row to
 * represent it. For edits/deletes, the local result is retained and marked
 * clean only when no other mutation for that resource remains.
 */
export async function discardSyncMutation(mutationId: string): Promise<boolean> {
  const mutation = await db.pendingMutations.get(mutationId);
  if (!mutation || !['failed', 'conflicted', 'remote_missing'].includes(mutation.status)) {
    return false;
  }

  await db.transaction('rw', db.pendingMutations, db.notes, db.attachments, async () => {
    // A remote_missing record means the server explicitly no longer has the
    // note. Clearing history must not mark that local note as clean; remove
    // the local graph instead, matching the remote-deleted state. Users who
    // want to preserve it can choose "Recreate from local" first.
    if (mutation.status === 'remote_missing') {
      // Attachment mutations use the attachment id as resourceId. They must
      // never be handled as note mutations, otherwise clearing history could
      // delete an unrelated note whose id happens to match that attachment.
      if (mutation.type === 'upload_attachment') {
        await db.pendingMutations.delete(mutation.id);
        const attachment = await db.attachments.get(mutation.resourceId);
        if (attachment) {
          await db.attachments.update(mutation.resourceId, {
            syncStatus: 'local_only',
          });
        }
        return;
      }

      const attachments = await db.attachments
        .where('noteId')
        .equals(mutation.resourceId)
        .toArray();
      const resourceIds = [mutation.resourceId, ...attachments.map((attachment) => attachment.id)];
      const related = await db.pendingMutations
        .where('resourceId')
        .anyOf(resourceIds)
        .toArray();
      await db.pendingMutations.bulkDelete(related.map((record) => record.id));
      await db.attachments.bulkDelete(attachments.map((attachment) => attachment.id));
      await db.notes.delete(mutation.resourceId);
      return;
    }

    await db.pendingMutations.delete(mutationId);
    const remaining = await db.pendingMutations
      .where('resourceId')
      .equals(mutation.resourceId)
      .toArray();

    if (mutation.type === 'create_note') {
      const attachments = await db.attachments
        .where('noteId')
        .equals(mutation.resourceId)
        .toArray();
      const attachmentIds = attachments.map((attachment) => attachment.id);
      if (attachmentIds.length > 0) {
        await db.attachments.bulkDelete(attachmentIds);
        await db.pendingMutations
          .where('resourceId')
          .anyOf(attachmentIds)
          .delete();
      }
      // A create plus its dependent patches/uploads cannot exist remotely;
      // remove the complete local create graph rather than leaving a false
      // clean note behind.
      await db.pendingMutations
        .where('resourceId')
        .equals(mutation.resourceId)
        .delete();
      await db.notes.delete(mutation.resourceId);
    } else if (mutation.type === 'upload_attachment') {
      const attachment = await db.attachments.get(mutation.resourceId);
      if (attachment) {
        await db.attachments.update(mutation.resourceId, {
          syncStatus: 'local_only',
        });
      }
    } else if (remaining.length === 0) {
      await db.notes.update(mutation.resourceId, { dirty: false });
    }
  });
  return true;
}

export async function discardAllSyncHistory(): Promise<number> {
  const records = await db.pendingMutations
    .where('status')
    .anyOf(['failed', 'conflicted', 'remote_missing'])
    .toArray();
  let discarded = 0;
  for (const record of records) {
    if (await discardSyncMutation(record.id)) discarded++;
  }
  return discarded;
}
