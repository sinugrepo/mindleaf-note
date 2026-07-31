import { v4 as uuidv4 } from 'uuid';
import { Note } from '../types';
import { db } from '../db/db';
import { collectDescendants } from './tree-ops';
import {
  queuedCreateNote,
  queuedPatchNote,
  queuedDeleteNote,
  queuedRestoreNote,
  queuedPermanentDeleteNote,
  queuedImportNotes,
} from '../sync/queue';

/**
 * Default titles match the existing inline strings used at each call site.
 * Keep these in lock-step with the UI to avoid unintended user-visible
 * renames during the refactor.
 */
export const NEW_NOTE_TITLE = 'New Note';
export const NEW_CHILD_NOTE_TITLE = 'New Child Note';
export const NEW_CHILD_TITLE = 'New Child';
export const NEW_FOLDER_TITLE = 'New Folder';

/**
 * How long a soft-deleted note lives in the Trash before auto-purge
 * runs at app start. 30 days mirrors the typical UX in mail apps and
 * most outliner tools.
 */
export const TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface CreateNoteOptions {
  parentId: string | null;
  /** Override the title; defaults depend on isFolder. */
  title?: string;
  isFolder?: boolean;
  /** Override timestamp; defaults to Date.now(). Useful for tests. */
  now?: number;
}

/**
 * Build a fresh Note object with all default fields populated.
 * Pure — does NOT touch the database. Use the `create*` helpers below
 * if you also want to persist the note.
 */
export function buildNewNote(opts: CreateNoteOptions): Note {
  const now = opts.now ?? Date.now();
  const note: Note = {
    id: uuidv4(),
    parentId: opts.parentId,
    title: opts.title ?? (opts.isFolder ? NEW_FOLDER_TITLE : NEW_NOTE_TITLE),
    content: '',
    order: now,
    isExpanded: true,
    createdAt: now,
    updatedAt: now,
  };
  // `isFolder` is optional on `Note`; only set when true so we don't
  // accidentally store `isFolder: undefined` (which Dexie treats as the
  // field being absent and is the convention this codebase uses).
  if (opts.isFolder) {
    note.isFolder = true;
  }
  return note;
}

/**
 * Expand `parentId` if it currently exists and is collapsed, so the new
 * child note is visible in the tree immediately after creation.
 */
async function expandIfCollapsed(parentId: string): Promise<void> {
  const parent = await db.notes.get(parentId);
  if (parent && !parent.isExpanded) {
    await queuedPatchNote(parentId, { isExpanded: true });
  }
}

/**
 * Create a new root-level note and persist it. Returns the created note.
 * Routes through the sync queue so a `create_note` mutation is enqueued.
 */
export async function createRootNote(
  title: string = NEW_NOTE_TITLE,
): Promise<Note> {
  const note = buildNewNote({ parentId: null, title });
  return queuedCreateNote(note);
}

/**
 * Create a new root-level folder and persist it. Returns the created note.
 * Routes through the sync queue.
 */
export async function createRootFolder(): Promise<Note> {
  const note = buildNewNote({ parentId: null, isFolder: true });
  return queuedCreateNote(note);
}

/**
 * Create a note under `parentId`. Expands the parent if currently collapsed.
 * Returns the created note. Routes through the sync queue.
 */
export async function createChildNote(
  parentId: string,
  title: string = NEW_CHILD_TITLE,
): Promise<Note> {
  await expandIfCollapsed(parentId);
  const note = buildNewNote({ parentId, title });
  return queuedCreateNote(note);
}

/**
 * Create a folder under `parentId`. Expands the parent if currently collapsed.
 * Returns the created note. Routes through the sync queue.
 */
export async function createChildFolder(parentId: string): Promise<Note> {
  await expandIfCollapsed(parentId);
  const note = buildNewNote({ parentId, isFolder: true });
  return queuedCreateNote(note);
}

// ---------------------------------------------------------------------------
// Rename helpers
// ---------------------------------------------------------------------------
//
// Renaming a note/folder is just a `title` overwrite + `updatedAt`
// refresh. Wikilinks store the target note id (not the title) in the
// rendered HTML — see lib/wikilink.ts (`WIKILINK_ID_ATTR`) — so renaming
// does NOT break any existing `[[…]]` link. The BacklinksPanel and the
// `[[Note Title]]` autocomplete re-read the live note list on every
// tick, so they pick up the new title without any extra plumbing.

/**
 * Validation result for a rename attempt. Pure decision so the UI can
 * mirror the same rules as the db wrapper and surface errors without
 * having to catch exceptions.
 */
