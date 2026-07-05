import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildNewNote,
  createRootNote,
  createRootFolder,
  createChildNote,
  createChildFolder,
  renameNote,
  softDeleteNote,
  restoreNote,
  purgeOldTrash,
  permanentlyDeleteNote,
  emptyTrash,
  isActiveNote,
  isTrashedNote,
  validateRenameTitle,
  TRASH_RETENTION_MS,
  NEW_NOTE_TITLE,
  NEW_CHILD_NOTE_TITLE,
  NEW_CHILD_TITLE,
  NEW_FOLDER_TITLE,
} from './notes';
import { db } from '../db/db';
import { Note } from '../types';

// Match the factory shape used by db.test.ts so generated fixtures stay
// interchangeable with the rest of the test suite.
function makeNote(partial: Partial<Note> = {}): Note {
  return {
    id: partial.id ?? 'fixture',
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'X',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: partial.isExpanded ?? false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  } as Note;
}

// Standard v4 UUID regex: 8-4-4-4-12 hex with a "4" version nibble and a
// variant nibble in {8,9,a,b}. Used to assert that buildNewNote hands off
// to uuidv4() correctly without leaking the actual library version.
const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

beforeEach(async () => {
  await db.notes.clear();
  await db.attachments.clear();
});

describe('buildNewNote (pure)', () => {
  it('assigns a freshly-minted v4 uuid', () => {
    const a = buildNewNote({ parentId: null });
    const b = buildNewNote({ parentId: null });
    expect(a.id).toMatch(UUID_V4_RE);
    expect(b.id).toMatch(UUID_V4_RE);
    expect(a.id).not.toBe(b.id);
  });

  it('uses "New Note" as the default title when isFolder is not set', () => {
    const note = buildNewNote({ parentId: null });
    expect(note.title).toBe(NEW_NOTE_TITLE);
  });

  it('uses "New Folder" as the default title when isFolder is true', () => {
    const note = buildNewNote({ parentId: null, isFolder: true });
    expect(note.title).toBe(NEW_FOLDER_TITLE);
  });

  it('uses overridden title verbatim, ignoring isFolder default', () => {
    const folderWithCustomTitle = buildNewNote({
      parentId: null,
      isFolder: true,
      title: 'My Important Folder',
    });
    expect(folderWithCustomTitle.title).toBe('My Important Folder');

    const noteWithCustomTitle = buildNewNote({
      parentId: 'parent-1',
      title: 'Custom heading',
    });
    expect(noteWithCustomTitle.title).toBe('Custom heading');
  });

  it('always sets isExpanded to true (so newly-added items are visible in the tree)', () => {
    const note = buildNewNote({ parentId: null });
    const folder = buildNewNote({ parentId: null, isFolder: true });
    expect(note.isExpanded).toBe(true);
    expect(folder.isExpanded).toBe(true);
  });

  it('starts with empty content', () => {
    expect(buildNewNote({ parentId: null }).content).toBe('');
    expect(buildNewNote({ parentId: null, isFolder: true }).content).toBe('');
  });

  it('propagates `now` to order, createdAt, and updatedAt simultaneously', () => {
    const now = 1_700_000_000_000;
    const note = buildNewNote({ parentId: null, now });
    expect(note.order).toBe(now);
    expect(note.createdAt).toBe(now);
    expect(note.updatedAt).toBe(now);
  });

  it('records parentId on the new note', () => {
    expect(buildNewNote({ parentId: null }).parentId).toBeNull();
    expect(buildNewNote({ parentId: 'p' }).parentId).toBe('p');
  });

  it('only sets isFolder when true (no isFolder: undefined leak)', () => {
    // Dexie + tree rendering both treat properties as absent rather than
    // explicitly `undefined`. This test guards against a refactor that
    // accidentally starts writing `isFolder: false` or `isFolder: undefined`
    // onto regular notes.
    const regular = buildNewNote({ parentId: null });
    expect('isFolder' in regular).toBe(false);

    const folder = buildNewNote({ parentId: null, isFolder: true });
    expect(folder.isFolder).toBe(true);
  });

  it('returns a structurally-valid Note (no missing required fields)', () => {
    // TypeScript already enforces this; loosely check at runtime so a
    // future JSDoc-only Note factory (e.g. one written as a JS function)
    // can't silently drop a field.
    const note = buildNewNote({ parentId: null });
    for (const key of [
      'id',
      'parentId',
      'title',
      'content',
      'order',
      'isExpanded',
      'createdAt',
      'updatedAt',
    ] as const) {
      expect(note).toHaveProperty(key);
    }
  });
});

