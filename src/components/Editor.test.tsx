import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent, act } from '@testing-library/react';
import { Editor } from './Editor';
import { db } from '../db/db';
import { useStore } from '../store/useStore';
import type { Note } from '../types';

// A tiny 1x1 transparent PNG (real bytes) encoded as a base64 data URL.
// This is what TipTap stores as the <img src="..."> once we paste/drop an image.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const IMAGE_DATA_URL = `data:image/png;base64,${TINY_PNG_BASE64}`;

function makeNote(partial: Partial<Note>): Note {
  return {
    id: partial.id ?? 'n',
    parentId: null,
    title: partial.title ?? 'X',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  } as Note;
}

describe('Editor (integration): image persistence across note-key changes', () => {
  beforeEach(async () => {
    // Reset DB and persisted Zustand state between tests to avoid leakage.
    await db.notes.clear();
    localStorage.clear();
    useStore.setState({ activeNoteId: null, searchQuery: '', theme: 'system' });
  });

  afterEach(() => {
    cleanup();
  });

  it('keeps note A image content intact when Editor key changes from A to B', async () => {
    // --- Arrange: pre-seed IndexedDB with two notes ------------------
    // Note A holds an embedded image (the case the user reported losing).
    const noteAContent = `<p>before image</p><p><img src="${IMAGE_DATA_URL}" alt="pic" /></p>`;
    const noteA = makeNote({
      id: 'note-a',
      title: 'Alpha',
      content: noteAContent,
      order: 1,
    });
    const noteB = makeNote({
      id: 'note-b',
      title: 'Bravo',
      content: '<p>hello B</p>',
      order: 2,
    });
    await db.notes.bulkAdd([noteA, noteB]);

    // --- Act 1: render the Editor for note A with key="note-a" -----
    // This mirrors how <Layout /> mounts <Editor key={activeNoteId} ... />.
    const { rerender } = render(<Editor key="note-a" noteId="note-a" />);

    // The Editor fetches the note asynchronously (db.notes.get in a useEffect).
    // Wait until the title input reflects the loaded note A.
    await waitFor(() => {
      expect(screen.getByDisplayValue('Alpha')).toBeInTheDocument();
    });

    // --- Act 2: switch by changing the key (simulates clicking another
    //            note in the sidebar, which updates activeNoteId, which
    //            causes Layout to remount the Editor with a new key). --
    rerender(<Editor key="note-b" noteId="note-b" />);

    await waitFor(() => {
      expect(screen.getByDisplayValue('Bravo')).toBeInTheDocument();
    });

    // --- Assert: critical regression guard --------------------------
    // Without the `key` fix, the OLD Editor's onUpdate closure captured
    // saveNote for note-a. When setContent(B) replaced the document, that
    // stale callback could overwrite note A in IndexedDB with whatever the
    // editor now contains (note B's content), silently losing the image.
    // With the key fix the Editor is a fresh instance on every switch.
    const savedA = await db.notes.get('note-a');
    expect(savedA).toBeDefined();
    expect(savedA?.title).toBe('Alpha');
    // The non-image portion of A's body must survive too — locks in that
    // the round-trip wasn't a partial rewrite that just happened to keep
    // the image tag.
    expect(savedA?.content).toContain('before image');
    expect(savedA?.content).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);
    // And we definitely did NOT replace A's body with B's body.
    expect(savedA?.content).not.toContain('hello B');

    // Sanity: note B's row is still intact and its own content untouched.
    const savedB = await db.notes.get('note-b');
    expect(savedB?.title).toBe('Bravo');
    expect(savedB?.content).toContain('hello B');
  });

  it('repeated key changes between notes never lose either note content', async () => {
    // Pre-seed three notes; only the first carries an image.
    await db.notes.bulkAdd([
      makeNote({
        id: 'img-note',
        title: 'With Image',
        content: `<p><img src="${IMAGE_DATA_URL}" alt="x" /></p>`,
        order: 1,
      }),
      makeNote({ id: 'plain-1', title: 'Plain 1', content: '<p>plain one</p>', order: 2 }),
      makeNote({ id: 'plain-2', title: 'Plain 2', content: '<p>plain two</p>', order: 3 }),
    ]);

    const { rerender } = render(<Editor key="img-note" noteId="img-note" />);
    await waitFor(() => expect(screen.getByDisplayValue('With Image')).toBeInTheDocument());

    // Toggle between three notes, in order, twice.
    const sequence: Array<{ id: string; title: string }> = [
      { id: 'plain-1', title: 'Plain 1' },
      { id: 'plain-2', title: 'Plain 2' },
      { id: 'img-note', title: 'With Image' },
      { id: 'plain-1', title: 'Plain 1' },
      { id: 'plain-2', title: 'Plain 2' },
      { id: 'img-note', title: 'With Image' },
    ];

    for (const step of sequence) {
      rerender(<Editor key={step.id} noteId={step.id} />);
      // eslint-disable-next-line no-await-in-loop
      await waitFor(() => expect(screen.getByDisplayValue(step.title)).toBeInTheDocument());
    }

    // Final state: the image-bearing note must still hold its image.
    const stillImgNote = await db.notes.get('img-note');
    expect(stillImgNote?.content).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);

    // And the other two notes must still hold their original text content.
    const stillPlain1 = await db.notes.get('plain-1');
    expect(stillPlain1?.content).toContain('plain one');

    const stillPlain2 = await db.notes.get('plain-2');
    expect(stillPlain2?.content).toContain('plain two');
  });
});

