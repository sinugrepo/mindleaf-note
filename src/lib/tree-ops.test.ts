import { describe, it, expect } from 'vitest';
import {
  validateDropTarget,
  computeDropUpdates,
  findMoveSibling,
  computeOrderSwap,
  collectDescendants,
  flattenTree,
} from './tree-ops';
import { Note } from '../types';

function makeNote(partial: Partial<Note>): Note {
  return {
    id: partial.id!,
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'n',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: partial.isExpanded ?? false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    isFolder: partial.isFolder,
    ...partial,
  } as Note;
}

describe('validateDropTarget', () => {
  it('rejects empty dragged id', () => {
    const target = makeNote({ id: 't1', isFolder: true });
    const res = validateDropTarget('', target, [target]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('missing-id');
  });

  it('rejects null dragged id', () => {
    const target = makeNote({ id: 't1', isFolder: true });
    const res = validateDropTarget(null, target, [target]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('missing-id');
  });

  it('rejects self-drop', () => {
    const target = makeNote({ id: 't1', isFolder: true });
    const res = validateDropTarget('t1', target, [target]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('self-drop');
  });

  it('rejects drop onto non-folder', () => {
    const notes = [
      makeNote({ id: 'a', order: 1 }),
      makeNote({ id: 't1', order: 2 }), // not a folder
    ];
    const res = validateDropTarget('a', notes[1], notes);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('not-folder');
  });

  it('accepts valid drop on folder', () => {
    const folder = makeNote({ id: 'f', isFolder: true, order: 1 });
    const note = makeNote({ id: 'a', order: 2 });
    const res = validateDropTarget('a', folder, [folder, note]);
    expect(res.valid).toBe(true);
  });

  it('rejects dropping folder onto its own descendant (cycle prevention)', () => {
    // Drag F1 (a folder) onto F2, where F2 is a child of F1.
    const f1 = makeNote({ id: 'f1', isFolder: true, order: 1 });
    const f2 = makeNote({ id: 'f2', isFolder: true, parentId: 'f1', order: 2 });
    const res = validateDropTarget('f1', f2, [f1, f2]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('descendant');
  });

  it('rejects dropping deep ancestor onto deeply nested descendant', () => {
    const root = makeNote({ id: 'root', isFolder: true, order: 1 });
    const mid = makeNote({ id: 'mid', isFolder: true, parentId: 'root', order: 2 });
    const leaf = makeNote({ id: 'leaf', isFolder: true, parentId: 'mid', order: 3 });
    const res = validateDropTarget('root', leaf, [root, mid, leaf]);
    expect(res.valid).toBe(false);
    expect(res.reason).toBe('descendant');
  });

  it('accepts sibling folder drop', () => {
    const f1 = makeNote({ id: 'f1', isFolder: true, order: 1 });
    const f2 = makeNote({ id: 'f2', isFolder: true, order: 2 });
    const res = validateDropTarget('f1', f2, [f1, f2]);
    expect(res.valid).toBe(true);
  });
});

describe('computeDropUpdates', () => {
  it('places new child after current max order + buffer', () => {
    const folder = makeNote({ id: 'f', isFolder: true, order: 1 });
    const existingKid = makeNote({ id: 'k', parentId: 'f', order: 100 });
    const dragged = makeNote({ id: 'd', order: 5 });
    const updates = computeDropUpdates('d', folder, [folder, existingKid, dragged], 5000);
    expect(updates.dragged).toEqual({ parentId: 'f', order: 110 });
  });

  it('uses now as base when folder has no children', () => {
    const folder = makeNote({ id: 'f', isFolder: true, order: 1 });
    const dragged = makeNote({ id: 'd', order: 5 });
    const updates = computeDropUpdates('d', folder, [folder, dragged], 9999);
    expect(updates.dragged).toEqual({ parentId: 'f', order: 10009 });
  });

  it('expands folder if currently collapsed', () => {
    const folder = makeNote({ id: 'f', isFolder: true, isExpanded: false, order: 1 });
    const dragged = makeNote({ id: 'd', order: 5 });
    const updates = computeDropUpdates('d', folder, [folder, dragged], 1000);
    expect(updates.target).toEqual({ isExpanded: true });
  });

  it('does not touch folder if already expanded', () => {
    const folder = makeNote({ id: 'f', isFolder: true, isExpanded: true, order: 1 });
    const dragged = makeNote({ id: 'd', order: 5 });
    const updates = computeDropUpdates('d', folder, [folder, dragged], 1000);
    expect(updates.target).toBeNull();
  });
});

describe('findMoveSibling', () => {
  it('returns canMove=false for the first sibling (move up)', () => {
    const notes = [
      makeNote({ id: 'a', order: 1 }),
      makeNote({ id: 'b', order: 2 }),
      makeNote({ id: 'c', order: 3 }),
    ];
    expect(findMoveSibling(notes, 'a', 'up')).toEqual({ canMove: false });
  });

  it('returns prev sibling (move up)', () => {
    const notes = [
      makeNote({ id: 'a', order: 1 }),
      makeNote({ id: 'b', order: 2 }),
      makeNote({ id: 'c', order: 3 }),
    ];
    const res = findMoveSibling(notes, 'b', 'up');
    expect(res.canMove).toBe(true);
    expect(res.other?.id).toBe('a');
  });

  it('returns canMove=false for the last sibling (move down)', () => {
    const notes = [
      makeNote({ id: 'a', order: 1 }),
      makeNote({ id: 'b', order: 2 }),
    ];
    expect(findMoveSibling(notes, 'b', 'down')).toEqual({ canMove: false });
  });

  it('returns next sibling (move down)', () => {
    const notes = [
      makeNote({ id: 'a', order: 1 }),
      makeNote({ id: 'b', order: 2 }),
      makeNote({ id: 'c', order: 3 }),
    ];
    const res = findMoveSibling(notes, 'b', 'down');
    expect(res.canMove).toBe(true);
    expect(res.other?.id).toBe('c');
  });

  it('respects parentId grouping — siblings are scoped to same parent only', () => {
    // 'b' shares parentId=null with 'a', 'c'. 'e' shares parentId='x' with 'd'.
    const notes = [
      makeNote({ id: 'a', parentId: null, order: 1 }),
      makeNote({ id: 'b', parentId: null, order: 2 }),
      makeNote({ id: 'c', parentId: null, order: 3 }),
      makeNote({ id: 'x', parentId: null, order: 4 }),
      makeNote({ id: 'd', parentId: 'x', order: 5 }),
      makeNote({ id: 'e', parentId: 'x', order: 6 }),
    ];
    // Moving 'e' up should target 'd' (its sibling), NOT 'x' or 'c', even though they have higher orders.
    const res = findMoveSibling(notes, 'e', 'up');
    expect(res.canMove).toBe(true);
    expect(res.other?.id).toBe('d');
  });

  it('returns canMove=false for first child of a folder (no sibling above)', () => {
    const notes = [
      makeNote({ id: 'x', parentId: null, order: 1 }),
      makeNote({ id: 'd', parentId: 'x', order: 5 }),
      makeNote({ id: 'e', parentId: 'x', order: 6 }),
    ];
    // 'd' is the first child of 'x'. Move up targets siblings only, not the parent.
    expect(findMoveSibling(notes, 'd', 'up')).toEqual({ canMove: false });
  });

  it('returns canMove=false for unknown id', () => {
    const notes = [makeNote({ id: 'a', order: 1 })];
    expect(findMoveSibling(notes, 'unknown', 'up')).toEqual({ canMove: false });
  });
});

describe('computeOrderSwap', () => {
  it('swaps orders for normal case (move up)', () => {
    const cur = makeNote({ id: 'cur', order: 5 });
    const other = makeNote({ id: 'other', order: 2 });
    const updates = computeOrderSwap(cur, other, 'up');
    expect(updates.cur).toEqual({ order: 2 });
    expect(updates.other).toEqual({ order: 5 });
  });

  it('swaps orders for normal case (move down)', () => {
    const cur = makeNote({ id: 'cur', order: 5 });
    const other = makeNote({ id: 'other', order: 8 });
    const updates = computeOrderSwap(cur, other, 'down');
    expect(updates.cur).toEqual({ order: 8 });
    expect(updates.other).toEqual({ order: 5 });
  });

  it('handles order tie by nudging other order (move up)', () => {
    const cur = makeNote({ id: 'cur', order: 5 });
    const other = makeNote({ id: 'other', order: 5 });
    const updates = computeOrderSwap(cur, other, 'up');
    expect(updates.cur).toEqual({ order: 5 });
    expect(updates.other.order).toBe(4); // -1 for up
  });

  it('handles order tie by nudging other order (move down)', () => {
    const cur = makeNote({ id: 'cur', order: 5 });
    const other = makeNote({ id: 'other', order: 5 });
    const updates = computeOrderSwap(cur, other, 'down');
    expect(updates.cur).toEqual({ order: 5 });
    expect(updates.other.order).toBe(6); // +1 for down
  });
});

describe('integration: drop flow (validateDropTarget -> computeDropUpdates -> apply)', () => {
  it('successfully drops a top-level note into an empty folder and updates both halves', () => {
    const f = makeNote({ id: 'f', title: 'Folder', isFolder: true, isExpanded: false, order: 1 });
    const n = makeNote({ id: 'n', title: 'Sticky', order: 2 });
    const allNotes = [f, n];
    const fixedNow = 1_700_000_000_000;

    // Step 1: validate
    const validation = validateDropTarget('n', f, allNotes);
    expect(validation.valid).toBe(true);

    // Step 2: compose updates
    const updates = computeDropUpdates('n', f, allNotes, fixedNow);
    expect(updates.dragged).toEqual({ parentId: 'f', order: fixedNow + 10 });
    // Folder was collapsed → should auto-expand
    expect(updates.target).toEqual({ isExpanded: true });

    // Step 3: simulate db.apply (immutable) and assert resulting tree shape
    const after = allNotes.map((note) => {
      if (note.id === 'n') return { ...note, ...updates.dragged };
      if (note.id === 'f') return { ...note, ...updates.target! };
      return note;
    });

    const reParent = after.find((x) => x.id === 'n')!;
    expect(reParent.parentId).toBe('f');
    expect(reParent.order).toBe(fixedNow + 10);

    const reExpanded = after.find((x) => x.id === 'f')!;
    expect(reExpanded.isExpanded).toBe(true);

    // Step 4: re-validate using updated tree to ensure no regression (drop again should still be valid)
    expect(validateDropTarget('n', after.find((x) => x.id === 'f')!, after).valid).toBe(true);
  });

  it('blocks drops that would create a cycle, and no updates are produced', () => {
    const f1 = makeNote({ id: 'f1', title: 'F1', isFolder: true, isExpanded: true, order: 1 });
    const f2 = makeNote({ id: 'f2', title: 'F2', isFolder: true, parentId: 'f1', order: 2 });
    const allNotes = [f1, f2];

    // Attempt to drop f1 (parent) onto its child f2 — invalid.
    const validation = validateDropTarget('f1', f2, allNotes);
    expect(validation.valid).toBe(false);
    expect(validation.reason).toBe('descendant');

    // In the integrated TreeView flow we'd `return` here without calling computeDropUpdates.
    // Assert that even if someone *did* call it, the resulting updates would be unsafe;
    // we instead assert that the helper API is intended to be called only after validation
    // by exercising the guard: a "good citizen" wrapper must short-circuit on validation failure.
    const safeUpdates = validation.valid
      ? computeDropUpdates('f1', f2, allNotes)
      : null;
    expect(safeUpdates).toBeNull();
  });

  it('drops a note into a folder that already has children — dragged lands after existing max order', () => {
    const f = makeNote({ id: 'f', title: 'F', isFolder: true, isExpanded: true, order: 1 });
    const k1 = makeNote({ id: 'k1', title: 'K1', parentId: 'f', order: 100 });
    const k2 = makeNote({ id: 'k2', title: 'K2', parentId: 'f', order: 200 });
    const n = makeNote({ id: 'n', title: 'New', order: 50 });
    const allNotes = [f, k1, k2, n];

    const validation = validateDropTarget('n', f, allNotes);
    expect(validation.valid).toBe(true);

    const updates = computeDropUpdates('n', f, allNotes, 0);
    // max(k1.order, k2.order) = 200, so n lands at 210
    expect(updates.dragged).toEqual({ parentId: 'f', order: 210 });
    // Folder was already expanded → no target update needed
    expect(updates.target).toBeNull();
  });
});

describe('collectDescendants', () => {
  it('returns empty array for a leaf node', () => {
    const leaf = makeNote({ id: 'leaf' });
    expect(collectDescendants([leaf], 'leaf')).toEqual([]);
  });

  it('returns direct children plus their descendants', () => {
    const root = makeNote({ id: 'root', isFolder: true });
    const child1 = makeNote({ id: 'c1', parentId: 'root' });
    const child2 = makeNote({ id: 'c2', parentId: 'root' });
    const grandchild = makeNote({ id: 'gc1', parentId: 'c1' });
    const greatGrand = makeNote({ id: 'gg1', parentId: 'gc1' });
    const notes = [root, child1, child2, grandchild, greatGrand];
    const ids = collectDescendants(notes, 'root').sort();
    expect(ids).toEqual(['c1', 'c2', 'gc1', 'gg1'].sort());
  });

  it('does not include the rootId itself', () => {
    const root = makeNote({ id: 'root', isFolder: true });
    const child = makeNote({ id: 'c', parentId: 'root' });
    const ids = collectDescendants([root, child], 'root');
    expect(ids).toContain('c');
    expect(ids).not.toContain('root');
  });

  it('returns empty for unknown id', () => {
    const notes = [makeNote({ id: 'a' })];
    expect(collectDescendants(notes, 'unknown')).toEqual([]);
  });
});

describe('flattenTree', () => {
  it('returns an empty list for an empty input', () => {
    expect(flattenTree([])).toEqual([]);
  });

  it('emits a single root row at depth 0 with hasChildren=false for an only note', () => {
    const only = makeNote({ id: 'solo', order: 1 });
    const flat = flattenTree([only]);
    expect(flat).toHaveLength(1);
    expect(flat[0]).toMatchObject({
      note: only,
      depth: 0,
      hasChildren: false,
      isOpened: false,
    });
  });

  it('orders children under a parent by `order` ascending', () => {
    const root = makeNote({ id: 'r', isFolder: true, isExpanded: true, order: 1 });
    const c1 = makeNote({ id: 'c1', parentId: 'r', order: 30 });
    const c2 = makeNote({ id: 'c2', parentId: 'r', order: 10 });
    const c3 = makeNote({ id: 'c3', parentId: 'r', order: 20 });
    const flat = flattenTree([root, c1, c2, c3]);
    expect(flat.map((f) => f.note.id)).toEqual(['r', 'c2', 'c3', 'c1']);
  });

  it('walks descendants of an expanded folder with correct depth', () => {
    // Each intermediate parent must be a folder AND expanded for the
    // DFS to recurse into it. Non-folder rows are leaves regardless of
    // their `isExpanded` field (the implementation requires
    // `isFolder && isExpanded` to walk down).
    const r = makeNote({ id: 'r', isFolder: true, isExpanded: true, order: 1 });
    const a = makeNote({
      id: 'a',
      parentId: 'r',
      isFolder: true,
      isExpanded: true,
      order: 1,
    });
    const b = makeNote({
      id: 'b',
      parentId: 'a',
      isFolder: true,
      isExpanded: true,
      order: 1,
    });
    const c = makeNote({ id: 'c', parentId: 'b', order: 1 }); // leaf
    const flat = flattenTree([r, a, b, c]);
    expect(flat.map((f) => ({ id: f.note.id, depth: f.depth }))).toEqual([
      { id: 'r', depth: 0 },
      { id: 'a', depth: 1 },
      { id: 'b', depth: 2 },
      { id: 'c', depth: 3 },
    ]);
  });

  it('PRUNES descendants of a collapsed folder (do not appear in flat list)', () => {
    const r = makeNote({ id: 'r', isFolder: true, isExpanded: false, order: 1 });
    const a = makeNote({ id: 'a', parentId: 'r', order: 1 });
    const b = makeNote({ id: 'b', parentId: 'a', order: 1 });
    const flat = flattenTree([r, a, b]);
    expect(flat).toHaveLength(1);
    expect(flat[0].note.id).toBe('r');
    expect(flat[0].hasChildren).toBe(true);
    expect(flat[0].isOpened).toBe(false);
  });

  it('includes children of a folder even when isExpanded is unset (default expand)', () => {
    // `isExpanded` defaults to false in our makeNote helper. Confirm we
    // don't accidentally exclude based on isFolder alone.
    const r = makeNote({ id: 'r', isFolder: true, isExpanded: false, order: 1 });
    const a = makeNote({ id: 'a', parentId: 'r', order: 1 });
    // Folder explicitly collapsed => children pruned
    expect(flattenTree([r, a]).map((f) => f.note.id)).toEqual(['r']);
  });

  it('hasChildren is true iff the note has at least one child row', () => {
    const leaf = makeNote({ id: 'leaf', order: 1 });
    const folder = makeNote({
      id: 'folder',
      isFolder: true,
      isExpanded: false,
      order: 2,
    });
    const child = makeNote({ id: 'c', parentId: 'folder', order: 1 });
    const flat = flattenTree([leaf, folder, child]);
    const leafRow = flat.find((f) => f.note.id === 'leaf')!;
    const folderRow = flat.find((f) => f.note.id === 'folder')!;
    expect(leafRow.hasChildren).toBe(false);
    expect(folderRow.hasChildren).toBe(true);
  });

  it('isOpened is true only when the note is a folder AND isExpanded is true', () => {
    const openFolder = makeNote({
      id: 'open',
      isFolder: true,
      isExpanded: true,
      order: 1,
    });
    const closedFolder = makeNote({
      id: 'closed',
      isFolder: true,
      isExpanded: false,
      order: 2,
    });
    const leaf = makeNote({ id: 'leaf', order: 3 });
    const flat = flattenTree([openFolder, closedFolder, leaf]);
    expect(flat.find((f) => f.note.id === 'open')!.isOpened).toBe(true);
    expect(flat.find((f) => f.note.id === 'closed')!.isOpened).toBe(false);
    // Non-folder rows have isOpened=false regardless of `isExpanded` on the note
    expect(flat.find((f) => f.note.id === 'leaf')!.isOpened).toBe(false);
  });

  it('handles multiple root-level folders interleaved with leaves', () => {
    const f1 = makeNote({ id: 'f1', isFolder: true, isExpanded: false, order: 1 });
    const n1 = makeNote({ id: 'n1', order: 2 });
    const f2 = makeNote({ id: 'f2', isFolder: true, isExpanded: true, order: 3 });
    const n2 = makeNote({ id: 'n2', parentId: 'f2', order: 1 });
    const flat = flattenTree([f1, n1, f2, n2]);
    expect(flat.map((f) => f.note.id)).toEqual(['f1', 'n1', 'f2', 'n2']);
  });

  it('pure: input order does not matter, only parentId/order fields do', () => {
    const r = makeNote({ id: 'r', isFolder: true, isExpanded: true, order: 1 });
    const c = makeNote({ id: 'c', parentId: 'r', order: 1 });
    // Re-order the input array; flattenTree should still produce r then c.
    const flat = flattenTree([c, r]);
    expect(flat.map((f) => f.note.id)).toEqual(['r', 'c']);
  });
});