describe('createRootNote (db-backed)', () => {
  it('persists a root note with parentId=null', async () => {
    const note = await createRootNote();
    expect(note.parentId).toBeNull();

    const fromDb = await db.notes.get(note.id);
    expect(fromDb).toBeDefined();
    expect(fromDb?.id).toBe(note.id);
    expect(fromDb?.title).toBe(NEW_NOTE_TITLE);
  });

  it('returns the same shape that buildNewNote produces', async () => {
    const persisted = await createRootNote();
    const freshShape = buildNewNote({ parentId: null });
    expect(Object.keys(persisted).sort()).toEqual(
      Object.keys(freshShape).sort(),
    );
  });

  it('respects a caller-supplied title override', async () => {
    const persisted = await createRootNote('Project Alpha');
    expect(persisted.title).toBe('Project Alpha');
  });
});

describe('createRootFolder (db-backed)', () => {
  it('persists a root folder with isFolder=true and the default folder title', async () => {
    const folder = await createRootFolder();
    expect(folder.parentId).toBeNull();
    expect(folder.isFolder).toBe(true);
    expect(folder.title).toBe(NEW_FOLDER_TITLE);

    const fromDb = await db.notes.get(folder.id);
    expect(fromDb?.isFolder).toBe(true);
  });
});

describe('createChildNote (db-backed)', () => {
  it('persists a child under `parentId` with the default "New Child" title', async () => {
    const parent = await createRootFolder();
    const child = await createChildNote(parent.id);

    expect(child.parentId).toBe(parent.id);
    expect(child.title).toBe(NEW_CHILD_TITLE);

    const fromDb = await db.notes.get(child.id);
    expect(fromDb?.parentId).toBe(parent.id);
  });

  it('expands the parent if it is currently collapsed', async () => {
    // createRootFolder sets isExpanded=true on the parent already. To test
    // the "must expand when collapsed" path, manually collapse it first.
    const parent = await createRootFolder();
    await db.notes.update(parent.id, { isExpanded: false });

    expect((await db.notes.get(parent.id))?.isExpanded).toBe(false);

    await createChildNote(parent.id);

    const after = await db.notes.get(parent.id);
    expect(after?.isExpanded).toBe(true);
  });

  it('does NOT touch the parent when it is already expanded', async () => {
    // Side-effect observation: capturing updatedAt lets us distinguish
    // "no DB write" from "DB write with no-op update".
    const parent = await createRootFolder();
    const originalUpdatedAt = parent.updatedAt;
    expect(parent.isExpanded).toBe(true);

    await createChildNote(parent.id);

    const after = await db.notes.get(parent.id);
    expect(after?.isExpanded).toBe(true);
    expect(after?.updatedAt).toBe(originalUpdatedAt);
  });

  it('respects a caller-supplied title (used by Ctrl+Shift+N via NEW_CHILD_NOTE_TITLE)', async () => {
    const parent = await createRootFolder();
    const child = await createChildNote(parent.id, NEW_CHILD_NOTE_TITLE);
    expect(child.title).toBe(NEW_CHILD_NOTE_TITLE);
  });
});

describe('createChildFolder (db-backed)', () => {
  it('persists a child folder under `parentId` with isFolder=true', async () => {
    const parent = await createRootFolder();
    const child = await createChildFolder(parent.id);

    expect(child.parentId).toBe(parent.id);
    expect(child.isFolder).toBe(true);
    expect(child.title).toBe(NEW_FOLDER_TITLE);

    const fromDb = await db.notes.get(child.id);
    expect(fromDb?.isFolder).toBe(true);
  });

  it('expands the parent if currently collapsed', async () => {
    const parent = await createRootFolder();
    await db.notes.update(parent.id, { isExpanded: false });

    await createChildFolder(parent.id);

    expect((await db.notes.get(parent.id))?.isExpanded).toBe(true);
  });
});

describe('integration: parent at depth > 0', () => {
  it('createChildNote under a grand-child-level parent works against fake-indexeddb', async () => {
    // Confirms the helper's parentId is honored verbatim, not normalized
    // to / pressed from any tree structure.
    const grand = await createRootNote('Grand');
    const middle = await createChildNote(grand.id, 'Middle');
    // `middle` is already expanded by createChildNote; no further update
    // needed before adding the leaf.
    const leaf = await createChildNote(middle.id, 'Leaf');

    const fromDb = await db.notes.get(leaf.id);
    expect(fromDb?.parentId).toBe(middle.id);
    expect(fromDb?.title).toBe('Leaf');
  });
});

