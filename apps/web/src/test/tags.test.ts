import { describe, it, expect } from 'vitest';
import {
  normalizeTag,
  normalizeTags,
  isValidTagInput,
  getNoteTags,
  filterActiveNotesByTagSet,
  extractAllTags,
  sortRootNotes,
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_MODE,
  ROOT_SORT_COMPARATORS,
  MAX_TAG_LENGTH,
  type SortDirection,
  type SortMode,
} from '../lib/tags';
import { Note } from '../types';

function makeNote(partial: Partial<Note>): Note {
  return {
    id: partial.id ?? 'n',
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'X',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  } as Note;
}

describe('normalizeTag', () => {
  it('lowercases', () => {
    expect(normalizeTag('Hello')).toBe('hello');
  });

  it('strips a single leading #', () => {
    expect(normalizeTag('#urgent')).toBe('urgent');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeTag('  area-51  ')).toBe('area-51');
  });

  it('replaces multiple spaces with single hyphen', () => {
    expect(normalizeTag('hello world')).toBe('hello-world');
  });

  it('collapses multiple hyphens to a single one', () => {
    expect(normalizeTag('a--b---c')).toBe('a-b-c');
  });

  it('combines spaces+hyphens into a single canonical form', () => {
    expect(normalizeTag('Hello  World--Foo')).toBe('hello-world-foo');
  });

  it('strips control characters', () => {
    expect(normalizeTag('hello\u0001world')).toBe('helloworld');
  });

  it('returns null for empty after trim', () => {
    expect(normalizeTag('')).toBeNull();
    expect(normalizeTag('   ')).toBeNull();
    expect(normalizeTag('#')).toBeNull();
    expect(normalizeTag('  #  ')).toBeNull();
  });

  it('truncates over-length raw input', () => {
    const big = 'a'.repeat(MAX_TAG_LENGTH + 5);
    expect(normalizeTag(big)?.length).toBe(MAX_TAG_LENGTH);
  });

  it('returns null for non-string argument', () => {
    expect(normalizeTag(null as unknown as string)).toBeNull();
    expect(normalizeTag(undefined as unknown as string)).toBeNull();
  });
});

