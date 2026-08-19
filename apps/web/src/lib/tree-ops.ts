import { Note } from '../types';

/**
 * Result of validating whether a dragged item can be dropped onto a target folder.
 */
export interface DropValidationResult {
  valid: boolean;
  reason?:
    | 'not-folder'
    | 'max-depth'
    | 'self-drop'
    | 'descendant'
    | 'missing-id'
    | 'missing-note';
}

/**
 * Validates a drag-and-drop move. Returns invalid if:
 * - The target is not a folder
 * - The dragged id matches the target id (self-drop)
 * - The target folder is itself a descendant of the dragged note (would create a cycle)
 * - The target is already a child (the supported hierarchy is root -> child)
 * - The dragged id is missing/empty
 */
export function validateDropTarget(
  draggedId: string | null | undefined,
  target: Note,
  allNotes: Note[],
): DropValidationResult {
  if (!draggedId) {
    return { valid: false, reason: 'missing-id' };
  }
  if (draggedId === target.id) {
    return { valid: false, reason: 'self-drop' };
  }
  if (!allNotes.some((note) => note.id === draggedId)) {
    return { valid: false, reason: 'missing-note' };
  }
  if (!target.isFolder) {
    return { valid: false, reason: 'not-folder' };
  }
  // Walk up from target; if we ever pass the dragged note, the target is a descendant of dragged.
  let currentParent: string | null = target.parentId;
  const byId = new Map(allNotes.map((n) => [n.id, n]));
  const visitedParents = new Set<string>();
  while (currentParent) {
    // Malformed imported data can contain a parent cycle. Treat it as an
    // invalid tree rather than looping forever during a drag validation.
    if (visitedParents.has(currentParent)) {
      return { valid: false, reason: 'descendant' };
    }
    visitedParents.add(currentParent);
    if (currentParent === draggedId) {
      return { valid: false, reason: 'descendant' };
    }
    const parent: Note | undefined = byId.get(currentParent);
    currentParent = parent?.parentId ?? null;
  }
  // Notes use a two-level hierarchy: root -> child. A child folder is
  // still a valid existing row, but it cannot become a parent itself.
  if (target.parentId !== null) {
    return { valid: false, reason: 'max-depth' };
  }
  return { valid: true };
}

/**
 * Returns the partial updates needed to re-parent a dragged note into target.
 * The caller is responsible for the actual db writes.
 */
export function computeDropUpdates(
  draggedId: string,
  target: Note,
  allNotes: Note[],
  now: number = Date.now(),
): { dragged: Partial<Note>; target: Partial<Note> | null } {
  const kids = allNotes.filter((n) => n.parentId === target.id && n.id !== draggedId);
  const maxOrder = kids.length > 0 ? Math.max(...kids.map((k) => k.order)) : now;
  return {
    dragged: { parentId: target.id, order: maxOrder + 10 },
    target: target.isExpanded ? null : { isExpanded: true },
  };
}

/**
 * Validates moving a note back to the root level. The root is not a note,
 * so it cannot use `validateDropTarget`'s folder/cycle checks.
 */
export function validateRootDropTarget(
  draggedId: string | null | undefined,
  allNotes: Note[],
): DropValidationResult {
  if (!draggedId) {
    return { valid: false, reason: 'missing-id' };
  }
  if (!allNotes.some((note) => note.id === draggedId)) {
    return { valid: false, reason: 'missing-note' };
  }
  return { valid: true };
}

/**
 * Returns the updates needed to move a note to the root level. Root siblings
 * are ordered independently from children inside folders.
 */
export function computeRootDropUpdates(
  draggedId: string,
  allNotes: Note[],
  now: number = Date.now(),
): { dragged: Partial<Note> } {
  const rootSiblings = allNotes.filter(
    (note) => note.parentId === null && note.id !== draggedId,
  );
  const maxOrder = rootSiblings.length > 0
    ? Math.max(...rootSiblings.map((note) => note.order))
    : now;
  return { dragged: { parentId: null, order: maxOrder + 10 } };
}

/**
 * Result of evaluating move up/down.
 */
export interface MoveResult {
  canMove: boolean;
  other?: Note;
}

/**
 * Find the sibling that the given note should swap with to move up or down.
 * Returns canMove=false if already at an edge (top for 'up', bottom for 'down').
 */
