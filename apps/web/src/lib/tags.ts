import { Note } from '../types';

/**
 * Pure helpers for the Tags + Sort-mode feature.
 *
 *   - normalizeTag / normalizeTags : convert raw user input into the
 *     canonical form stored on `note.tags`.
 *   - isValidTagInput              : input validation for the chip
 *     editor (rejects empty / too-long / control chars).
 *   - filterActiveNotesByTagSet    : AND semantics on the tag-filter
 *     chip set; used by TreeView before flatten.
 *   - extractAllTags               : compile the unique tag set WITH
 *     note counts so the sidebar chip filter shows what exists.
 *   - sortRootComparator / sortRootNotes : root-only sort applied in
 *     flattenTree to avoid messing with sub-tree `order`.
 *
 * All helpers are sync and pure — safe to call from useMemo deps or
 * Vitest unit tests without React or Dexie.
 *
 * Tag conventions:
 *   - lowercase only                                (Project -> project)
 *   - words joined by single hyphens                 (Hello World -> hello-world)
 *   - no leading `#`                                (#urgent -> urgent)
 *   - no whitespace inside                          ( a b c  -> a-b-c)
 *   - length:  1 .. 50 chars AFTER normalization
 *
 * The convention is enforced everywhere these helpers run, so the
 * stored `note.tags` strings are always comparable with `===` /
 * Set.has() and the sidebar filter chips line up exactly with the
 * autocomplete values.
 */

/**
 * Maximum length of a tag string AFTER normalization (single-line,
 * lowercase, kebab-case). 50 is generous enough for any reasonable
 * "area-of-focus" tag.
 */
export const MAX_TAG_LENGTH = 50;
export const MIN_TAG_LENGTH = 1;

/**
 * Canonicalize a single raw tag string. Returns `null` if the input
 * collapses to an empty string (e.g. user typed `   ` — the helper
 * is the single point of truth and callers should skip nulls).
 */
export function normalizeTag(raw: string): string | null {
  if (typeof raw !== 'string') return null;
  // Strip a lone leading `#` if present (so `#urgent` -> `urgent`).
  // Other `#` characters inside the string are kept verbatim (users
  // can have `#c++` if they want, though uncommon).
  let stripped = raw.trim();
  if (stripped.startsWith('#')) stripped = stripped.slice(1).trim();
  if (stripped.length === 0) return null;

  const lower = stripped.toLowerCase();
  // Replace any whitespace (space, tab, multiple spaces) with a
  // single hyphen. Then collapse multiple hyphens.
  const hyphenated = lower
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    // Strip control chars (defensive — UI shouldn't accept them, but
    // we don't want them in storage either).
    .replace(/[\u0000-\u001f\u007f]/g, '');

  if (hyphenated.length < MIN_TAG_LENGTH) return null;
  if (hyphenated.length > MAX_TAG_LENGTH) {
    // Silently truncate; UI can show error feedback before this is
    // called if it wants strict rejection.
    return hyphenated.slice(0, MAX_TAG_LENGTH);
  }
  return hyphenated;
}

/**
 * Normalize an array of raw tags. Drops:
 *   - empty / null results from normalizeTag
 *   - duplicates (case-insensitive after normalization)
 *
 * Returns a new array; does not mutate the input. The order of
 * first appearance is preserved so the chip UI is stable across
 * re-renders.
 */
