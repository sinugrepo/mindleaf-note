import { describe, it, expect } from 'vitest';
import {
  parseImportedNotes,
  parseImportedBackup,
  importBackupFromFile,
  BACKUP_FILE_PREFIX,
} from '../lib/notes-io';

// The min image data URL prefix; mirrors what TipTap stores when a user
// pastes/drops a base64-bearing image. parseImportedNotes is the choke
// point between an arbitrary on-disk JSON blob and bulkPut into Dexie, so
// it must preserve long strings byte-for-byte.
const IMAGE_DATA_URL = 'data:image/png;base64,iVBORw0KGgo' + 'A'.repeat(180_000);

describe('parseImportedNotes', () => {
  describe('non-array inputs', () => {
    it('returns [] for null', () => {
      expect(parseImportedNotes(null)).toEqual([]);
    });

    it('returns [] for undefined', () => {
      expect(parseImportedNotes(undefined)).toEqual([]);
    });

    it('returns [] for a primitive string', () => {
      expect(parseImportedNotes('not json')).toEqual([]);
    });

    it('returns [] for a primitive number', () => {
      expect(parseImportedNotes(42)).toEqual([]);
    });

    it('returns [] for a boolean', () => {
      expect(parseImportedNotes(true)).toEqual([]);
    });

    it('returns [] for an empty object', () => {
      expect(parseImportedNotes({})).toEqual([]);
    });

    it('returns [] for an object that is not an array (e.g. wrapper-shape)', () => {
      // A future export format that wraps the array in an object should
      // be rejected by the validator; the caller is responsible for
      // unwrapping before calling parseImportedNotes. This test pins that
      // contract for now.
      expect(parseImportedNotes({ version: 1, notes: [] })).toEqual([]);
    });
  });

  describe('array of invalid entries', () => {
    it('returns [] when every entry lacks required fields', () => {
      expect(parseImportedNotes([{}, {}, {}])).toEqual([]);
    });

    it('returns [] when entries are not objects (strings, numbers)', () => {
      expect(parseImportedNotes(['a', 1, null, undefined])).toEqual([]);
    });

    it('filters out entries missing string `id`', () => {
      const input = [
        { content: 'no id' },
        { id: 123, content: 'numeric id' }, // wrong type (number)
        { id: null, content: 'null id' }, // wrong type (typeof null === 'object')
      ];
      expect(parseImportedNotes(input)).toEqual([]);
    });

    it('filters out entries missing string `content`', () => {
      const input = [
        { id: 'a' /* no content */ },
        { id: 'b', content: 42 }, // wrong type
        { id: 'c', content: null }, // wrong type
      ];
      expect(parseImportedNotes(input)).toEqual([]);
    });

    it('keeps entries that have a structural string id but content is "" (empty is still a string)', () => {
      // Important regression guard: the editor loads `content` even when
      // empty. Filtering out empty content would silently drop newly-
      // created-but-unsaved notes on round-trip.
      const result = parseImportedNotes([{ id: 'a', content: '' }]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('a');
      expect(result[0].content).toBe('');
    });
  });

  describe('field type coercion (defaults & overrides)', () => {
    it('applies safe defaults for missing optional fields', () => {
      const result = parseImportedNotes([{ id: 'a', content: 'hi' }]);
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'a',
        content: 'hi',
        parentId: null,
        title: 'Untitled',
        order: 0,
        isExpanded: false,
        createdAt: 0,
        updatedAt: 0,
      });
      // isFolder is optional on Note and should NOT be set when missing.
      expect(result[0].isFolder).toBeUndefined();
    });

    it('preserves parentId when it is a string', () => {
      const result = parseImportedNotes([
        { id: 'a', content: 'hi', parentId: 'parent-x' },
      ]);
      expect(result[0].parentId).toBe('parent-x');
    });

    it('coerces non-string parentId to null (defensive against typo/migration)', () => {
      const result = parseImportedNotes([
        { id: 'a', content: 'hi', parentId: 42 },
        { id: 'b', content: 'hi', parentId: null },
      ]);
      expect(result[0].parentId).toBeNull();
      expect(result[1].parentId).toBeNull();
    });

    it('preserves valid title and falls back to "Untitled" otherwise', () => {
      const result = parseImportedNotes([
        { id: 'a', content: '', title: 'My Note' },
        { id: 'b', content: '', title: 42 }, // wrong type
      ]);
      expect(result[0].title).toBe('My Note');
      expect(result[1].title).toBe('Untitled');
    });

    it('preserves numeric order and coerces non-numbers to 0', () => {
      const result = parseImportedNotes([
        { id: 'a', content: '', order: 100 },
        { id: 'b', content: '', order: '50' }, // string — coerce
        { id: 'c', content: '', order: null }, // null — coerce
      ]);
      expect(result[0].order).toBe(100);
      expect(result[1].order).toBe(0);
      expect(result[2].order).toBe(0);
    });

    it('preserves boolean isExpanded and rejects non-booleans', () => {
      const result = parseImportedNotes([
        { id: 'a', content: '', isExpanded: true },
        { id: 'b', content: '', isExpanded: false },
        { id: 'c', content: '', isExpanded: 'true' }, // string — coerce
      ]);
      expect(result[0].isExpanded).toBe(true);
      expect(result[1].isExpanded).toBe(false);
      expect(result[2].isExpanded).toBe(false);
    });

    it('preserves numeric createdAt/updatedAt and coerces others to 0', () => {
      const result = parseImportedNotes([
        {
          id: 'a',
          content: '',
          createdAt: 1_700_000_000_000,
          updatedAt: 1_700_000_000_500,
        },
        { id: 'b', content: '', createdAt: 'today', updatedAt: null },
      ]);
      expect(result[0].createdAt).toBe(1_700_000_000_000);
      expect(result[0].updatedAt).toBe(1_700_000_000_500);
      expect(result[1].createdAt).toBe(0);
      expect(result[1].updatedAt).toBe(0);
    });

    it('preserves isFolder=true and leaves it undefined for missing/non-boolean', () => {
      const result = parseImportedNotes([
        { id: 'a', content: '', isFolder: true },
        { id: 'b', content: '', isFolder: 'true' }, // wrong type
        { id: 'c', content: '' /* missing */ },
      ]);
      expect(result[0].isFolder).toBe(true);
      expect(result[1].isFolder).toBeUndefined();
      expect(result[2].isFolder).toBeUndefined();
    });
  });

  describe('mixed valid + invalid entries', () => {
    it('keeps valid entries and drops invalid ones from the same array', () => {
      const input = [
        { id: 'good-1', content: 'un texto', title: 'Good 1' },
        { /* missing id */ content: 'no id' },
        { id: 'good-2', content: 'images below', title: 'Good 2' },
        null, // non-object entry
        'string entry',
        { id: 'no-content' /* missing content */ },
      ];
      const result = parseImportedNotes(input);
      expect(result).toHaveLength(2);
      expect(result.map((n) => n.id)).toEqual(['good-1', 'good-2']);
    });
  });

  describe('heavy payloads (regression guard for image-loss bug)', () => {
    it('preserves a long base64 image data URL in `content` byte-for-byte', () => {
      // The store stores HTML-wrapped images (TipTap emits
      // `<p><img src="data:..." /></p>`), so we mirror that shape here so
      // the `toBe(content)` check exercises the exact round-trip string.
      const content = `<p>cap</p><p><img src="${IMAGE_DATA_URL}" alt="pic" /></p>`;
      const input = [{ id: 'im-a', title: 'Image A', content }];
      const result = parseImportedNotes(input);
      expect(result).toHaveLength(1);
      // Byte-for-byte round-trip: any whitespace stripping, escaping, or
      // truncation here would silently destroy the image.
      expect(result[0].content).toBe(content);
      // Spot-check the embedded data-URL prefix survives the parser.
      expect(result[0].content).toContain('data:image/png;base64,');
      expect(result[0].content).toContain('alt="pic"');
    });

    it('preserves many image-bearing entries in a single batch', () => {
      const input = Array.from({ length: 5 }, (_, i) => ({
        id: `im-${i}`,
        title: `Image ${i}`,
        content: `<p><img src="${IMAGE_DATA_URL}${i}" alt="${i}" /></p>`,
      }));
      const result = parseImportedNotes(input);
      expect(result).toHaveLength(5);
      for (const [i, note] of result.entries()) {
        expect(note.id).toBe(`im-${i}`);
        expect(note.content).toContain(`alt="${i}"`);
      }
    });
  });

  describe('edge case: empty string ids', () => {
    // PINS current behavior: `typeof id === 'string'` is `'true'` even
    // for `""`, so the validator currently passes an empty id through.
    // If we ever tighten the validator to reject empty ids, this test
    // will flip and we will need to update Dexie write paths in tandem
    // (or add a separate fallback-id scheme). Until that decision is
    // made, the test guards against a silent behavior drift.
    it('currently passes an empty-string id through (no rejection at validator)', () => {
      const result = parseImportedNotes([{ id: '', content: 'x' }]);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('');
    });
  });

  describe('exported module constants', () => {
    it('exports BACKUP_FILE_PREFIX used by export download filename', () => {
      // Pin the prefix so a future rename is an explicit, search-visible
      // change rather than a silent rename that breaks importers' file
      // filters.
      expect(BACKUP_FILE_PREFIX).toBe('treenote-backup');
    });
  });
});