export function findMoveSibling(
  allNotes: Note[],
  noteId: string,
  direction: 'up' | 'down',
): MoveResult {
  const subject = allNotes.find((n) => n.id === noteId);
  if (!subject) return { canMove: false };

  const siblings = allNotes
    .filter((n) => n.parentId === subject.parentId)
    .sort((a, b) => a.order - b.order);
  const myIndex = siblings.findIndex((n) => n.id === noteId);
  if (myIndex < 0) return { canMove: false };

  if (direction === 'up') {
    if (myIndex === 0) return { canMove: false };
    return { canMove: true, other: siblings[myIndex - 1] };
  } else {
    if (myIndex >= siblings.length - 1) return { canMove: false };
    return { canMove: true, other: siblings[myIndex + 1] };
  }
}

/**
 * Returns Partial<Note> updates to swap the `order` field between two notes.
 * Handles the edge case where two notes have the same order by forcing a +1/-1 nudge.
 */
export function computeOrderSwap(
  current: Note,
  other: Note,
  direction: 'up' | 'down',
): { [id: string]: Partial<Note> } {
  let newCurrentOrder = other.order;
  let newOtherOrder = current.order;
  if (newCurrentOrder === newOtherOrder) {
    newOtherOrder += direction === 'up' ? -1 : 1;
  }
  return {
    [current.id]: { order: newCurrentOrder },
    [other.id]: { order: newOtherOrder },
  };
}

/**
 * Move-sibling information for a single visible note, precomputed so
 * the TreeRow component can answer "can this row move up / down?" with
 * a single Map lookup instead of re-running `findMoveSibling` per row.
 *
 * `otherUp` / `otherDown` are the visible sibling notes that would
 * participate in the order swap; both are `undefined` when the move
 * is not possible (edge of the sibling chain).
 */
export interface MoveSupport {
  canMoveUp: boolean;
  otherUp?: Note;
  canMoveDown: boolean;
  otherDown?: Note;
}

/**
 * Batch-compute move-sibling info for every note in `notes` in a single
 * O(N log N) pass.
 *
 * Strategy:
 *   1. Bucket notes by `parentId` (`null` is a valid key for root notes),
 *      O(N).
 *   2. Sort each bucket by `order` ascending, summed O(K log K) = O(N log N).
 *      Defensive even though `flattenTree` already emits siblings in
 *      `order` order — keeps the helper correctly self-contained for
 *      callers that pass raw `Note[]` arrays.
 *   3. Walk each bucket, write `{canMoveUp/otherUp, canMoveDown/otherDown}`
 *      into the result map keyed by `note.id`.
 *
 * The empty-string / missing-id contract matches `findMoveSibling`: a
 * note not present in `notes` won't be in the map; callers should
 * treat a missing entry as "no moves available" (same as
 * `findMoveSibling`'s `canMove: false`).
 *
 * Pure / sync / safe to call inside a `useMemo` or test fixture.
 */
export function buildMoveSupportMap(notes: Note[]): Map<string, MoveSupport> {
  const byParent = new Map<string | null, Note[]>();
  for (const n of notes) {
    const key = n.parentId ?? null;
    const bucket = byParent.get(key);
    if (bucket) {
      bucket.push(n);
    } else {
      byParent.set(key, [n]);
    }
  }
  for (const bucket of byParent.values()) {
    bucket.sort((a, b) => a.order - b.order);
  }

  const out = new Map<string, MoveSupport>();
  for (const bucket of byParent.values()) {
    for (let i = 0; i < bucket.length; i++) {
      const note = bucket[i];
      out.set(note.id, {
        canMoveUp: i > 0,
        otherUp: i > 0 ? bucket[i - 1] : undefined,
        canMoveDown: i < bucket.length - 1,
        otherDown: i < bucket.length - 1 ? bucket[i + 1] : undefined,
      });
    }
  }
  return out;
}