export interface RenameValidation {
  valid: boolean;
  /**
   * Trimmed canonical title to persist. Always present so callers can
   * `notes.update(id, { title: result.title })` without branching — when
   * `valid` is false, `title` falls back to the input (or empty string if
   * no input) so a stray persist never accidentally un-renames a note.
   */
  title: string;
  reason?: 'empty-or-whitespace' | 'unchanged';
}

/**
 * Decide whether `rawNewTitle` is acceptable as the replacement for an
 * existing note's title. Pure & sync so the modal can validate without
 * a round-trip.
 *
 * Rules:
 *  - Empty / whitespace-only -> invalid, reason `empty-or-whitespace`.
 *    The UI uses this to disable the Save button (visible affordance)
 *    rather than blocking on submit.
 *  - Identical to the current `oldTitle` (after trim) -> invalid, reason
 *    `unchanged`. Avoids a no-op DB write that would still bump
 *    `updatedAt` and trick `updatedAt` sort into re-ordering the row
 *    for no reason.
 *  - Otherwise -> valid; `title` is the trimmed form (so subsequent
 *    reads are consistent with what was written).
 */
export function validateRenameTitle(
  rawNewTitle: string,
  oldTitle: string,
): RenameValidation {
  const trimmed = (rawNewTitle ?? '').trim();
  if (trimmed.length === 0) {
    return {
      valid: false,
      reason: 'empty-or-whitespace',
      title: rawNewTitle ?? '',
    };
  }
  if (trimmed === oldTitle.trim()) {
    return { valid: false, reason: 'unchanged', title: trimmed };
  }
  return { valid: true, title: trimmed };
}

/**
 * Persist a rename for `noteId`. Updates `title` AND `updatedAt` in a
 * single write so the `updatedAt` sort mode reorders the row
 * immediately (the sort comparator in lib/tags.ts compares by
 * `updatedAt` decreasing).
 *
 * Returns the trimmed title that was written on success. Throws when the
 * note no longer exists — defensive against a stale modal that was open
 * against an already-deleted row (the Trash flow would have hidden the
 * editor, but a stray rename modal could still race). Callers don't
 * need to catch; surfacing the error to the console matches the rest of
 * the codebase's db write log convention.
 *
 * `now` is exposed for tests so the test suite can pin the timestamp
 * without monkey-patching `Date.now`. Production callers omit it and
 * get the current time.
 */
export async function renameNote(
  noteId: string,
  rawNewTitle: string,
  now: number = Date.now(),
): Promise<string> {
  const trimmed = (rawNewTitle ?? '').trim();
  if (trimmed.length === 0) {
    throw new Error(
      `renameNote: refusing to rename note "${noteId}" to an empty title.`,
    );
  }
  const existing = await db.notes.get(noteId);
  if (!existing) {
    throw new Error(
      `renameNote: note "${noteId}" not found (was it deleted while the rename modal was open?).`,
    );
  }
  await queuedPatchNote(noteId, { title: trimmed }, now);
  return trimmed;
}

// ---------------------------------------------------------------------------
// Trash / Recycle Bin helpers
// ---------------------------------------------------------------------------
//
// Soft-delete model: `note.deletedAt` is a timestamp; `null`/missing means
// active. We never hard-delete from soft-delete paths because the whole
// point is to give the user a recovery window. `purgeOldTrash` is the
// single hard-delete entry point and is gated on age (default 30 days).

/**
 * Filter predicate: only active notes (not soft-deleted). Loose equality
 * (`== null`) so legacy notes whose `deletedAt` is undefined also pass.
 */
export const isActiveNote = (n: Note): boolean => n.deletedAt == null;

/**
 * Filter predicate: only soft-deleted notes.
 */
export const isTrashedNote = (n: Note): boolean => n.deletedAt != null;

/**
 * Soft-delete a note and all its descendants. Routes through the sync
 * queue so a `delete_note` mutation is enqueued for the backend (which
 * also cascades via recursive CTE).
 *
 * Returns the list of ids that were updated.
 */
export async function softDeleteNote(
  noteId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const allNotes = await db.notes.toArray();
  const descendants = collectDescendants(allNotes, noteId);
  await queuedDeleteNote(noteId, descendants, now);
  return [...descendants, noteId];
}

/**
 * Restore a soft-deleted note (and its descendants) from trash.
 * Routes through the sync queue.
 *
 * Returns the list of ids whose `deletedAt` was actually cleared.
 */
export async function restoreNote(
  noteId: string,
  now: number = Date.now(),
): Promise<string[]> {
  const allNotes = await db.notes.toArray();
  const descendants = collectDescendants(allNotes, noteId);
  const candidates = [...descendants, noteId];
  const trashedIds = candidates.filter(
    (id) => allNotes.find((n) => n.id === id)?.deletedAt != null,
  );
  if (trashedIds.length === 0) return [];
  await queuedRestoreNote(noteId, descendants, now);
  return trashedIds;
}

