import { describe, it, expect } from 'vitest';
import {
  filterAndRankAutocomplete,
  findActiveWikiQuery,
  extractBacklinkedNoteIds,
  noteTitleAutocompleteCandidates,
  WIKILINK_ID_ATTR,
} from '../lib/wikilink';
import { Note } from '../types';

describe('filterAndRankAutocomplete', () => {
  const candidates = [
    { id: '1', title: 'Project Alpha' },
    { id: '2', title: 'alpha team' },
    { id: '3', title: 'Todo list' },
    { id: '4', title: 'Project Beta' },
  ];

  it('returns empty for empty query', () => {
    expect(filterAndRankAutocomplete(candidates, '')).toEqual([]);
  });

  it('returns empty for whitespace-only query', () => {
    expect(filterAndRankAutocomplete(candidates, '   ')).toEqual([]);
  });

  it('exact match wins class 0', () => {
    const out = filterAndRankAutocomplete(candidates, 'project alpha');
    // "Project Alpha" is exact-lower; "alpha team" is substring; both match
    expect(out[0].id).toBe('1');
    expect(out[0].score).toBe(0);
  });

  it('prefix matches come before substring matches', () => {
    const out = filterAndRankAutocomplete(candidates, 'project');
    expect(out.map((c) => c.id)).toEqual(['1', '4']);
    expect(out.every((c) => c.score === 1)).toBe(true);
  });

  it('substring matches are still returned when no prefix hit exists', () => {
    const out = filterAndRankAutocomplete(candidates, 'team');
    expect(out.map((c) => c.id)).toEqual(['2']);
    expect(out[0].score).toBe(2);
  });

  it('case-insensitive on the query', () => {
    expect(
      filterAndRankAutocomplete(candidates, 'PROJECT').map((c) => c.id),
    ).toEqual(['1', '4']);
    expect(
      filterAndRankAutocomplete(candidates, 'list').map((c) => c.id),
    ).toEqual(['3']);
  });

  it('sorts prefix matches alphabetically on tie', () => {
    expect(
      filterAndRankAutocomplete(candidates, 'project').map(
        (c) => c.title,
      ),
    ).toEqual(['Project Alpha', 'Project Beta']);
  });

  it('respects the limit argument', () => {
    expect(filterAndRankAutocomplete(candidates, 'project', 1)).toHaveLength(
      1,
    );
  });

  it('returns no rows when nothing matches', () => {
    expect(
      filterAndRankAutocomplete(candidates, 'no-such-thing'),
    ).toEqual([]);
  });

  it('does not mutate the input array', () => {
    const before = JSON.stringify(candidates);
    filterAndRankAutocomplete(candidates, 'project');
    expect(JSON.stringify(candidates)).toBe(before);
  });
});

function makeNote(partial: Partial<Note>): Note {
  return {
    id: partial.id ?? 'n',
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'Untitled',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: false,
    createdAt: 0,
    updatedAt: 0,
    ...partial,
  } as Note;
}

describe('findActiveWikiQuery', () => {
  it('returns inactive when caret is at start of document', () => {
    const res = findActiveWikiQuery('hello world', 0);
    expect(res.active).toBe(false);
  });

  it('returns inactive when there is no [[', () => {
    const res = findActiveWikiQuery('plain text', 5);
    expect(res.active).toBe(false);
  });

  it('detects an empty query immediately after [[', () => {
    // text='foo [[' has 6 chars (indices 0-5). caretPos=6 means
    // caret is at end-of-document, which is the convention
    // `selection.head`/caret position uses ("the index at which new
    // text would be inserted"). The active query starts at the
    // position AFTER the second '[' (index 6), which is empty.
    const res = findActiveWikiQuery('foo [[', 6);
    expect(res.active).toBe(true);
    if (res.active) {
      expect(res.query).toBe('');
      expect(res.start).toBe(6);
      expect(res.end).toBe(6);
    }
  });

  it('captures the typed query up to the caret', () => {
    // text='foo [[Hello' has 11 chars. caretPos=11 = end. Query
    // starts at index 6 (right after the second '[') and runs to
    // caretPos=11.
    const res = findActiveWikiQuery('foo [[Hello', 11);
    expect(res.active).toBe(true);
    if (res.active) {
      expect(res.query).toBe('Hello');
      expect(res.start).toBe(6);
      expect(res.end).toBe(11);
    }
  });

  it('returns inactive once the user has typed ]]', () => {
    const res = findActiveWikiQuery('foo [[Hello]]', 12);
    expect(res.active).toBe(false);
  });

  it('does not cross a newline boundary', () => {
    // `[[foo\n` — caret is on the next line. Autocomplete should close
    // because the user is clearly past the wiki-query.
    const text = '[[foo\nbar';
    const caretAt = text.length;
    const res = findActiveWikiQuery(text, caretAt);
    expect(res.active).toBe(false);
  });

  it('does not match a single [', () => {
    const res = findActiveWikiQuery('foo [bar', 8);
    expect(res.active).toBe(false);
  });
});

describe('extractBacklinkedNoteIds', () => {
  it('finds a single occurrence', () => {
    const html = `<p>See <span ${WIKILINK_ID_ATTR}="abc-123">Foo</span> for details.</p>`;
    expect(extractBacklinkedNoteIds(html)).toEqual(['abc-123']);
  });

  it('deduplicates when the same id appears multiple times', () => {
    const html = `<p><span ${WIKILINK_ID_ATTR}="x">a</span> and <span ${WIKILINK_ID_ATTR}="x">b</span></p>`;
    expect(extractBacklinkedNoteIds(html)).toEqual(['x']);
  });

  it('collects multiple distinct ids in document order', () => {
    const html = `<p>
      <span ${WIKILINK_ID_ATTR}="b">second</span>
      <span ${WIKILINK_ID_ATTR}="a">first</span>
      <span ${WIKILINK_ID_ATTR}="b">second again</span>
    </p>`;
    expect(extractBacklinkedNoteIds(html)).toEqual(['b', 'a']);
  });

  it('returns empty for HTML without any wiki links', () => {
    expect(extractBacklinkedNoteIds('<p>plain text</p>')).toEqual([]);
  });

  it('returns empty for empty input', () => {
    expect(extractBacklinkedNoteIds('')).toEqual([]);
  });

  it('skips the scan fast for content without the attribute', () => {
    // The fast path is just a string includes; intentional perf opt.
    const html = 'A long '.repeat(10_000) + 'paragraph with no links.';
    expect(extractBacklinkedNoteIds(html)).toEqual([]);
  });
});

describe('noteTitleAutocompleteCandidates', () => {
  it('excludes notes currently being edited (avoid self-link)', () => {
    const notes = [
      makeNote({ id: 'self', title: 'self' }),
      makeNote({ id: 'other', title: 'Other' }),
    ];
    const out = noteTitleAutocompleteCandidates(notes, 'self');
    expect(out.map((c) => c.id)).toEqual(['other']);
  });

  it('excludes soft-deleted notes', () => {
    const notes = [
      makeNote({ id: 'a', title: 'alive' }),
      makeNote({ id: 'b', title: 'trashed', deletedAt: Date.now() }),
    ];
    expect(noteTitleAutocompleteCandidates(notes, null).map((c) => c.id)).toEqual([
      'a',
    ]);
  });

  it('excludes notes with empty titles', () => {
    const notes = [
      makeNote({ id: 'a', title: '' }),
      makeNote({ id: 'b', title: 'Real Title' }),
    ];
    expect(noteTitleAutocompleteCandidates(notes, null).map((c) => c.id)).toEqual([
      'b',
    ]);
  });
});
