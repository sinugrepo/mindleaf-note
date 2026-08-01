import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { useEditor, EditorContent, type Editor as TiptapEditor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import type { EditorView } from '@tiptap/pm/view';
import type { Slice } from '@tiptap/pm/model';

import { EditorToolbar } from './EditorToolbar';
import { ResizableImage } from '../extensions/ResizableImage';
import { WikiLink } from '../extensions/WikiLink';
import { compressImage } from '../lib/image-upload';
import { db } from '../db/db';
import { ATTACHMENT_SRC_PREFIX, Note, Attachment } from '../types';
import { useStore } from '../store/useStore';
import { queuedPatchNote, queuedAddAttachment } from '../sync/queue';
import { format } from 'date-fns';
import { AlertCircle, CheckCircle2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { WIKILINK_ID_ATTR } from '../lib/wikilink';
import {
  WikiLinkAutocomplete,
  type WikiLinkAutocompleteHandle,
} from './WikiLinkAutocomplete';
import { BacklinksPanel } from './BacklinksPanel';
import { TagEditor } from './TagEditor';
import { AttachmentPanel } from './AttachmentPanel';
import { sanitizeHtml } from '../lib/sanitize';

// ---------------------------------------------------------------------------
// CROSS-FILE INVARIANT (do not remove without re-reading this comment):
//   This component MUST be mounted by Layout.tsx with `key={activeNoteId}`.
//   The init-once pattern below relies on a fresh `initializedRef` per note,
//   which only happens when React remounts the component on each noteId
//   change. If Layout.tsx ever drops the `key={...}` prop (e.g. to chase a
//   perf win), the ref will stay `true` across switches and the editor will
//   silently keep the previous note's content. The regression test in
//   Editor.test.tsx ("Editor (sync-revert regression)") guards against
//   reintroducing this pattern with the old continuous sync useEffect, but
//   it cannot guard against Layout.tsx losing the `key` prop — that part is
//   a human/architectural contract. Do NOT remove the `key={noteId}` line
//   in Layout.tsx without first porting the init-once logic to a per-noteId
//   reset (e.g. add `noteId` to the init useEffect's deps).
// ---------------------------------------------------------------------------
export function Editor({ noteId }: { noteId: string }) {
  const [note, setNote] = useState<Note | null>(null);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>(
    'idle',
  );

  // Load note initially and when noteId changes
  useEffect(() => {
    let active = true;
    const loadData = async () => {
      const data = await db.notes.get(noteId);
      if (active) {
        if (data && data.deletedAt == null) {
          setNote(data);
        } else {
          // Either the row is missing OR the note is soft-deleted
          // (deletedAt set). In both cases push the user back to the
          // empty-editor / tree state — opening a Trash item in the
          // editor would let them edit-then-revive-by-restoring which
          // is mind-bending UX.
          useStore.getState().setActiveNoteId(null);
        }
      }
    };
    loadData();
    return () => {
      active = false;
    };
  }, [noteId]);

  // Save logic — routes through the sync queue so mutations are
  // written optimistically to IndexedDB AND enqueued for backend push.
  const saveNote = useCallback(
    async (updates: Partial<Note>) => {
      setSaveStatus('saving');
      try {
        // Map Note field names to the queue's expected shape.
        // `order` → `order` (queue maps to `orderIdx` internally).
        const queueUpdates: Parameters<typeof queuedPatchNote>[1] = {};
        if (updates.title !== undefined) queueUpdates.title = updates.title;
        if (updates.content !== undefined) queueUpdates.content = updates.content;
        if (updates.isExpanded !== undefined) queueUpdates.isExpanded = updates.isExpanded;
        if (updates.order !== undefined) queueUpdates.order = updates.order;
        if (updates.parentId !== undefined) queueUpdates.parentId = updates.parentId;
        if (updates.tags !== undefined) queueUpdates.tags = updates.tags;
        await queuedPatchNote(noteId, queueUpdates);
        setSaveStatus('saved');
      } catch (e) {
        console.error('Failed to save note:', e);
        setSaveStatus('idle');
      }

      // Auto reset to idle after 2s
      setTimeout(() => {
        setSaveStatus((prev) => (prev === 'saved' ? 'idle' : prev));
      }, 2000);
    },
    [noteId],
  );

  // --- Refs for async-safe image insertion and save-on-unmount ---
  // editorProps (handlePaste/handleDrop) are memoized with [] deps so they
  // capture ref *objects* (stable identity) rather than live values.
  // This lets the async compressImage callback verify the editor is still
  // alive before dispatching a transaction, and lets onUpdate always call
  // the latest saveNote even if useEditor doesn't refresh its callback.
  const editorRef = useRef<TiptapEditor | null>(null);
  const saveNoteRef = useRef(saveNote);
  // Mirrors saveNoteRef so the async image-insert callback can attr the
  // new attachment row to the *current* note even though the original
  // handlePaste/handleDrop closure captured an earlier `noteId`.
  const noteIdRef = useRef(noteId);
  // null = never edited (skip flush); string = latest editor HTML (flush on unmount)
  const latestContentRef = useRef<string | null>(null);

  useEffect(() => {
    saveNoteRef.current = saveNote;
  }, [saveNote]);

  useEffect(() => {
    noteIdRef.current = noteId;
  }, [noteId]);

  // Imperative handle for the `[[Note Title]]` autocomplete popover.
  // Wired below via JSX `ref`. Keeps the Editor's editorProps.handleKeyDown
  // aware of whether the popover is currently open without prop-drilling
  // its internal `activeQuery`/`ranked` state through React every keystroke.
  const autocompleteRef = useRef<WikiLinkAutocompleteHandle | null>(null);

  const extensions = React.useMemo(
    () => [
      StarterKit.configure({ link: false }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Link.configure({
        openOnClick: false,
        HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
      }),
      ResizableImage,
      // Inline wiki-style `[[Note Title]]` links. Stored as
      // `<span data-wikilink-id>` and click-handled by `handleClick` on
      // editorProps (returned false from the default handler) below.
      WikiLink,
    ],
    [],
  );

  // Memoized so its identity is stable for useEditor's dep array AND
  // so the autocomplete's handleKeyDown can read the latest ref without
  // forcing us to re-create the editor on each render.
  // We pass a getter for handleKeyDown/handleClick so the autocomplete
  // ref is consulted at *call* time rather than captured at memo time.
  const editorProps = React.useMemo(
    () => ({
      attributes: {
        class:
          'prose prose-sm dark:prose-invert max-w-none focus:outline-none min-h-[500px]',
      },
      // Click handler — intercepts clicks on `[data-wikilink-id]` spans
      // emitted by the WikiLink mark and dispatches navigation. Returning
      // `true` stops ProseMirror's default click handling (which would
      // just collapse the selection without doing anything useful
      // anyway).
      handleClick: (view: EditorView, _pos: number, event: MouseEvent) => {
        const target = event.target as HTMLElement | null;
        const closest = target?.closest?.(`[${WIKILINK_ID_ATTR}]`);
        if (!closest) return false;
        const targetId = closest.getAttribute(WIKILINK_ID_ATTR);
        if (!targetId) return false;
        event.preventDefault();
        useStore.getState().setActiveNoteId(targetId);
        return true;
      },
      // Key handler — routes ArrowUp/Down/Enter/Escape to the
      // autocomplete when its popover is open. Returning `true`
      // suppresses TipTap's default keybinding for that keystroke.
      handleKeyDown: (
        view: EditorView,
        event: KeyboardEvent,
      ): boolean => {
        const ac = autocompleteRef.current;
        if (!ac || !ac.isOpen()) return false;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          ac.moveSelection(1);
          return true;
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault();
          ac.moveSelection(-1);
          return true;
        }
        if (event.key === 'Enter') {
          // Only consume Enter when commitSelection actually inserts
          // a wikiLink. When the popover has zero candidates (no
          // matching notes), commitSelection returns false and we
          // fall through to TipTap's default behaviour — a newline
          // or chip split as normal.
          if (!ac.commitSelection()) return false;
          event.preventDefault();
          return true;
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          return ac.dismiss();
        }
        return false;
      },
      handlePaste: (view: EditorView, event: ClipboardEvent) => {
        const items = event.clipboardData?.items;
        if (!items) return false;

        let hasImage = false;
        for (const item of Array.from(items) as DataTransferItem[]) {
          if (item.type.indexOf('image') === 0) {
            hasImage = true;
            event.preventDefault();
            const file = item.getAsFile();
            if (file) {
              const noteIdForAttachment = noteIdRef.current;
              compressImage(file)
                .then(async (blob) => {
                  const ed = editorRef.current;
                  if (!ed || ed.isDestroyed) return;
                  // Persist the compressed Blob in the attachments table
                  // and reference it from the editor via the stable
                  // `attachment:<id>` URL scheme (resolved to a `blob:`
                  // URL by the ResizableImage NodeView). Awaiting the
                  // insert ensures a transient IndexedDB failure
                  // surfaces BEFORE we lay down an editor node pointing
                  // at a row that isn't there yet.
                  // Refuse to attribute an attachment to an empty note id. The
                  // Editor is normally only mounted for an active note, but
                  // a paste racing the most recent unmount/mount could
                  // expose a stale or empty ref value. Returning here is
                  // preferable to writing an empty-noteId row that would
                  // become an orphan in the attachments table.
                  if (!noteIdForAttachment) return;
                  const id = uuidv4();
                  const att: Attachment = {
                    id,
                    noteId: noteIdForAttachment,
                    blob,
                    mime: blob.type,
                    name: file.name,
                    createdAt: Date.now(),
                  };
                  await queuedAddAttachment(att);
                  const imageType = ed.state.schema.nodes.image;
                  if (!imageType) return;
                  const node = imageType.create({
                    src: `${ATTACHMENT_SRC_PREFIX}${id}`,
                    width: '100%',
                  });
                  const transaction = ed.state.tr.replaceSelectionWith(node);
                  ed.view.dispatch(transaction);
                })
                .catch(() => {
                  /* compression or DB write failed — ignore */
                });
            }
          }
        }
        return hasImage;
      },
      handleDrop: (
        view: EditorView,
        event: DragEvent,
        slice: Slice,
        moved: boolean,
      ) => {
        if (
          !moved &&
          event.dataTransfer &&
          event.dataTransfer.files &&
          event.dataTransfer.files.length > 0
        ) {
          const file = event.dataTransfer.files[0];
          if (file.type.indexOf('image') === 0) {
            event.preventDefault();
            const dropX = event.clientX;
            const dropY = event.clientY;
            const noteIdForAttachment = noteIdRef.current;
            compressImage(file)
              .then(async (blob) => {
                const ed = editorRef.current;
                if (!ed || ed.isDestroyed) return;
                // Refuse to write an attachment row when no note is
                // active. Same rationale as the handlePaste branch:
                // writing an empty-noteId row here would silently create
                // an orphan on the attachments table (gcAttachments will
                // eventually delete it, but in the meantime it pollutes
                // storage and the editor insert is moot since ed is
                // unmountable).
                if (!noteIdForAttachment) return;
                const id = uuidv4();
                const att: Attachment = {
                  id,
                  noteId: noteIdForAttachment,
                  blob,
                  mime: blob.type,
                  name: file.name,
                  createdAt: Date.now(),
                };
                await queuedAddAttachment(att);
                const { schema } = ed.state;
                const imageType = schema.nodes.image;
                if (!imageType) return;
                const coordinates = ed.view.posAtCoords({
                  left: dropX,
                  top: dropY,
                });
                if (coordinates) {
                  const node = imageType.create({
                    src: `${ATTACHMENT_SRC_PREFIX}${id}`,
                    width: '100%',
                  });
                  const transaction = ed.state.tr.insert(coordinates.pos, node);
                  ed.view.dispatch(transaction);
                }
              })
              .catch(() => {
                /* compression or DB write failed — ignore */
              });
            return true;
          }
        }
        return false;
      },
    }),
    [],
  );

  const editor = useEditor({
    extensions,
    content: '',
    editorProps,
    onUpdate: ({ editor }) => {
      const html = editor.getHTML();
      latestContentRef.current = html;
      saveNoteRef.current({ content: html });
    },
  });

  // Initialize TipTap once when the note's content first arrives from Dexie.
  // Subsequent re-renders (saveStatus flips, title edits, saveNote completion)
  // MUST NOT call setContent — the editor is treated as an uncontrolled input
  // after this initial load. Without this guard, the prior sync useEffect
  // used to compare editor.getHTML() against the *stale* local `note.content`
  // snapshot on every re-render, and when the two diverged (e.g. immediately
  // after a paste that left editor.isFocused=false) it called
  //   editor.commands.setContent(note.content, { emitUpdate: false })
  // which silently wiped the just-pasted image from the editor. Any
  // subsequent keystroke would then save the empty-image HTML over the
  // original in IndexedDB. Initializing exactly once closes this window —
  // see the CROSS-FILE INVARIANT block at the top of this file for the
  // Layout.tsx coupling that makes this safe.
  const initializedRef = useRef<boolean>(false);
  useEffect(() => {
    if (editor && note && !initializedRef.current) {
      editor.commands.setContent(sanitizeHtml(note.content), { emitUpdate: false });
      initializedRef.current = true;
    }
  }, [editor, note]);

  // Keep editorRef in sync so async paste/drop handlers can check whether
  // the editor is still alive before dispatching.
  useEffect(() => {
    editorRef.current = editor;
    return () => {
      editorRef.current = null;
    };
  }, [editor]);

  // Flush unsaved content when the Editor unmounts. Routes through
  // the sync queue so the mutation is enqueued even if the backend is
  // offline at unmount time.
  useEffect(() => {
    return () => {
      if (latestContentRef.current !== null) {
        queuedPatchNote(noteId, { content: latestContentRef.current }).catch(() => {
          /* best-effort flush on unmount */
        });
      }
    };
  }, [noteId]);

  // Test-only escape hatch: expose the TipTap instance on `window` so unit
  // tests can drive it deterministically (e.g. via `editor.commands.setContent`)
  // without depending on TipTap's paste/drop handlers reliably firing in jsdom.
  // We test for Vitest's runtime marker (`globalThis.vi` is set by Vitest)
  // rather than NODE_ENV, because Vite/Vitest's NODE_ENV handling varies.
  // In a production build, neither condition holds and the closure is dead.
  useEffect(() => {
    if (!editor || typeof window === 'undefined') return;
    const isVitest = typeof (globalThis as { vi?: unknown }).vi !== 'undefined';
    if (!isVitest) return;
    (window as unknown as { __editorForTest?: unknown }).__editorForTest = editor;
    return () => {
      // Delete (not null): avoids the property lingering on `window` between
      // tests; the test-side `if (!editor) throw` already treats both null
      // and undefined as missing.
      delete (window as unknown as { __editorForTest?: unknown }).__editorForTest;
    };
  }, [editor]);

  if (!note) {
    return <div className="p-8 text-zinc-500">Loading note...</div>;
  }

  return (
    <div className="flex-1 flex flex-col h-full overflow-hidden relative">
      {/* Editor Header / Meta Info */}
      <div className="shrink-0 px-5 md:px-8 pt-16 md:pt-8 pb-4 border-b border-transparent dark:border-transparent transition-all">
        <input
          type="text"
          value={note.title}
          onChange={(e) => {
            setNote({ ...note, title: e.target.value });
            saveNote({ title: e.target.value });
          }}
          className="text-4xl font-semibold bg-transparent border-0 p-0 focus:outline-none focus:ring-0 w-full text-zinc-900 dark:text-zinc-50 mb-2 placeholder:text-zinc-300 dark:placeholder:text-zinc-700"
          placeholder="Untitled Note"
        />
        <div className="flex items-center gap-4 text-xs text-zinc-400 dark:text-zinc-500 font-mono">
          <span>Created: {format(note.createdAt, 'MMM d, yyyy HH:mm')}</span>
          <span>Updated: {format(note.updatedAt, 'MMM d, yyyy HH:mm')}</span>

          <div className="flex items-center gap-1.5 ml-auto">
            {saveStatus === 'saving' && (
              <>
                <AlertCircle className="w-3.5 h-3.5 text-blue-500 animate-pulse" />
                <span>Saving...</span>
              </>
            )}
            {saveStatus === 'saved' && (
              <>
                <CheckCircle2 className="w-3.5 h-3.5 text-zinc-400" />
                <span>Saved</span>
              </>
            )}
          </div>
        </div>

        {/* BacklinksPanel renders nothing when there are no
            inbound wiki links. Live-queries db.notes so cross-note
            edits show up without a tree refresh. */}
        <BacklinksPanel activeNoteId={note.id} />

        {/* Tag chip editor for THIS note. CRUD operations write back
            straight to db.notes via the v4 schema's `tags` field;
            siblings in other notes appear as typeahead suggestions. */}
        <TagEditor noteId={note.id} />
        <AttachmentPanel noteId={note.id} />
      </div>

      {/* Tiptap Editor Area */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden px-5 md:px-8 pb-16 pt-2">
        <EditorToolbar editor={editor} />
        <EditorContent editor={editor} />
      </div>

      {/* WikiLink autocomplete popover. position:fixed so it floats over
          the editor and isn't clipped by the scroll container's
          overflow. Only paints anything when findActiveWikiQuery is
          willing. */}
      <WikiLinkAutocomplete
        ref={autocompleteRef}
        editor={editor}
        excludeNoteId={note.id}
      />
    </div>
  );
}