export function collectDescendants(
  allNotes: Note[],
  rootId: string,
): string[] {
  const childrenByParent = new Map<string, Note[]>();
  for (const note of allNotes) {
    if (!note.parentId) continue;
    const children = childrenByParent.get(note.parentId);
    if (children) children.push(note);
    else childrenByParent.set(note.parentId, [note]);
  }

  const out: string[] = [];
  const visited = new Set<string>([rootId]);
  const stack = [...(childrenByParent.get(rootId) ?? [])].reverse();
  while (stack.length > 0) {
    const child = stack.pop()!;
    if (visited.has(child.id)) continue;
    visited.add(child.id);
    out.push(child.id);
    const children = childrenByParent.get(child.id);
    if (children) {
      for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Tree flattening (powers the virtualized TreeView)
//
// The recursive TreeNode render used to walk the parent-child graph at
// render time, so every useLiveQuery tick produced O(notes) React nodes.
// flattenTree produces a flat list of `FlatTreeItem`s in a single O(N) pass
// (Map build + one DFS). Children of collapsed folders are pruned at the
// DFS step — so a tree with 5000 notes but 10 expanded folders still
// flattens to a short render-time list.
//
// Used by TreeView.tsx; also a target for unit tests in tree-ops.test.ts.
// ---------------------------------------------------------------------------

/**
 * Flat row representation emitted by `flattenTree`. Carries everything a
 * row needs to render without re-walking the parent-child graph.
 */
export interface FlatTreeItem {
  note: Note;
  /** Depth in the visible (post-collapse-pruning) tree. */
  depth: number;
  /** True iff this row has at least one child note (folder or leaf). */
  hasChildren: boolean;
  /**
   * Convenience: `note.isFolder && !!note.isExpanded`. Matches the
   * semantics the TreeView uses to decide whether to draw an open
   * chevron vs. a closed one and whether the row is a candidate for
   * sub-tree rendering.
   */
  isOpened: boolean;
}

/**
 * Walk `notes` depth-first and emit a render-order list. Rows below a
 * collapsed folder are pruned early so an extremely collapsed tree
 * still flattens to a short list.
 *
 * Cost: O(N) for the bucketing pass + O(visible) for the DFS (where
 * `visible` counts only rows whose ancestors are expanded). Children
 * at each level are sorted by `order` ascending — same invariant the
 * recursive TreeNode render used to honour.
 *
 * Pure: no React, no DOM, no I/O. Safe to call inside a `useMemo` or
 * test fixture.
 */
export function flattenTree(
  notes: Note[],
  rootOrder?: readonly string[],
  siblingComparator?: (a: Note, b: Note) => number,
): FlatTreeItem[] {
  // Single pass to bucket notes by parentId. parentId comes back as
  // `null` for root notes; Dexie never writes `undefined` for nullable
  // columns in this codebase, so a plain null bucket is enough.
  const byParent = new Map<string | null, Note[]>();
  for (const n of notes) {
    const p = n.parentId ?? null;
    const bucket = byParent.get(p);
    if (bucket) {
      bucket.push(n);
    } else {
      byParent.set(p, [n]);
    }
  }
  // Sort each bucket once so the DFS emits rows in display order without
  // doing an extra compare per visit.
  for (const [parentId, bucket] of byParent.entries()) {
    if (parentId === null && rootOrder) {
      const rootIndex = new Map(rootOrder.map((id, index) => [id, index]));
      bucket.sort(
        (a, b) =>
          (rootIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER) -
          (rootIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER),
      );
    } else {
      bucket.sort(siblingComparator ?? ((a, b) => a.order - b.order));
    }
  }

  const out: FlatTreeItem[] = [];
  const visited = new Set<string>();
  const stack: Array<{ note: Note; depth: number }> = [];
  const roots = byParent.get(null) ?? [];
  for (let i = roots.length - 1; i >= 0; i--) {
    stack.push({ note: roots[i], depth: 0 });
  }

  // Iterative DFS avoids call-stack overflow for deeply nested but valid
  // imported trees, while `visited` still prevents malformed cycles.
  while (stack.length > 0) {
    const { note: kid, depth } = stack.pop()!;
    if (visited.has(kid.id)) continue;
    visited.add(kid.id);
    const grands = byParent.get(kid.id);
    const hasChildren = !!grands && grands.length > 0;
    const isOpened = !!kid.isFolder && !!kid.isExpanded;
    out.push({ note: kid, depth, hasChildren, isOpened });
    if (isOpened && grands) {
      for (let i = grands.length - 1; i >= 0; i--) {
        stack.push({ note: grands[i], depth: depth + 1 });
      }
    }
  }
  // Orphaned rows are not rendered as roots, preserving the existing tree
  // contract; all reachable rows are rendered without recursive overflow.
  return out;
}