describe('parseImportedBackup (v2 format with attachments)', () => {
  it('parses a top-level array as legacy v1 (notes only, no attachments)', () => {
    const result = parseImportedBackup([{ id: 'a', content: '<p>hi</p>' }]);
    expect(result).not.toBeNull();
    expect(result!.notes).toHaveLength(1);
    expect(result!.notes[0].id).toBe('a');
    expect(result!.attachments).toEqual([]);
  });

  it('parses a v2 object with notes + attachments', () => {
    const input = {
      version: 2,
      notes: [{ id: 'a', content: '<p>hi</p>' }],
      attachments: [
        {
          id: 'att-1',
          noteId: 'a',
          mime: 'image/png',
          name: 'pic.png',
          createdAt: 100,
          dataBase64: 'iVBORwAAAAA',
        },
      ],
    };
    const result = parseImportedBackup(input);
    expect(result).not.toBeNull();
    expect(result!.notes).toHaveLength(1);
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0]).toMatchObject({
      id: 'att-1',
      noteId: 'a',
      mime: 'image/png',
      name: 'pic.png',
      createdAt: 100,
    });
    expect(result!.attachments[0].dataBase64).toBe('iVBORwAAAAA');
  });

  it('returns null on unrecognized shapes', () => {
    expect(parseImportedBackup(null)).toBeNull();
    expect(parseImportedBackup(undefined)).toBeNull();
    expect(parseImportedBackup('foo')).toBeNull();
    expect(parseImportedBackup(42)).toBeNull();
    expect(parseImportedBackup({ version: 99, notes: [] })).toBeNull();
    // v2 marker but notes missing or wrong shape -> rejected
    expect(parseImportedBackup({ version: 2 })).toBeNull();
    expect(parseImportedBackup({ version: 2, notes: 'not-an-array' })).toBeNull();
  });

  it('filters invalid attachments out but keeps the valid ones', () => {
    const input = {
      version: 2,
      notes: [{ id: 'a', content: '<p>hi</p>' }],
      attachments: [
        { id: 'good', noteId: 'a', mime: 'image/png', dataBase64: 'aaa' },
        // missing required fields
        { id: 'bad-no-mime', noteId: 'a', dataBase64: 'aaa' },
        { noteId: 'a', mime: 'image/png', dataBase64: 'aaa' /* id missing */ },
        // wrong type for dataBase64
        { id: 'bad', noteId: 'a', mime: 'image/png', dataBase64: 42 },
      ],
    };
    const result = parseImportedBackup(input);
    expect(result).not.toBeNull();
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].id).toBe('good');
  });

  it('legacy array of malformed notes returns empty notes + empty attachments (not null)', () => {
    // A legacy v1 backup with garbage data must not cascade into a
    // failed import — the Sidebar user sees a clean alert path.
    const result = parseImportedBackup([{}, {}]);
    expect(result).not.toBeNull();
    expect(result!.notes).toEqual([]);
    expect(result!.attachments).toEqual([]);
  });
});