describe('predicates: isActiveNote / isTrashedNote', () => {
  it('isActiveNote matches both undefined and null deletedAt (legacy + new notes)', () => {
    // Loose equality (`== null`) is intentional: pre-trash notes never
    // had the field written, so they read as `undefined`; new notes
    // explicitly use `null`. Both must count as active.
    expect(isActiveNote({ deletedAt: null } as Note)).toBe(true);
    expect(isActiveNote({} as Note)).toBe(true);
    expect(isActiveNote({ deletedAt: undefined } as Note)).toBe(true);
  });

  it('isActiveNote rejects numeric deletedAt', () => {
    expect(isActiveNote({ deletedAt: 0 } as Note)).toBe(false);
    expect(isActiveNote({ deletedAt: 1_700_000_000_000 } as Note)).toBe(false);
  });

  it('isTrashedNote is the negation of isActiveNote', () => {
    expect(isTrashedNote({ deletedAt: 1_700_000_000_000 } as Note)).toBe(true);
    expect(isTrashedNote({} as Note)).toBe(false);
    expect(isTrashedNote({ deletedAt: null } as Note)).toBe(false);
  });
});

describe('softDeleteNote', () => {
  it('stamps deletedAt on the target root note', async () => {
    const note = await createRootNote('alpha');
    const now = 1_700_000_000_000;
    const ids = await softDeleteNote(note.id, now);
    expect(ids).toEqual([note.id]);
    const row = await db.notes.get(note.id);
    expect(row?.deletedAt).toBe(now);
  });

  it('recursively stamps deletedAt on descendants', async () => {
    const root = await createRootNote('root');
    const child = await createChildNote(root.id, 'child');
    const grandchild = await createChildNote(child.id, 'grand');
    const now = 1_700_000_000_000;
    await softDeleteNote(root.id, now);

    expect((await db.notes.get(root.id))?.deletedAt).toBe(now);
    expect((await db.notes.get(child.id))?.deletedAt).toBe(now);
    expect((await db.notes.get(grandchild.id))?.deletedAt).toBe(now);
  });

  it('is idempotent: a second delete refreshes the timestamp', async () => {
    const note = await createRootNote();
    await softDeleteNote(note.id, 1000);
    await softDeleteNote(note.id, 2000);
    expect((await db.notes.get(note.id))?.deletedAt).toBe(2000);
  });

  it('does not cascade to unrelated notes', async () => {
    const untouched = await createRootNote('untouched');
    const target = await createRootNote('target');
    await softDeleteNote(target.id, 5000);
    expect((await db.notes.get(untouched.id))?.deletedAt).toBeFalsy();
  });
});

describe('restoreNote', () => {
  it('clears deletedAt on the target', async () => {
    const note = await createRootNote('beta');
    await softDeleteNote(note.id, 1000);
    await restoreNote(note.id);
    expect((await db.notes.get(note.id))?.deletedAt).toBeNull();
  });

  it('clears deletedAt recursively on descendants', async () => {
    const root = await createRootNote('root');
    const child = await createChildNote(root.id, 'child');
    await softDeleteNote(root.id, 1000);
    await restoreNote(root.id);
    expect((await db.notes.get(root.id))?.deletedAt).toBeNull();
    expect((await db.notes.get(child.id))?.deletedAt).toBeNull();
  });

  it('is a no-op on already-active notes (returns [])', async () => {
    const note = await createRootNote();
    const touched = await restoreNote(note.id);
    expect(touched).toEqual([]);
    expect((await db.notes.get(note.id))?.deletedAt).toBeFalsy();
  });

  it('only restores rows still marked trashed (idempotent on partial restores)', async () => {
    const root = await createRootNote();
    const child = await createChildNote(root.id);
    await softDeleteNote(root.id, 1000);
    // Manually clear child to simulate a partial earlier restore — restore
    // of root should not "re-clear" or revisit the now-active child.
    await db.notes.update(child.id, { deletedAt: null });
    const touched = await restoreNote(root.id);
    expect(touched).toEqual([root.id]);
  });
});

