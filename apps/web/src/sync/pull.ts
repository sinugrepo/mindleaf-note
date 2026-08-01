/**
 * Delta-sync pull — fetch server changes and apply them to the local
 * IndexedDB cache. Pages share a fixed server boundary, so writes racing
 * the first request are picked up on the next pull rather than skipped.
 */

import { api } from '../api/client';
import { db } from '../db/db';
import {
  applyServerNote,
  applyServerAttachment,
  applyServerTombstone,
  getSyncState,
  setSyncState,
  shouldSync,
  isSyncRecoveryRequired,
} from './queue';
import type { SyncCursor } from '@mindleaf/shared';

export async function pullDelta(): Promise<{ notes: number; attachments: number }> {
  if (!shouldSync() || await isSyncRecoveryRequired()) return { notes: 0, attachments: 0 };

  const lastSyncedAtStr = await getSyncState('lastSyncedAt');
  const lastSyncedAt = lastSyncedAtStr ? parseInt(lastSyncedAtStr, 10) : 0;
  let cursor: SyncCursor | undefined;
  let notesApplied = 0;
  let attachmentsApplied = 0;

  try {
    do {
      const snapshot = await api.getSyncSnapshot(lastSyncedAt, cursor);
      const tombstones = snapshot.tombstones ?? [];
      const hasMore = snapshot.hasMore === true;
      for (const tombstone of tombstones) {
        const applied = await applyServerTombstone(tombstone);
        if (!applied) {
          // Keep the persisted cursor unchanged until the user resolves the
          // local-vs-remote deletion. Replaying this page is safe because all
          // apply operations are idempotent/version guarded.
          throw new Error(`Sync blocked by unresolved tombstone ${tombstone.resourceId}`);
        }
      }
      for (const serverNote of snapshot.notes) {
        const local = await db.notes.get(serverNote.id);
        const wasDirty = local?.dirty ?? false;
        await applyServerNote(serverNote, snapshot.serverNow);
        if (!local || (!wasDirty && serverNote.version > (local.version ?? 0))) notesApplied++;
      }
      for (const serverAtt of snapshot.attachments) {
        await applyServerAttachment(serverAtt);
        attachmentsApplied++;
      }
      cursor = hasMore ? snapshot.nextCursor ?? undefined : undefined;
      if (!hasMore) {
        await setSyncState('lastSyncedAt', String(snapshot.serverNow));
        await setSyncState('syncRecoveryRequired', 'false');
      }
    } while (cursor);
  } catch (err) {
    const status = (err as Error & { status?: number }).status;
    if (status === 410) {
      // The server no longer retains tombstones old enough to reconcile this
      // device. Persist an explicit recovery state; never advance the cursor
      // or silently delete local data.
      await setSyncState('syncRecoveryRequired', 'true');
      console.warn('[sync] cursor expired; full recovery is required');
    } else {
      // Do not advance the persisted cursor when a page fails. The next pull
      // safely replays the already-applied page because apply operations are
      // version/idempotency guarded.
      console.warn('[sync] pull failed:', err);
    }
  }

  return { notes: notesApplied, attachments: attachmentsApplied };
}
