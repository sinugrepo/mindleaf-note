import { describe, it, expect, beforeEach } from 'vitest';

/**
 * Regression tests for the IndexedDB schema.
 *
 * Bug being guarded against:
 *   - IndexedDB enforces a per-key size limit on indexed fields. When
 *     `content` was indexed (in schema v1), TipTap's onUpdate -> saveNote
 *     -> db.notes.update would silently fail with a DataError when the
 *     payload contained a base64 image (a few hundred KB), so the image
 *     never reached storage. The DOM looked correct while the editor was
 *     mounted, but after a note switch, page reload, or export -> import
 *     round-trip the image vanished.
 *
 * These tests pin the schema and verify that image-bearing content
 * round-trips through Dexie regardless of underlying storage backend
 * (real browser IndexedDB will enforce the size limit; fake-indexeddb used
 * in tests is permissive, so the schema assertion is the strong guard).
 */
import { db, migrateContentToAttachments } from '../db/db';
import type { Attachment, Note } from '../types';

// Match the factory shape used by the other test files in this repo so
// helpers stay interchangeable and TypeScript catches missing fields at
// call sites instead of silently leaving them off.
function makeNote(partial: Partial<Note> = {}): Note {
  return {
    id: partial.id ?? 'n',
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

// Single point where the `schema.indexes` element type is narrowed once, so
// individual assertions don't repeat the cast.
const indexedNames = (): string[] =>
  (db.table('notes').schema.indexes as Array<{ name: string }>).map(
    (i) => i.name,
  );

beforeEach(async () => {
  await db.notes.clear();
  await db.attachments.clear();
  await db.pendingMutations.clear();
  await db.syncState.clear();
});

describe('db schema (regression guard for image-loss bug)', () => {
  it('does NOT index "content" (must stay free of IndexedDB key-size limits)', () => {
    expect(indexedNames()).not.toContain('content');
  });

  it('does NOT index "title" (search is Fuse-based, not Dexie-based)', () => {
    expect(indexedNames()).not.toContain('title');
  });

  it('keeps the minimal set of indexes actually used: id (PK), parentId, order, tags, dirty, lastSyncedAt', () => {
    expect(db.table('notes').schema.primKey.name).toBe('id');
    // v4 schema added the multi-entry `*tags` index for the Tags
    // feature (Sidebar filter chip + Editor chip input). Earlier
    // versions had only `parentId` + `order`.
    // v5 schema added `dirty` and `lastSyncedAt` indexes for the
    // cloud sync layer (drainer queries dirty notes, pull checks
    // lastSyncedAt for delta sync).
    expect(indexedNames().sort()).toEqual(
      ['dirty', 'lastSyncedAt', 'order', 'parentId', 'tags'].sort(),
    );
  });
});

describe('db round-trip with image-bearing content', () => {
  it('persists a content field containing a real-sized base64 image data URL', async () => {
    // A ~200KB base64 image data URL — comfortably above any browser's
    // IndexedDB index-key size limit. With the old v1 schema (content
    // indexed), this update throws DataError on real browsers. With v2
    // (content not indexed) it round-trips intact.
    const PREFIX = 'data:image/png;base64,';
    const PNG_SIG = 'iVBORw0KGgo'; // First 8 bytes of every PNG, base64-encoded.
    const filler = 'A'.repeat(200 * 1024 - PREFIX.length - PNG_SIG.length);
    const payload = PREFIX + PNG_SIG + filler;

    await db.notes.add(makeNote({ id: 'big', title: 'Big', content: '<p>placeholder</p>' }));

    await expect(db.notes.update('big', { content: payload })).resolves.toBeDefined();

    const row = await db.notes.get('big');
    expect(row?.content.length).toBe(payload.length);
    // The base64 marker must survive the round-trip byte-for-byte (no
    // truncation, no escaping, no re-encoding by any store layer).
    expect(row?.content.startsWith(PREFIX)).toBe(true);
    expect(row?.content).toContain(PNG_SIG); // Real PNG signature prefix survives
  });

  it('export-style bulkPut preserves image content bit-exactly', async () => {
    // Mirrors the import flow in Sidebar.tsx: bulkPut an entire notes
    // array (the JSON.parse result of an exported backup). The exported
    // payload may carry image data URLs; bulkPut must not corrupt or drop
    // them.
    const longB64 = 'data:image/png;base64,' + 'B'.repeat(180 * 1024);
    const content = `<p>cap</p><p><img src="${longB64}" alt="pic" /></p>`;
    const notes = [
      makeNote({ id: 'a', title: 'Alpha', content, order: 1 }),
      makeNote({ id: 'b', title: 'Bravo', content: '<p>plain</p>', order: 2 }),
    ];

    await db.notes.bulkPut(notes);
    const all = await db.notes.toArray();
    const a = all.find((n) => n.id === 'a');
    expect(a?.content).toBe(content);

    const b = all.find((n) => n.id === 'b');
    expect(b?.content).toBe('<p>plain</p>');
  });
});

describe('db schema v3 (attachments table)', () => {
  it('declares an attachments table alongside notes', () => {
    const names = db.tables.map((t) => t.name);
    expect(names).toContain('attachments');
    expect(names).toContain('notes');
  });

  it('attachments table indexes id (PK) and noteId', () => {
    const attTable = db.table('attachments');
    expect(attTable.schema.primKey.name).toBe('id');
    const indexes = (attTable.schema.indexes as Array<{ name: string }>).map(
      (i) => i.name,
    );
    expect(indexes).toContain('noteId');
  });
});

describe('migrateContentToAttachments', () => {
  it('returns content unchanged when no data: URLs are present', async () => {
    const out: Attachment[] = [];
    const result = await migrateContentToAttachments(
      '<p>plain text</p>',
      'n1',
      out,
    );
    expect(result).toBe('<p>plain text</p>');
    expect(out).toHaveLength(0);
  });

  it('rewrites a single data: src to attachment:<uuid> and pushes a Blob row', async () => {
    const out: Attachment[] = [];
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo';
    const result = await migrateContentToAttachments(
      `<p><img src="${dataUrl}" alt="x" /></p>`,
      'note-A',
      out,
    );
    expect(out).toHaveLength(1);
    expect(out[0].noteId).toBe('note-A');
    expect(out[0].mime).toBe('image/png');
    expect(out[0].blob).toBeInstanceOf(Blob);
    expect(out[0].blob.size).toBeGreaterThan(0);
    expect(result).toMatch(/<img[^>]+src="attachment:[^"]+"/);
    expect(result).not.toContain('data:image/png');
    expect(result).toContain('alt="x"');
  });

  it('assigns a unique attachment id per image', async () => {
    const out: Attachment[] = [];
    const dataUrl = 'data:image/png;base64,iVBORw0KGgo';
    const content = `<p><img src="${dataUrl}" /></p><p><img src="${dataUrl}" /></p>`;
    await migrateContentToAttachments(content, 'n', out);
    expect(out).toHaveLength(2);
    expect(out[0].id).not.toBe(out[1].id);
  });

  it('migrates multiple images of mixed MIME types in one note', async () => {
    const out: Attachment[] = [];
    const content =
      '<p><img src="data:image/png;base64,iVBORw0KGgo" /></p>' +
      '<p><img src="data:image/jpeg;base64,/9j/4AAQ" /></p>';
    const result = await migrateContentToAttachments(content, 'n', out);
    expect(out).toHaveLength(2);
    expect(out.map((a) => a.mime).sort()).toEqual(['image/jpeg', 'image/png']);
    const matches = result.match(/attachment:/g) ?? [];
    expect(matches.length).toBe(2);
  });

  it('preserves non-image elements unchanged', async () => {
    const out: Attachment[] = [];
    const content = '<p>text <strong>bold</strong> more</p>';
    const result = await migrateContentToAttachments(content, 'n', out);
    expect(result).toBe(content);
    expect(out).toHaveLength(0);
  });

  it('leaves malformed data URLs intact (does not drop user data)', async () => {
    const out: Attachment[] = [];
    // `!!!not-base64!!!` is invalid base64 — atob will throw. The
    // migration must preserve the original markup so the image still
    // renders via the data: pass-through in ResizableImage.tsx.
    const content =
      '<p><img src="data:image/png;base64,!!!not-base64!!!" /></p>';
    const result = await migrateContentToAttachments(content, 'n', out);
    expect(out).toHaveLength(0);
    expect(result).toBe(content);
  });
});