describe('purgeOldTrash', () => {
  it('deletes notes whose deletedAt is older than TRASH_RETENTION_MS', async () => {
    const note = await createRootNote();
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await softDeleteNote(note.id, thirtyOneDaysAgo);

    const purged = await purgeOldTrash();
    expect(purged).toBe(1);
    expect(await db.notes.get(note.id)).toBeUndefined();
  });

  it('keeps notes still within the retention window', async () => {
    const note = await createRootNote();
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    await softDeleteNote(note.id, oneDayAgo);

    const purged = await purgeOldTrash();
    expect(purged).toBe(0);
    expect(await db.notes.get(note.id)).toBeDefined();
  });

  it('cascades attachment deletion for purged notes', async () => {
    const note = await createRootNote('cascade-test');
    await db.attachments.add({
      id: 'att-cascade',
      noteId: note.id,
      blob: new Blob(['x'], { type: 'image/png' }),
      mime: 'image/png',
      name: 'pic.png',
      createdAt: 0,
    });
    const oldEnough = Date.now() - (TRASH_RETENTION_MS + 24 * 60 * 60 * 1000);
    await softDeleteNote(note.id, oldEnough);

    await purgeOldTrash();
    expect(await db.attachments.get('att-cascade')).toBeUndefined();
  });

  it('never touches active notes or fresh-trash notes', async () => {
    const active = await createRootNote('keep-active');
    const freshTrash = await createRootNote('keep-trashed');
    await softDeleteNote(freshTrash.id, Date.now() - 1000);

    await purgeOldTrash();
    expect(await db.notes.get(active.id)).toBeDefined();
    expect(await db.notes.get(freshTrash.id)).toBeDefined();
  });
});

describe('permanentlyDeleteNote', () => {
  it('hard-deletes the target note and its descendants', async () => {
    const root = await createRootNote();
    const child = await createChildNote(root.id);
    const grand = await createChildNote(child.id);
    await softDeleteNote(root.id, 1000);
    const purged = await permanentlyDeleteNote(root.id);
    expect(purged).toBe(3);
    expect(await db.notes.get(root.id)).toBeUndefined();
    expect(await db.notes.get(child.id)).toBeUndefined();
    expect(await db.notes.get(grand.id)).toBeUndefined();
  });

  it('cascades attachment deletion', async () => {
    const note = await createRootNote('purge-with-att');
    await db.attachments.add({
      id: 'att-purge',
      noteId: note.id,
      blob: new Blob(['y'], { type: 'image/png' }),
      mime: 'image/png',
      name: '',
      createdAt: 0,
    });
    await softDeleteNote(note.id, 1000);
    await permanentlyDeleteNote(note.id);
    expect(await db.attachments.get('att-purge')).toBeUndefined();
  });

  it('REFUSES to permanently-delete an active note (defensive guard)', async () => {
    const note = await createRootNote('do-not-delete');
    await expect(permanentlyDeleteNote(note.id)).rejects.toThrow(
      /refusing to delete active note/i,
    );
    // Critical: the note must still be intact after the rejected call.
    expect(await db.notes.get(note.id)).toBeDefined();
  });

  it('returns 0 for an unknown noteId (no throw, no rows touched)', async () => {
    expect(await permanentlyDeleteNote('does-not-exist')).toBe(0);
  });
});

describe('emptyTrash', () => {
  it('removes ALL trashed notes regardless of age', async () => {
    const note = await createRootNote('recent-trashed');
    await softDeleteNote(note.id, 1000); // recent
    const purged = await emptyTrash();
    expect(purged).toBe(1);
    expect(await db.notes.get(note.id)).toBeUndefined();
  });

  it('does NOT touch active notes', async () => {
    const active = await createRootNote('active-keep');
    const trashed = await createRootNote('trashed-gone');
    await softDeleteNote(trashed.id, 1000);
    await emptyTrash();
    expect(await db.notes.get(active.id)).toBeDefined();
    expect(await db.notes.get(trashed.id)).toBeUndefined();
  });

  it('returns 0 when trash is empty (idempotent)', async () => {
    await createRootNote('untouched');
    expect(await emptyTrash()).toBe(0);
  });
});

describe('validateRenameTitle (pure)', () => {
  it('accepts a non-empty, different title', () => {
    const res = validateRenameTitle('New Heading', 'Old Heading');
    expect(res.valid).toBe(true);
    expect(res.title).toBe('New Heading');
  });

  it('trims whitespace before accepting', () => {
    const res = validateRenameTitle('  Trimmed  ', 'old');
    expect(res.valid).toBe(true);
    expect(res.title).toBe('Trimmed');
  });

  it('rejects empty input', () => {
    const res = validateRenameTitle('', 'old');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('empty-or-whitespace');
  });

  it('rejects whitespace-only input', () => {
    const res = validateRenameTitle('   \t\n', 'old');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('empty-or-whitespace');
  });

  it('rejects input that matches current title (after trim)', () => {
    // Distinct reason — UI may want to show a different message
    // ("nothing to save") vs. empty-rejection ("required").
    const res = validateRenameTitle('  Same  ', 'Same');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('unchanged');
  });

  it('treats whitespace-trimmed-equal inputs as unchanged', () => {
    const res = validateRenameTitle('A', '  A  ');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('unchanged');
  });

  it('survives null/undefined raw input without throwing', () => {
    // Defensive: callers passing through form-binder states may hand
    // in null. The function should reject, not crash.
    const res = validateRenameTitle(null as unknown as string, 'old');
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('empty-or-whitespace');
  });
});