export function normalizeTags(rawList: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const normalized = normalizeTag(raw);
    if (!normalized) continue;
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

/**
 * Input validation for the chip-input onChange. Looser than
 * normalizeTag — accepts whitespace (so the user is mid-typing), but
 * rejects obvious garbage: empty after trim, > 50 chars AFTER a
 * `#`-strip, or contains a control character. Used for inline
 * invalid-state feedback only; the canonical normalization runs on
 * commit.
 */
export function isValidTagInput(raw: string): boolean {
  if (typeof raw !== 'string') return false;
  // Trim leading/trailing whitespace AND strip any leading `#` chars
  // so a user mid-typing `  #  ` still sees the input rejected.
  const cleaned = raw.trim().replace(/^#+/, '');
  if (cleaned.length === 0) return false;
  if (cleaned.length > MAX_TAG_LENGTH + 1) return false;
  // Reject control chars but allow internal whitespace.
  if (/[\u0000-\u001f\u007f]/.test(cleaned)) return false;
  return true;
}

/**
 * Read `note.tags` defensively. Older notes may have no `tags`
 * field at all (Dexie's treat-undefined-as-no-field convention) so
 * we always return an array — callers never have to nullcheck.
 */
export function getNoteTags(note: Note): string[] {
  return note.tags ?? [];
}

/**
 * AND-semantics filter. `None / empty filter` => return every note
 * unchanged. Otherwise the note must contain EVERY selected tag.
 *
 * Excludes soft-deleted notes too — the sidebar's filter view
 * shouldn't show Trash items leaking in.
 *
 * Pure / sync; O(notes * filterSet).
 */
export function filterActiveNotesByTagSet(
  notes: Note[],
  selectedTags: readonly string[],
): Note[] {
  if (selectedTags.length === 0) {
    return notes.filter((n) => n.deletedAt == null);
  }
  const required = new Set(selectedTags);
  return notes.filter((n) => {
    if (n.deletedAt != null) return false;
    const noteTags = new Set(getNoteTags(n));
    for (const t of required) {
      if (!noteTags.has(t)) return false;
    }
    return true;
  });
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

/**
 * Sort modes for the root-level grouping of the tree. `manual`
 * means "respect the drag order — i.e. read `note.order`
 * ascending". The other modes are computed from non-order fields.
 *
 * Sub-tree order is NEVER re-sorted; only the children of
 * `parentId: null` are touched. Existing tests rely on sub-tree
 * sibling order being mutated only by `Move Up` / `Move Down`.
 */
export type SortMode = 'manual' | 'updatedAt' | 'title' | 'createdAt';

/**
 * Default sort mode applied to root notes — matches the legacy
 * behaviour (manual drag order).
 */
export const DEFAULT_SORT_MODE: SortMode = 'manual';

/**
 * Comparators indexed by SortMode. Returns a function suitable for
 * `Array.prototype.sort`. String comparison is locale-aware, case-
 * insensitive (so "zebra" sorts before "Apple"). Numeric fields
 * sort descending (most-recent first), which matches what users
 * usually want for "Updated" and "Created".
 */
export const ROOT_SORT_COMPARATORS: Record<
  SortMode,
  (a: Note, b: Note) => number
> = {
  manual: (a, b) => a.order - b.order,
  updatedAt: (a, b) => b.updatedAt - a.updatedAt,
  createdAt: (a, b) => b.createdAt - a.createdAt,
  title: (a, b) =>
    (a.title || '').localeCompare(b.title || '', undefined, {
      sensitivity: 'base',
    }),
};

/**
 * Sort a list of notes using the given mode. Returns a NEW array;
 * does not mutate. The caller (flattenTree / TreeView) is expected
 * to chunk-sort only the root-level subset so sub-tree order is
 * preserved.
 */
export function sortRootNotes(notes: Note[], mode: SortMode): Note[] {
  return [...notes].sort(ROOT_SORT_COMPARATORS[mode]);
}

// ---------------------------------------------------------------------------
// Tag catalogue (used by Sidebar to render the filter chip set)
// ---------------------------------------------------------------------------

export interface TagWithCount {
  tag: string;
  count: number;
}

/**
 * Walk every ACTIVE note and produce a sorted list of `(tag, count)`
 * pairs. Pure / sync; O(N) over notes plus tag-set size.
 *
 * `limit` lets the sidebar show only the top-K most-used tags; pass
 * `Infinity` to dump every tag.
 */
export function extractAllTags(notes: Note[], limit = 50): TagWithCount[] {
  const counts = new Map<string, number>();
  for (const n of notes) {
    if (n.deletedAt != null) continue;
    for (const tag of getNoteTags(n)) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  const out: TagWithCount[] = [];
  for (const [tag, count] of counts) out.push({ tag, count });
  out.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count; // freq desc
    return a.tag.localeCompare(b.tag); // tie-break alphabetic
  });
  return out.slice(0, limit);
}
