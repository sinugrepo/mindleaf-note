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
import { queuedCreateNote } from './queue';
import type { Note } from '../types';

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
  await db.notes.update(remoteNote.id, {
    parentId: remoteNote.parentId,
    title: remoteNote.title,
    content: remoteNote.content,
    order: remoteNote.orderIdx,
    isExpanded: remoteNote.isExpanded,
    isFolder: remoteNote.isFolder,
    tags: remoteNote.tags,
    deletedAt: remoteNote.deletedAt,
    updatedAt: remoteNote.updatedAt,
    version: remoteNote.version,
    dirty: false,
  });
  await db.pendingMutations.delete(mutationId);
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
  await db.pendingMutations.update(mutationId, {
    baseVersion: remoteVersion,
    status: 'pending',
    attempts: 0,
    lastError: null,
  });
}

/**
 * Resolve a conflict by keeping both — create a new note with the
 * local content, then revert local to the remote version.
 *
 * The new note gets a title suffix " (conflict copy)".
 */
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
  // 1. Create a new note with the local content
  const copyNote: Note = {
    ...localNote,
    id: uuidv4(),
    title: `${localNote.title} (conflict copy)`,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  await queuedCreateNote(copyNote);

  // 2. Revert local to remote (same as resolveUseRemote)
  await resolveUseRemote(mutationId, remoteNote);
}