describe('renameNote (db-backed)', () => {
  it('overwrites the title on a root note', async () => {
    const note = await createRootNote('Original');
    await renameNote(note.id, 'Updated', 1_700_000_000_000);
    const row = await db.notes.get(note.id);
    expect(row?.title).toBe('Updated');
  });

  it('refreshes updatedAt on rename', async () => {
    // Pin both the old and new timestamps so the assertion is
    // deterministic against the default Date.now() monkey-patch that
    // vitest uses for fakes.
    const note = await createRootNote('Original');
    await db.notes.update(note.id, { updatedAt: 1_000 });
    await renameNote(note.id, 'Updated', 2_000);
    const row = await db.notes.get(note.id);
    expect(row?.updatedAt).toBe(2_000);
  });

  it('trims the title before persisting (no leading/trailing whitespace stored)', async () => {
    const note = await createRootNote('Original');
    await renameNote(note.id, '  Spaced  ');
    const row = await db.notes.get(note.id);
    expect(row?.title).toBe('Spaced');
  });

  it('throws on empty title without writing', async () => {
    const note = await createRootNote('Original');
    const original = await db.notes.get(note.id);
    await expect(renameNote(note.id, '   ')).rejects.toThrow(/empty/i);
    // Important: NOTHING changed in the row after the rejected call.
    const after = await db.notes.get(note.id);
    expect(after?.title).toBe(original?.title);
    expect(after?.updatedAt).toBe(original?.updatedAt);
  });

  it('throws when the note id does not exist', async () => {
    await expect(renameNote('ghost-id', 'whatever')).rejects.toThrow(
      /not found/i,
    );
  });

  it('renames a folder without losing its isFolder flag', async () => {
    const folder = await createRootFolder();
    await renameNote(folder.id, 'Renamed Folder');
    const row = await db.notes.get(folder.id);
    expect(row?.isFolder).toBe(true);
    expect(row?.title).toBe('Renamed Folder');
  });

  it('returns the trimmed title it just wrote', async () => {
    const note = await createRootNote('X');
    const returned = await renameNote(note.id, '  final  ');
    expect(returned).toBe('final');
  });

  it('renames a child note under a folder', async () => {
    const parent = await createRootFolder();
    const child = await createChildNote(parent.id, 'Child Original');
    await renameNote(child.id, 'Child Renamed');
    const row = await db.notes.get(child.id);
    expect(row?.title).toBe('Child Renamed');
    // Parent is unchanged (parent-id graph is preserved).
    const parentRow = await db.notes.get(parent.id);
    expect(parentRow?.title).toBe(NEW_FOLDER_TITLE);
  });
});

describe('trash round-trip (export -> import integration)', () => {
  // Integration-style coverage for the documented contract on
  // notes-io.ts: backup files DO NOT carry `deletedAt` and that dropped
  // state is intentional ("import == restore everything"). We round-trip
  // through `parseImportedNotes`/`parseImportedBackup` to assert the
  // contract without dragging the file/IO layer into a vitest unit test.
  it('parseImportedNotes drops deletedAt so imported backups always restore as active', async () => {
    const { parseImportedNotes } = await import('./notes-io');
    const fixedNow = 1_700_000_000_000;
    const trashedBackup = [
      {
        id: 'n1',
        parentId: null,
        title: 'trashed one',
        content: '',
        order: 1,
        isExpanded: false,
        createdAt: 0,
        updatedAt: 0,
        deletedAt: fixedNow,
      },
    ];
    const result = parseImportedNotes(trashedBackup);
    expect(result).toHaveLength(1);
    // `deletedAt` is intentionally stripped on import; this is the
    // documented contract — if you change it, also revisit the Sidebar
    // prompt so users opt-in to "import everything (incl. trash)".
    expect(result[0].deletedAt).toBeUndefined();
    expect(isActiveNote(result[0])).toBe(true);
  });
});