/**
 * Hard-delete trash items older than the retention window. Cascade-deletes
 * attachments that belonged ONLY to those purged notes. Runs at app
 * start (fire-and-forget). This is a LOCAL-ONLY operation — the backend
 * has its own retention policy via the sync layer.
 *
 * Returns the count of notes purged.
 */
export async function purgeOldTrash(now: number = Date.now()): Promise<number> {
  const cutoff = now - TRASH_RETENTION_MS;
  const all = await db.notes.toArray();
  const toPurge = all.filter(
    (n) => n.deletedAt != null && (n.deletedAt as number) < cutoff,
  );
  if (toPurge.length === 0) return 0;
  await cascadingDeleteNotes(toPurge.map((n) => n.id));
  return toPurge.length;
}

/**
 * Permanently delete a single trash item and its descendants. Routes
 * through the sync queue so a `permanent_delete_note` mutation is
 * enqueued for the backend.
 *
 * Returns the number of notes hard-deleted.
 */
export async function permanentlyDeleteNote(noteId: string): Promise<number> {
  const target = await db.notes.get(noteId);
  if (!target) return 0;
  if (isActiveNote(target)) {
    throw new Error(
      `permanentlyDeleteNote: note "${noteId}" is not in Trash — refusing to delete active note.`,
    );
  }
  const allNotes = await db.notes.toArray();
  const descendants = collectDescendants(allNotes, noteId);
  const targetIds = [noteId, ...descendants];
  await queuedPermanentDeleteNote(noteId, descendants);
  return targetIds.length;
}

/**
 * Empty the trash: permanently delete every soft-deleted note (and their
 * attachment rows). Routes each root trashed note through the sync queue
 * so a `permanent_delete_note` mutation is enqueued for the backend.
 *
 * We find top-level trashed notes (notes whose parent is NOT itself
 * trashed) so we enqueue one permanent-delete per subtree root — the
 * backend cascades descendants. Non-root trashed notes are handled by
 * their parent's cascade.
 *
 * Returns the number of notes scheduled for permanent deletion.
 */
export async function emptyTrash(): Promise<number> {
  const all = await db.notes.toArray();
  const trashedNotes = all.filter(isTrashedNote);
  if (trashedNotes.length === 0) return 0;

  // Find root trashed notes: a trashed note whose parent is either
  // null (root-level) or not itself trashed.
  const trashedIds = new Set(trashedNotes.map((n) => n.id));
  const rootTrashed = trashedNotes.filter(
    (n) => n.parentId == null || !trashedIds.has(n.parentId),
  );

  // Enqueue permanent-delete for each root trashed note.
  for (const note of rootTrashed) {
    const descendants = collectDescendants(all, note.id).filter((id) =>
      trashedIds.has(id),
    );
    await queuedPermanentDeleteNote(note.id, descendants);
  }

  return trashedNotes.length;
}

/**
 * Re-export queuedImportNotes so components can import everything
 * from a single module (notes.ts) without reaching into sync/queue
 * directly. Used by Sidebar's import handler.
 */
export { queuedImportNotes } from '../sync/queue';

/**
 * Cascading-delete helper: hard-delete `noteIds` from the notes table
 * AND every attachment whose `noteId` belongs to that set. Used by
 * purgeOldTrash (local-only retention cleanup) so the cascade
 * invariant is DRY-ed up in one place.
 *
 * Run as a single read-write transaction across `notes` and
 * `attachments` so the two deletes are atomic — if the second op
 * throws, the first op rolls back rather than leaving orphan
 * attachment rows around that have to be cleaned by gcAttachments
 * anyway. The orphan attachment ids are also returned for logging /
 * tests, not because the caller needs to re-do anything.
 *
 * Returns the list of attachment ids that were cascade-deleted.
 */
async function cascadingDeleteNotes(
  noteIds: readonly string[],
): Promise<string[]> {
  if (noteIds.length === 0) return [];
  const idSet = new Set(noteIds);
  return db.transaction(
    'rw',
    db.notes,
    db.attachments,
    async () => {
      const attachments = await db.attachments.toArray();
      const orphanAttachmentIds = attachments
        .filter((a) => idSet.has(a.noteId))
        .map((a) => a.id);
      if (orphanAttachmentIds.length > 0) {
        await db.attachments.bulkDelete(orphanAttachmentIds);
      }
      await db.notes.bulkDelete([...noteIds]);
      return orphanAttachmentIds;
    },
  );
}
