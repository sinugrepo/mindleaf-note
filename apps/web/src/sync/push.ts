/**
 * Push a single pending mutation to the backend.
 *
 * Called by the drainer in order. Each push attempt:
 *   1. Marks the mutation `in_progress`.
 *   2. Makes the API call.
 *   3. On 200: updates the local note's version + clears dirty, deletes the mutation.
 *   4. On 409: marks the mutation `conflicted` (UI will show resolution modal).
 *   5. On network error / 5xx: increments attempts, marks `failed`.
 *
 * Retry policy: the drainer retries `failed` mutations up to MAX_ATTEMPTS.
 * After that, the mutation stays in `failed` status and is surfaced in
 * the Sync Status modal for the user to investigate.
 */

import { api } from '../api/client';
import { db, type PendingMutation } from '../db/db';

const MAX_ATTEMPTS = 10;

/**
 * A newer optimistic edit may already be present when an older request
 * returns. Only mark the row clean when its local optimistic version is not
 * ahead of the server response; otherwise the newer mutation must remain
 * dirty and will be drained next.
 */
async function settleNoteAfterPush(noteId: string, serverVersion: number): Promise<void> {
  const local = await db.notes.get(noteId);
  if (!local || (local.version ?? 0) > serverVersion) return;
  await db.notes.update(noteId, {
    version: serverVersion,
    dirty: false,
  });
}

/**
 * A create mutation may include edits made while the note was still local
 * (for example an offline folder rename folded into the POST payload). In
 * that case the server response is authoritative even though the local
 * optimistic version was incremented before the POST began. Keep the note
 * dirty only when another mutation was queued after this create.
 */
async function settleCreatedNoteAfterPush(
  noteId: string,
  serverVersion: number,
  mutationId: string,
): Promise<void> {
  const newerMutations = await db.pendingMutations
    .where('resourceId')
    .equals(noteId)
    .filter((mutation) => mutation.id !== mutationId)
    .count();
  if (newerMutations > 0) return;
  const local = await db.notes.get(noteId);
  if (!local) return;
  await db.notes.update(noteId, {
    version: serverVersion,
    dirty: false,
  });
}

/** Result of a single push attempt. */
export type PushResult =
  | { status: 'ok' }
  | { status: 'conflict'; remoteVersion: number; remoteContent: string }
  | { status: 'failed'; error: string; retryable: boolean };

/**
 * Attempt to push a single mutation. Returns the result so the
 * drainer can decide what to do next (delete, mark conflicted, retry).
 */