// ---------------------------------------------------------------------------
// Sync-revert regression (Option D: init-once via initializedRef).
//
// The bug: TipTap fires `onUpdate` which calls `saveNote` -> setSaveStatus
//   'saving' -> React re-render. On that re-render the OLD sync useEffect
//   compared `editor.getHTML()` to the stale local `note.content` snapshot
//   and called `setContent(note.content, {emitUpdate:false})` when they
//   diverged while `editor.isFocused` was false (the common case right
//   after a paste/drop). That silently wiped out a freshly-pasted image
//   from the editor — and any subsequent keystroke then persisted the
//   empty-image HTML over IndexedDB.
//
// The fix (Option D): initialize TipTap exactly once when the note content
//   first arrives from Dexie; never re-sync after that.
// ---------------------------------------------------------------------------
describe('Editor (sync-revert regression)', () => {
  beforeEach(async () => {
    await db.notes.clear();
    localStorage.clear();
    useStore.setState({ activeNoteId: null, searchQuery: '', theme: 'system' });
  });

  afterEach(() => {
    cleanup();
  });

  it('does not erase a freshly-pasted image when the Editor re-renders while unfocused (init-once)', async () => {
    // Seed a note with simple text content (no image yet).
    await db.notes.bulkAdd([
      makeNote({ id: 'sync-test', title: 'Sync', content: '<p>Initial text</p>', order: 1 }),
    ]);

    // Render the Editor with `key` so it remounts cleanly per note.
    render(<Editor key="sync-test" noteId="sync-test" />);

    // Wait for the note to load (title visible in the header input).
    await waitFor(() => {
      expect(screen.getByDisplayValue('Sync')).toBeInTheDocument();
    });

    const editorEl = document.querySelector('.ProseMirror') as HTMLElement;
    expect(editorEl).not.toBeNull();

    // Initial content should be loaded.
    await waitFor(() => {
      expect(editorEl.textContent).toContain('Initial text');
    });

    // Drive TipTap via the test escape hatch exposed by Editor.tsx. We
    // assert on `editor.getHTML()` (ProseMirror's serialized model) rather
    // than the .ProseMirror DOM directly, because ReactNodeView renders the
    // `<img>` into a React portal which is slow to flush under StrictMode +
    // jsdom. The model state is the source of truth for what would survive
    // a sync-revert in production anyway.
    const editor = (window as unknown as {
      __editorForTest?: {
        commands: {
          setContent: (html: string, opts?: { emitUpdate?: boolean }) => boolean;
          blur: () => boolean;
        };
        getHTML: () => string;
        schema: {
          nodes: {
            image: {
              create: (attrs: { src: string; alt?: string }) => unknown;
            };
          };
        };
        state: {
          tr: {
            replaceWith: (from: number, to: number, node: unknown) => unknown;
          };
          doc: { contentSize: number };
        };
        view: {
          dispatch: (tr: unknown) => void;
        };
        // Compatibility: some TipTap builds return commands that include
        // .blur as a function (chained). Only used as `{ commands: { blur } }`.
      };
    }).__editorForTest;
    if (!editor) {
      throw new Error(
        'Test setup error: window.__editorForTest not set. ' +
          'Verify Vitest is the active runner and the escape-hatch useEffect ran.',
      );
    }

    // Use TipTap's native blur so the editor's `isFocused` flips to false
    // deterministically. (DOM-level `editorEl.blur()` may be missed by
    // ProseMirror's focus tracking in jsdom.)
    editor.commands.blur();

    // Drive an Image node into the document by going directly through
    // ProseMirror's schema API (NOT the HTML parser). The HTML parser in
    // jsdom dropped `<img>` inside `<p>` in our earlier attempts because
    // the base Image extension is `inline: false` while Paragraph expects
    // `inline*` content. Schema-direct insertion guarantees the node lands
    // in the model. Wrapped in `act()` so React flushes the resulting
    // OnUpdate -> setSaveStatus -> re-render cascade synchronously.
    act(() => {
      const imgType = editor.schema.nodes.image;
      if (!imgType) throw new Error('Test schema missing image node');
      // The `any` cast is justified: TipTap's `Node.create(attrs)` returns
      // a ProseMirror Node instance; we hand it to tr.replaceWith directly.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const imgNode = (imgType as any).create({ src: IMAGE_DATA_URL, alt: 'img' });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tr = (editor.state.tr as any).replaceWith(
        0,
        editor.state.doc.contentSize,
        imgNode,
      );
      editor.view.dispatch(tr);
    });

    // CRITICAL: the image must be present in the editor's model after the
    // dispatch + re-render settle. We assert against a regex that requires
    // BOTH the <img tag and a stable base64 prefix. This dual check defends
    // against: (a) tag-only regressions where the src was stripped/wrong,
    // and (b) spurious failures if ProseMirror's serializer ever starts
    // normalizing data-URL attribute bytes (e.g. URL-encoding).
    await waitFor(() => {
      expect(editor.getHTML()).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);
    }, { timeout: 4000, interval: 50 });

    // Trigger a re-render via the title input — same path production takes
    // when saveStatus flips from 'saving' to 'saved' or the user edits the
    // title. With the OLD sync useEffect, this re-render would re-compare
    // editor.getHTML() (with image) to stale note.content (without image)
    // and reset the editor when editor.isFocused was false.
    const titleInput = screen.getByDisplayValue('Sync');
    fireEvent.change(titleInput, { target: { value: 'Sync v2' } });

    // Wait for saveNote({title}) to drain — the title field on the IndexedDB
    // row will reflect the new value only after the awaited update resolves.
    await waitFor(async () => {
      const row = await db.notes.get('sync-test');
      expect(row?.title).toBe('Sync v2');
    }, { timeout: 2000 });

    // CRITICAL REGRESSION ASSERTION: image must survive the re-render.
    // In OLD code: editor.getHTML() = '<p>Initial text</p>' (reverted).
    // In OPTION D: editor stays with the image payload.
    expect(editor.getHTML()).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);

    // And the IndexedDB row's content should retain the actual image payload.
    // Same dual-marker regex as the in-editor check (tag + stable base64 prefix).
    const row = await db.notes.get('sync-test');
    expect(row?.content).toMatch(/<img[^>]+src="data:image\/png;base64,iVBORw0KGgo/);
  });
});