describe('normalizeTags (array)', () => {
  it('drops empties and dedupes (case-insensitive)', () => {
    expect(
      normalizeTags(['#Project', 'project', '  hello world  ', '']),
    ).toEqual(['project', 'hello-world']);
  });

  it('preserves first-occurrence ordering', () => {
    expect(
      normalizeTags(['B', 'a', 'C', 'A', 'b', 'c']),
    ).toEqual(['b', 'a', 'c']);
  });

  it('does not mutate the input array', () => {
    const input = ['#Foo', 'foo'];
    const before = JSON.stringify(input);
    normalizeTags(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('isValidTagInput', () => {
  it('accepts mid-typing whitespace', () => {
    expect(isValidTagInput('foo bar')).toBe(true);
  });

  it('accepts a single leading #', () => {
    expect(isValidTagInput('#hello')).toBe(true);
  });

  it('rejects empty / whitespace-only', () => {
    expect(isValidTagInput('')).toBe(false);
    expect(isValidTagInput('#')).toBe(false);
    expect(isValidTagInput('   ')).toBe(false);
    expect(isValidTagInput('  #  ')).toBe(false);
  });

  it('rejects control characters', () => {
    expect(isValidTagInput('hello\u0001')).toBe(false);
  });

  it('rejects lengths clearly above MAX_TAG_LENGTH', () => {
    expect(isValidTagInput('a'.repeat(MAX_TAG_LENGTH + 10))).toBe(false);
  });
});

describe('getNoteTags', () => {
  it('returns an empty array for notes without a tags field', () => {
    expect(getNoteTags(makeNote({}))).toEqual([]);
  });

  it('returns the tags array if present', () => {
    expect(getNoteTags(makeNote({ tags: ['a', 'b'] }))).toEqual(['a', 'b']);
  });
});

describe('filterActiveNotesByTagSet', () => {
  const a = makeNote({ id: 'a', tags: ['work', 'urgent'] });
  const b = makeNote({ id: 'b', tags: ['work'] });
  const c = makeNote({ id: 'c', tags: ['personal'] });
  const d = makeNote({ id: 'd', tags: ['work', 'urgent'] });
  const trashed = makeNote({
    id: 't',
    tags: ['work'],
    deletedAt: Date.now(),
  });

  it('returns every active note when filter is empty', () => {
    expect(
      filterActiveNotesByTagSet([a, b, c, d, trashed], []),
    ).toEqual([a, b, c, d]);
  });

  it('AND semantics: returns only notes containing ALL selected tags', () => {
    const filtered = filterActiveNotesByTagSet(
      [a, b, c, d, trashed],
      ['work', 'urgent'],
    );
    expect(filtered).toEqual([a, d]);
  });

  it('single-tag filter matches every note containing that tag', () => {
    expect(filterActiveNotesByTagSet([a, b, c], ['work'])).toEqual([a, b]);
  });

  it('never returns soft-deleted notes (regression)', () => {
    expect(filterActiveNotesByTagSet([trashed], ['work'])).toEqual([]);
  });

  it('handles unknown filter tags by returning empty', () => {
    expect(filterActiveNotesByTagSet([a], ['nope'])).toEqual([]);
  });
});

describe('extractAllTags', () => {
  it('compiles the unique tag set with note counts', () => {
    const notes = [
      makeNote({ id: '1', tags: ['work', 'urgent'] }),
      makeNote({ id: '2', tags: ['work'] }),
      makeNote({ id: '3', tags: ['personal'] }),
    ];
    const out = extractAllTags(notes);
    expect(out).toEqual([
      { tag: 'work', count: 2 },
      { tag: 'personal', count: 1 },
      { tag: 'urgent', count: 1 },
    ]);
  });

  it('excludes soft-deleted notes', () => {
    const notes = [
      makeNote({ id: 'alive', tags: ['work'] }),
      makeNote({
        id: 'dead',
        tags: ['old'],
        deletedAt: Date.now(),
      }),
    ];
    expect(extractAllTags(notes)).toEqual([{ tag: 'work', count: 1 }]);
  });

  it('respects the limit argument', () => {
    const notes = [
      makeNote({ id: '1', tags: ['a'] }),
      makeNote({ id: '2', tags: ['b'] }),
      makeNote({ id: '3', tags: ['c'] }),
    ];
    expect(extractAllTags(notes, 2).length).toBe(2);
  });

  it('returns empty for notes-without-tags', () => {
    expect(extractAllTags([makeNote({}), makeNote({})])).toEqual([]);
  });

  it('handles notes with undefined tags (legacy) without crashing', () => {
    const notes = [
      makeNote({ id: 'legacy' /* no tags field */ }),
      makeNote({ id: 'modern', tags: ['new'] }),
    ];
    expect(extractAllTags(notes)).toEqual([{ tag: 'new', count: 1 }]);
  });
});

describe('sortRootNotes + comparators', () => {
  const a = makeNote({ id: 'a', order: 30, title: 'Banana', updatedAt: 100, createdAt: 50 });
  const b = makeNote({ id: 'b', order: 10, title: 'apple', updatedAt: 200, createdAt: 70 });
  const c = makeNote({ id: 'c', order: 20, title: 'Cherry', updatedAt: 150, createdAt: 30 });

  it('manual mode sorts ascending by note.order', () => {
    expect(sortRootNotes([a, b, c], 'manual').map((n) => n.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('updatedAt mode supports ascending and descending directions', () => {
    expect(sortRootNotes([a, b, c], 'updatedAt', 'asc').map((n) => n.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(sortRootNotes([a, b, c], 'updatedAt', 'desc').map((n) => n.id)).toEqual([
      'b',
      'c',
      'a',
    ]);
  });

  it('createdAt mode supports ascending and descending directions', () => {
    expect(sortRootNotes([a, b, c], 'createdAt', 'asc').map((n) => n.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
    expect(sortRootNotes([a, b, c], 'createdAt', 'desc').map((n) => n.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('title mode supports ascending and descending directions', () => {
    expect(sortRootNotes([a, b, c], 'title', 'asc').map((n) => n.title)).toEqual([
      'apple',
      'Banana',
      'Cherry',
    ]);
    expect(sortRootNotes([a, b, c], 'title', 'desc').map((n) => n.title)).toEqual([
      'Cherry',
      'Banana',
      'apple',
    ]);
  });

  it('does not mutate the input array', () => {
    const ids = [a, b, c].map((n) => n.id);
    const before = JSON.stringify(ids);
    sortRootNotes([a, b, c], 'updatedAt');
    expect(JSON.stringify(ids)).toBe(before);
  });

  it('handles empty / single-element arrays without crashing', () => {
    expect(sortRootNotes([], 'manual')).toEqual([]);
    expect(sortRootNotes([a], 'manual')).toEqual([a]);
  });

  it('defaults to manual ascending for backwards compatibility', () => {
    expect(DEFAULT_SORT_MODE).toBe('manual');
    expect(DEFAULT_SORT_DIRECTION).toBe('asc');
  });

  it('accepts every supported direction', () => {
    const directions: SortDirection[] = ['asc', 'desc'];
    for (const direction of directions) {
      expect(sortRootNotes([a, b], 'manual', direction)).toHaveLength(2);
    }
  });

  it('every SortMode value has a registered comparator', () => {
    const modes: SortMode[] = ['manual', 'updatedAt', 'title', 'createdAt'];
    for (const m of modes) {
      expect(typeof ROOT_SORT_COMPARATORS[m]).toBe('function');
    }
  });
});