export async function pushMutation(
  mutation: PendingMutation,
): Promise<PushResult> {
  // Mark in_progress before making the request. The drainer persists the
  // returned retryability classification when the request fails.
  await db.pendingMutations.update(mutation.id, {
    status: 'in_progress',
    attempts: mutation.attempts + 1,
    retryable: undefined,
  });

  try {
    switch (mutation.type) {
      case 'create_note': {
        const payload = JSON.parse(mutation.payload);
        const result = await api.createNote(payload);
        // The POST may include offline edits folded into the create payload.
        await settleCreatedNoteAfterPush(result.id, result.version, mutation.id);
        return { status: 'ok' };
      }

      case 'patch_note': {
        const payload = JSON.parse(mutation.payload);
        const result = await api.patchNote(
          mutation.resourceId,
          payload,
          mutation.baseVersion ?? undefined,
        );
        await settleNoteAfterPush(result.id, result.version);
        return { status: 'ok' };
      }

      case 'delete_note': {
        try {
          await api.deleteNote(mutation.resourceId);
        } catch (deleteErr) {
          // A stale offline delete can arrive after the note was already
          // purged on another device (or after a previous successful push
          // whose queue acknowledgement was lost). The desired state is
          // already true, so do not retry this mutation forever.
          const deleteE = deleteErr as Error & { status?: number };
          if (deleteE.status !== 404) throw deleteErr;
        }
        // Clear dirty on the root + all descendants — the server
        // cascaded the soft-delete, so local state now matches server.
        const deletePayload = JSON.parse(mutation.payload);
        const deleteIds: string[] = [mutation.resourceId, ...(deletePayload.descendantIds ?? [])];
        await db.notes.bulkUpdate(
          deleteIds.map((id) => ({ key: id, changes: { dirty: false } })),
        );
        return { status: 'ok' };
      }

      case 'restore_note': {
        try {
          await api.restoreNote(mutation.resourceId);
        } catch (restoreErr) {
          // If the note was permanently deleted elsewhere, restoring it is
          // already impossible and retrying a 404 only spams the API every
          // drain interval. Treat this stale mutation as settled.
          const restoreE = restoreErr as Error & { status?: number };
          if (restoreE.status !== 404) throw restoreErr;
        }
        // Clear dirty on the root + all descendants.
        const restorePayload = JSON.parse(mutation.payload);
        const restoreIds: string[] = [mutation.resourceId, ...(restorePayload.descendantIds ?? [])];
        await db.notes.bulkUpdate(
          restoreIds.map((id) => ({ key: id, changes: { dirty: false } })),
        );
        return { status: 'ok' };
      }

      case 'permanent_delete_note': {
        try {
          await api.permanentDeleteNote(mutation.resourceId);
        } catch (permErr) {
          // 404 means the note was already permanently deleted (e.g.
          // the backend retention purge already ran, or a prior push
          // succeeded but the mutation wasn't deleted from the queue).
          // Treat as success — the desired end state is already true.
          const permE = permErr as Error & { status?: number };
          if (permE.status === 404) {
            return { status: 'ok' };
          }
          throw permErr;
        }
        return { status: 'ok' };
      }

      case 'upload_attachment': {
        return await pushAttachment(mutation);
      }

      default:
        return { status: 'failed', error: `Unknown mutation type: ${mutation.type}`, retryable: false };
    }
  } catch (err) {
    const e = err as Error & { status?: number; body?: { remote?: { version: number; content: string } } };

    // 409 Conflict — optimistic locking failure
    if (e.status === 409 && e.body?.remote) {
      return {
        status: 'conflict',
        remoteVersion: e.body.remote.version,
        remoteContent: e.body.remote.content,
      };
    }

    // Network error or 5xx — retryable
    const retryable = (e.status ?? 0) >= 500 ||
      e.message.toLowerCase().includes('fetch') ||
      e.message.toLowerCase().includes('network') ||
      e.message.toLowerCase().includes('timeout');
    return {
      status: 'failed',
      error: e.message,
      retryable,
    };
  }
}

/**
 * Push an attachment: presign → PUT to R2 → confirm.
 */
async function pushAttachment(mutation: PendingMutation): Promise<PushResult> {
  const payload = JSON.parse(mutation.payload);
  const att = await db.attachments.get(mutation.resourceId);
  if (!att) {
    return { status: 'failed', error: 'Attachment not found locally', retryable: false };
  }

  // 1. Get presigned PUT URL from backend
  const presign = await api.presignUpload({
    attachmentId: att.id,
    filename: att.name || 'image',
    mime: att.mime,
    sizeBytes: att.blob.size,
    noteId: payload.noteId,
  });

  // 2. PUT the blob directly to R2 (presigned URL)
  const putRes = await fetch(presign.uploadUrl, {
    method: 'PUT',
    body: att.blob,
    headers: { 'Content-Type': att.mime },
  });
  if (!putRes.ok) {
    return { status: 'failed', error: `R2 PUT failed: ${putRes.status}`, retryable: true };
  }

  // 3. Confirm upload to backend
  await api.completeUpload(presign.attachmentId);

  // 4. Update local attachment with r2Key
  await db.attachments.update(mutation.resourceId, {
    r2Key: presign.r2Key,
    syncStatus: 'synced',
  });

  return { status: 'ok' };
}

/**
 * Check if a mutation has exceeded the max attempts.
 */
export function isExhausted(mutation: PendingMutation): boolean {
  return mutation.attempts >= MAX_ATTEMPTS;
}
