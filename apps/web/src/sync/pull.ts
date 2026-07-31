/**
 * Delta-sync pull — fetch server changes and apply them to the local
 * IndexedDB cache.
 *
 * Called by the sync engine on app mount, window focus (debounced),
 * `navigator.onLine` event, and a 60-second periodic poll.
 *
 * The pull is NON-DESTRUCTIVE to local edits: notes marked `dirty=true`
 * are never overwritten by server data. The pending mutation queue
 * will push those local edits to the server, and a subsequent pull
 * will then see the updated version.
 */

import { api } from '../api/client';
import { db } from '../db/db';
import { applyServerNote, applyServerAttachment, getSyncState, setSyncState, shouldSync } from './queue';

/**
 * Pull delta from the server and apply to local cache.
 *
 * @returns The number of notes + attachments that were updated.
 */
export async function pullDelta(): Promise<{ notes: number; attachments: number }> {
  if (!shouldSync()) return { notes: 0, attachments: 0 };

  const lastSyncedAtStr = await getSyncState('lastSyncedAt');
  const lastSyncedAt = lastSyncedAtStr ? parseInt(lastSyncedAtStr, 10) : 0;

  let snapshot;
  try {
    snapshot = await api.getSyncSnapshot(lastSyncedAt);
  } catch (err) {
    // Network error / 5xx — silently skip. The periodic poll will retry.
    console.warn('[sync] pull failed:', err);
    return { notes: 0, attachments: 0 };
  }

  let notesApplied = 0;
  let attachmentsApplied = 0;

  // Apply notes
  for (const serverNote of snapshot.notes) {
    const local = await db.notes.get(serverNote.id);
    const wasDirty = local?.dirty ?? false;

    await applyServerNote(serverNote, snapshot.serverNow);

    // Count only notes that actually changed something.
    if (!local || (!wasDirty && serverNote.version > (local.version ?? 0))) {
      notesApplied++;
    }
  }

  // Apply attachments
  for (const serverAtt of snapshot.attachments) {
    await applyServerAttachment(serverAtt);
    attachmentsApplied++;
  }

  // Update lastSyncedAt
  await setSyncState('lastSyncedAt', String(snapshot.serverNow));

  return { notes: notesApplied, attachments: attachmentsApplied };
}
