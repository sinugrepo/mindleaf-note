import { Note } from '../types';

/**
 * HTML attribute the WikiLink mark writes on its rendered `<span>`.
 * Consumers (BacklinksPanel, export/import) read this attribute to
 * resolve the target note id without parsing the DOM tree.
 *
 * Kept as a constant so the editor and the scanner can never drift
 * apart; if you rename this, also update
 * `- src/extensions/WikiLink.tsx (parseHTML/renderHTML)`
 * `- src/components/BacklinksPanel.tsx (regex)`
 * `- any saved HTML still rendering on disk`.
 */
export const WIKILINK_ID_ATTR = 'data-wikilink-id';

/**
 * Lazily-computed "score" used to rank autocomplete candidates.
 * Lower score = closer match. Exact prefix wins over substring.
 *
 * Pure function so it can be unit-tested without the editor.
 */
export interface AutocompleteCandidate {
  id: string;
  title: string;
}

export interface RankedCandidate extends AutocompleteCandidate {
  /** Original index, preserved so we can break ties deterministically. */
  rank: number;
  /**
   * Distance metric. `0` = exact title match, `1` = case-insensitive
   * prefix match, `2` = case-insensitive substring match, `Infinity`
   * = selected out of top N (already filtered out by the caller).
   */
  score: number;
}

/**
 * Filter `candidates` to those that contain `query` (case-insensitive)
 * AND rank them: prefix matches beat substring matches, and within
 * each group they are sorted by alphabetical title.
 *
 * Returns early on empty query (no candidates) so the caller can hide
 * the popover cleanly.
 */
export function filterAndRankAutocomplete(
  candidates: AutocompleteCandidate[],
  query: string,
  limit: number = 8,
): RankedCandidate[] {
  const normalizedQuery = query.toLowerCase().trim();
  if (!normalizedQuery) return [];

  const ranked: RankedCandidate[] = [];
  for (let i = 0; i < candidates.length; i++) {
    const candidate = candidates[i];
    const title = candidate.title.toLowerCase();
    let score: number;
    if (title === normalizedQuery) {
      score = 0;
    } else if (title.startsWith(normalizedQuery)) {
      score = 1;
    } else if (title.includes(normalizedQuery)) {
      score = 2;
    } else {
      continue;
    }
    ranked.push({ id: candidate.id, title: candidate.title, rank: i, score });
  }

  ranked.sort((a, b) => {
    if (a.score !== b.score) return a.score - b.score;
    // Tie-break on title so the popover order is stable across re-renders.
    const titleCmp = a.title.localeCompare(b.title);
    if (titleCmp !== 0) return titleCmp;
    return a.rank - b.rank;
  });

  return ranked.slice(0, limit);
}

/**
 * Resolve the unclosed `[[query` substring from the editor's text
 * content up to `caretPos`. Returns `{ active: true, query, start, end }`
 * if the caret is currently inside a `[[…` token, otherwise
 * `{ active: false }` (so the popover stays closed).
 *
 * Pure: takes the plain-text content + caret position as arguments.
 * No TipTap dependency. Tested in wikilink.test.ts.
 *
 * Robust against weird input:
 *   - if the buffer between the last unmatched `[[` and `caretPos` is
 *     empty, the function still returns active=true with an empty
 *     query so the popover can show all titles.
 *   - if a `]]` was already typed, the function returns active=false
 *     (the user has finished the link).
 *   - newlines inside the query are NOT supported; the function
 *     returns active=false if a newline is encountered, since
 *     intuitively the user has moved on to a new paragraph.
 */
export interface ActiveWikiQuery {
  active: true;
  query: string;
  /** Position of the `[` character RIGHT AFTER the matching `[[`. */
  start: number;
  /** Position of the caret (= end of query). */
  end: number;
}

export interface InactiveWikiQuery {
  active: false;
}

export function findActiveWikiQuery(
  textContent: string,
  caretPos: number,
): ActiveWikiQuery | InactiveWikiQuery {
  // Probe backward from caretPos looking for `[[` that hasn't yet been
  // closed with `]]`. Stop at newlines (don't carry the wiki-query
  // across paragraph boundaries) and at the document start.
  let i = caretPos - 1;
  while (i >= 0) {
    const ch = textContent[i];
    if (ch === '\n') return { active: false };
    if (ch === ']' && textContent[i + 1] === ']') {
      // The user already closed the link — nothing to autocomplete.
      return { active: false };
    }
    if (ch === '[' && textContent[i - 1] === '[') {
      const start = i + 1;
      return {
        active: true,
        query: textContent.slice(start, caretPos),
        start,
        end: caretPos,
      };
    }
    i -= 1;
  }
  return { active: false };
}

/**
 * Run a regex over `html` and return EVERY distinct note id referenced
 * via the WIKILINK_ID_ATTR. Pure & sync. O(html.length) per note scan.
 *
 * BacklinksPanel calls this on every note's content as part of its
 * useLiveQuery scan; the input corpus is the full text of all notes
 * (potentially MBs of HTML), so the regex is intentionally O(n) with
 * no per-match allocation.
 */
export function extractBacklinkedNoteIds(html: string): string[] {
  if (!html || !html.includes(WIKILINK_ID_ATTR)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const re = new RegExp(
    `${WIKILINK_ID_ATTR}="([^"]+)"`,
    'gi',
  );
  for (const m of html.matchAll(re)) {
    const id = m[1];
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * Build the autocomplete candidate list from notes. Hides the current
 * editor note (you can't link to yourself with [[self]] — it's just a
 * no-op rendered as plain text) and any soft-deleted notes (mirrors
 * the tree-rendering filter).
 */
export function noteTitleAutocompleteCandidates(
  notes: Note[],
  excludeNoteId: string | null,
): AutocompleteCandidate[] {
  return notes
    .filter(
      (n) =>
        n.deletedAt == null &&
        n.title.length > 0 &&
        n.id !== excludeNoteId,
    )
    .map((n) => ({ id: n.id, title: n.title }));
}