describe('importBackupFromFile (integration: hydrate + migrate)', () => {
  it('hydrates base64 attachments into Blob rows', async () => {
    const backup = {
      version: 2,
      notes: [{ id: 'a', content: '<p>hi</p>' }],
      attachments: [
        {
          id: 'att-x',
          noteId: 'a',
          mime: 'image/png',
          name: 'p.png',
          createdAt: 50,
          dataBase64: 'iVBORw0KGgo',
        },
      ],
    };
    const file = new File([JSON.stringify(backup)], 'backup.treenote', {
      type: 'application/json',
    });
    const result = await importBackupFromFile(file);
    expect(result).not.toBeNull();
    expect(result!.notes).toHaveLength(1);
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].blob).toBeInstanceOf(Blob);
    expect(result!.attachments[0].blob.size).toBeGreaterThan(0);
    expect(result!.attachments[0].mime).toBe('image/png');
  });

  it('rewrites leftover inline base64 data URLs into attachment:<uuid> refs', async () => {
    const backup = {
      version: 2,
      notes: [
        {
          id: 'a',
          // Legacy inline data URL the v2 export itself could have
          // left behind (e.g. exported from a pre-attachments build).
          content: '<p><img src="data:image/png;base64,iVBORw0KGgo" /></p>',
        },
      ],
      attachments: [],
    };
    const file = new File([JSON.stringify(backup)], 'backup.treenote', {
      type: 'application/json',
    });
    const result = await importBackupFromFile(file);
    expect(result).not.toBeNull();
    expect(result!.notes[0].content).toMatch(
      /<img[^>]+src="attachment:[^"]+"/,
    );
    expect(result!.notes[0].content).not.toContain('data:image/png');
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments[0].blob).toBeInstanceOf(Blob);
  });

  it('returns null when the JSON body is not parseable', async () => {
    const file = new File(['not json'], 'garbage.treenote');
    const result = await importBackupFromFile(file);
    expect(result).toBeNull();
  });

  it('returns null when the JSON is not a recognized backup shape', async () => {
    const file = new File([JSON.stringify({ magic: 'no' })], 'x.treenote');
    const result = await importBackupFromFile(file);
    expect(result).toBeNull();
  });
});
