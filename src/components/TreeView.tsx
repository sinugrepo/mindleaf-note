import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Note } from '../types';
import { useStore } from '../store/useStore';
import {
  validateDropTarget,
  computeDropUpdates,
  findMoveSibling,
  computeOrderSwap,
  flattenTree,
  FlatTreeItem,
} from '../lib/tree-ops';
import {
  filterActiveNotesByTagSet,
  sortRootNotes,
} from '../lib/tags';
import {
  ChevronRight,
  ChevronDown,
  FileText,
  CornerDownRight,
  MoreVertical,
  Folder,
  FolderOpen,
  FolderPlus,
  Pencil,
} from 'lucide-react';
import { cn } from '../lib/utils';
import {
  createChildNote,
  createChildFolder,
  isActiveNote,
  renameNote,
  softDeleteNote,
  validateRenameTitle,
} from '../lib/notes';

/**
 * Fixed pixel height of every virtualized row. Picked to fit
 * `pr-2 py-1 + text-sm` (~28px content + 4px breathing room). Keeping
 * the value fixed means offsets are computed with simple math
 * (`index * ROW_HEIGHT`) — variable-height virtualization needs a
 * measurement loop and synchronizes poorly with native HTML5 D&D.
 */
const ROW_HEIGHT = 32;

/** Extra rows rendered above/below the visible window for smooth scroll. */
const OVERSCAN = 6;

export interface TreeViewProps {
  /**
   * Escape hatch for tests / non-DOM environments (jsdom). When true,
   * every row from `flattenTree(notes)` is rendered (no windowing).
   * Autodetected at runtime too: if the scroll container's
   * `clientHeight` is still 0 after mount (which happens in jsdom
   * because there is no real layout), windowing is disabled for that
   * render. Tests don't need to pass this prop in practice.
   */
  disableVirtualization?: boolean;
}

export function TreeView({ disableVirtualization: dvProp }: TreeViewProps = {}) {
  // Fetch the full table once with useLiveQuery, then filter at the
  // component level. Doing the filter INSIDE the useLiveQuery callback
  // would skip filtering under the test mock (which short-circuits the
  // callback by returning liveNotes directly), so we mirror the
  // production filter at the component level too. Cheap for hundreds
  // of notes — full-table scan is sub-millisecond on real IndexedDB.
  const allNotes = useLiveQuery(() => db.notes.toArray(), []);
  const tagFilter = useStore((s) => s.tagFilter);
  const sortMode = useStore((s) => s.sortMode);

  // Filter to active notes first (mirrors legacy semantics: deleted
  // notes never show in the tree), then apply the tag-filter AND
  // semantics. Subtree of `flattenTree` walks any descendant of a
  // root note that the filter exposes as a parent, so the
  // descendants chip in naturally if their parent passes the
  // filter — but Dexie doesn't carry tag-info into the
  // parentId graph, so we let `flattenTree` do its job and just
  // pre-filter at the root level. The result: only notes whose
  // row has the tag(s) appear in the tree, plus descendants of
  // any matching folder.
  const notes = useMemo(
    () => filterActiveNotesByTagSet(allNotes ?? [], tagFilter),
    [allNotes, tagFilter],
  );

  // Apply root-sort: chunk-sort only the root-level entries (the
  // children of `parentId: null`); children of any folder stay in
  // their stored `order`, which preserves drag/move-up/move-down
  // intent. Done in a useMemo so the comparator runs once per
  // notes / mode change, not once per row.
  const sortedNotes = useMemo(() => {
    const roots = notes.filter((n) => !n.parentId);
    const sortedRoots = sortRootNotes(roots, sortMode);
    const rootIds = new Set(sortedRoots.map((n) => n.id));
    // Reassemble: sorted roots first, then non-roots (children of
    // whatever root owns them — `flattenTree` will do its own
    // child grouping).
    const rest = notes.filter((n) => n.parentId !== null);
    return [
      ...sortedRoots,
      ...rest.filter((n) => rootIds.has(n.parentId!) || n.parentId !== null),
    ];
  }, [notes, sortMode]);

  // O(N) flatten once per notes change. The result defines both display
  // order AND which rows are currently visible (collapsed subtrees don't
  // even appear in the flat list — the DFS prunes them). Pass the
  // already-sorted notes so the DFS preserves the root ordering
  // applied above.
  const flatNotes = useMemo(() => flattenTree(sortedNotes), [sortedNotes]);

  if (!allNotes) return <div className="p-4 text-sm text-zinc-500">Loading...</div>;

  if (notes.length === 0) {
    return (
      <div className="p-4 text-sm text-zinc-500 italic">
        No notes yet. Click + to create one.
      </div>
    );
  }

  return (
    <VirtualizedFlatList
      flatNotes={flatNotes}
      disableVirtualization={dvProp}
    />
  );
}

// ---------------------------------------------------------------------------
// VirtualizedFlatList
//
// Renders only the visible window of `flatNotes`. Each row is positioned
// absolutely inside a `relative`-positioned spacer that reserves the
// total height (length * ROW_HEIGHT) so the scrollbar reflects the true
// scroll size. Drag source rows ARE in the DOM while they are visible;
// HTML5 D&D preserves the drag session across scroll-driven
// row-remount cycles.
// ---------------------------------------------------------------------------

interface VirtualizedFlatListProps {
  flatNotes: FlatTreeItem[];
  disableVirtualization?: boolean;
}

function VirtualizedFlatList({
  flatNotes,
  disableVirtualization,
}: VirtualizedFlatListProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  // Track scroll state and container size. ResizeObserver covers the
  // case where the sidebar panel is being dragged (height changes while
  // the user is interacting with the tree).
  const [{ scrollTop, viewportHeight }, setMetrics] = useState({
    scrollTop: 0,
    viewportHeight: 0,
  });

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () =>
      setMetrics({
        scrollTop: el.scrollTop,
        viewportHeight: el.clientHeight,
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(update);
      ro.observe(el);
    }
    return () => {
      el.removeEventListener('scroll', update);
      ro?.disconnect();
    };
  }, []);

  // If layout never produced a viewport (jsdom tests / SSR / a
  // zero-height container) AND the caller hasn't forced virtualization
  // off, fall back to rendering every row — the worst-case UX is just
  // "everything is mounted" rather than "nothing is rendered".
  const forceFullRender = !!disableVirtualization || viewportHeight === 0;

  const totalHeight = flatNotes.length * ROW_HEIGHT;
  const startIndex = forceFullRender
    ? 0
    : Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = forceFullRender
    ? flatNotes.length
    : Math.ceil(viewportHeight / ROW_HEIGHT) + 2 * OVERSCAN;
  const endIndex = forceFullRender
    ? flatNotes.length
    : Math.min(flatNotes.length, startIndex + visibleCount);

  const slice = flatNotes.slice(startIndex, endIndex);

  // Scroll the active row into view when activeNoteId changes (e.g.
  // user clicked a search result). We compute scrollTop from the flat
  // index instead of using scrollIntoView because virtualized rows
  // might not be in the DOM at the moment activeNoteId changes.
  const { activeNoteId } = useStore();
  useEffect(() => {
    if (!activeNoteId || !containerRef.current || forceFullRender) return;
    const idx = flatNotes.findIndex((f) => f.note.id === activeNoteId);
    if (idx === -1) return;
    const desiredTop = idx * ROW_HEIGHT;
    const el = containerRef.current;
    const cl = el.clientHeight;
    const st = el.scrollTop;
    // Only scroll if the active row is outside the current viewport.
    // We deliberately do NOT change scrollTop when the row is already
    // visible, to avoid jumping the UI when the user just clicked
    // a row that was on-screen.
    if (desiredTop < st || desiredTop > st + cl - ROW_HEIGHT) {
      el.scrollTop = Math.max(0, desiredTop - cl / 2 + ROW_HEIGHT / 2);
    }
  }, [activeNoteId, flatNotes, forceFullRender]);

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto"
      data-testid="treeview-scroll-container"
    >
      {/*
        Spacer div: holds the total height so the scrollbar is correct.
        No `overflow-hidden` here — the context menu and confirm modal
        descendants need to overflow outside this spacer.
      */}
      <div style={{ height: totalHeight, position: 'relative' }}>
        {slice.map((item, i) => (
          <div
            key={item.note.id}
            style={{
              position: 'absolute',
              top: (startIndex + i) * ROW_HEIGHT,
              left: 0,
              right: 0,
              height: ROW_HEIGHT,
            }}
          >
            <TreeRow item={item} flatNotes={flatNotes} />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TreeRow
//
// One rendered row in the virtualized list. Lifted out of the main
// TreeView so absolute-positioned children can mount/unmount
// independently as the scroll window shifts.
// ---------------------------------------------------------------------------

interface TreeRowProps {
  item: FlatTreeItem;
  flatNotes: FlatTreeItem[];
}

function TreeRow({ item, flatNotes }: TreeRowProps) {
  const { activeNoteId, setActiveNoteId } = useStore();
  const { note, depth, hasChildren, isOpened } = item;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  const isActive = activeNoteId === note.id;

  // Drag-drop on virtualized rows. Source row stays alive while the
  // user drags (the visible window covers the source). If the source
  // gets scrolled out of view mid-drag, HTML5 D&D still preserves the
  // drag session across the unmount.
  const handleDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', note.id);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (note.isFolder && e.dataTransfer.types.includes('text/plain')) {
      setIsDragOver(true);
    }
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const draggedNoteId = e.dataTransfer.getData('text/plain');
    // Convert the flat list back into the `Note[]` array that
    // tree-ops helpers expect.
    const allNotesForOps = flatNotes.map((f) => f.note);
    const validation = validateDropTarget(
      draggedNoteId,
      note,
      allNotesForOps,
    );
    if (!validation.valid) return;

    const updates = computeDropUpdates(
      draggedNoteId,
      note,
      allNotesForOps,
    );
    await db.notes.update(draggedNoteId, updates.dragged);
    if (updates.target) {
      await db.notes.update(note.id, updates.target);
    }
  };

  React.useEffect(() => {
    if (!isActive) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      const isTyping =
        ['INPUT', 'TEXTAREA'].includes(
          document.activeElement?.tagName || '',
        ) ||
        document.activeElement?.getAttribute('contenteditable') ===
          'true';

      if (!isTyping && e.key === 'Delete') {
        e.preventDefault();
        setShowConfirmDelete(true);
      }
      // F2 -> open rename modal for the active row. Mirrors the standard
      // outliner / files-app shortcut so users don't have to learn a
      // custom binding. Same typing guard as Delete so it doesn't fire
      // while the user is editing the title in the Editor.
      if (!isTyping && e.key === 'F2') {
        e.preventDefault();
        setRenameDraft(note.title);
        setShowRenameModal(true);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isActive, note.title]);

  // Move up/down swap. flatNotes.find() is O(visible) which is fine.
  const moveUpResult = useMemo(() => {
    const allNotesForOps = flatNotes.map((f) => f.note);
    return findMoveSibling(allNotesForOps, note.id, 'up');
  }, [flatNotes, note.id]);
  const moveDownResult = useMemo(() => {
    const allNotesForOps = flatNotes.map((f) => f.note);
    return findMoveSibling(allNotesForOps, note.id, 'down');
  }, [flatNotes, note.id]);

  const canMoveUp = moveUpResult.canMove;
  const canMoveDown = moveDownResult.canMove;

  const moveUp = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!moveUpResult.other) return;
    const updates = computeOrderSwap(note, moveUpResult.other, 'up');
    await db.notes.update(note.id, updates[note.id]);
    await db.notes.update(
      moveUpResult.other.id,
      updates[moveUpResult.other.id],
    );
    setContextMenuOpen(false);
  };

  const moveDown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!moveDownResult.other) return;
    const updates = computeOrderSwap(note, moveDownResult.other, 'down');
    await db.notes.update(note.id, updates[note.id]);
    await db.notes.update(
      moveDownResult.other.id,
      updates[moveDownResult.other.id],
    );
    setContextMenuOpen(false);
  };

  const toggleExpand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await db.notes.update(note.id, {
      isExpanded: !isOpened,
    });
  };

  const handleSelect = () => {
    setActiveNoteId(note.id);
  };

  const addChild = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newNote = await createChildNote(note.id);
    setActiveNoteId(newNote.id);
    setContextMenuOpen(false);
  };

  const addChildFolder = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const newNote = await createChildFolder(note.id);
    setActiveNoteId(newNote.id);
    setContextMenuOpen(false);
  };

  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenuOpen(false);
    setShowConfirmDelete(true);
  };

  const openRenameModal = (e: React.MouseEvent) => {
    e.stopPropagation();
    setContextMenuOpen(false);
    setRenameDraft(note.title);
    setShowRenameModal(true);
  };

  const closeRenameModal = () => {
    setShowRenameModal(false);
    setRenameDraft('');
  };

  // Validate live. Disable Save when empty/whitespace or unchanged so
  // the affordance mirrors the rule instead of relying on the user
  // hitting Save and seeing an error.
  const renameValidation = validateRenameTitle(renameDraft, note.title);

  const submitRename = async (e?: React.FormEvent | React.MouseEvent) => {
    e?.preventDefault();
    e?.stopPropagation();
    if (!renameValidation.valid) return;
    await renameNote(note.id, renameValidation.title);
    closeRenameModal();
  };

  // Soft-delete: stamp `deletedAt` on the note and all descendants.
  // Active-id routing clear happens BEFORE the db write so the Editor
  // doesn't try to swap content mid-flight.
  const confirmDelete = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(false);

    if (activeNoteId === note.id) {
      setActiveNoteId(null);
    }

    await softDeleteNote(note.id);
  };

  return (
    <>
      <div
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={cn(
          'group flex items-center pr-2 cursor-pointer select-none border border-transparent text-sm transition-all',
          isActive
            ? 'bg-blue-100/50 dark:bg-blue-900/30 text-blue-900 dark:text-blue-100 font-medium'
            : 'text-zinc-700 dark:text-zinc-300 hover:bg-zinc-100 dark:hover:bg-zinc-800/50',
          isDragOver &&
            'ring-2 ring-blue-400 dark:ring-blue-500 bg-blue-50/50 dark:bg-blue-900/20',
        )}
        style={{
          paddingLeft: `${
            depth === 0 ? 0.5 : depth * 1.5 + 0.5
          }rem`,
        }}
        onClick={handleSelect}
      >
        <button
          onClick={toggleExpand}
          className={cn(
            'p-0.5 rounded text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-300 w-5 h-5 flex items-center justify-center shrink-0 mr-0.5',
            !hasChildren && 'invisible',
          )}
        >
          {isOpened ? (
            <ChevronDown className="w-3.5 h-3.5" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5" />
          )}
        </button>

        <div className="mr-2 text-zinc-400 shrink-0">
          {note.isFolder ? (
            isOpened && hasChildren ? (
              <FolderOpen className="w-4 h-4 text-blue-400/80" />
            ) : (
              <Folder className="w-4 h-4 text-blue-400/80" />
            )
          ) : (
            <FileText className="w-3.5 h-3.5" />
          )}
        </div>

        <span className="truncate flex-1">
          {note.title ||
            (note.isFolder ? 'Untitled Folder' : 'Untitled')}
        </span>

        {/* Context Actions Hover */}
        <div
          className="opacity-0 group-hover:opacity-100 flex items-center shrink-0 relative"
          onMouseLeave={() => setContextMenuOpen(false)}
        >
          <button
            onClick={(e) => {
              e.stopPropagation();
              setContextMenuOpen(!contextMenuOpen);
            }}
            className="p-1 text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 rounded"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>

          {contextMenuOpen && (
            <div className="absolute right-0 top-full mt-1 w-36 py-1 bg-white/80 dark:bg-zinc-800/90 backdrop-blur-md rounded shadow-[0_4px_24px_-4px_rgba(0,0,0,0.1)] border border-white/60 dark:border-zinc-700/50 z-50 text-xs">
              <button
                onClick={addChildFolder}
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <FolderPlus className="w-3 h-3 mr-2" /> Add Folder
              </button>
              <button
                onClick={addChild}
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <CornerDownRight className="w-3 h-3 mr-2" /> Add Child
                Note
              </button>
              {canMoveUp && (
                <button
                  onClick={moveUp}
                  className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
                >
                  Move Up
                </button>
              )}
              {canMoveDown && (
                <button
                  onClick={moveDown}
                  className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
                >
                  Move Down
                </button>
              )}
              <button
                onClick={openRenameModal}
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <Pencil className="w-3 h-3 mr-2" /> Rename
              </button>
              <div className="border-t border-zinc-100 dark:border-zinc-700 my-1"></div>
              <button
                onClick={handleDeleteClick}
                className="w-full text-left px-3 py-1.5 hover:bg-red-50 dark:hover:bg-red-900/30 text-red-600 dark:text-red-400"
              >
                Delete
              </button>
            </div>
          )}
        </div>
      </div>

      {showConfirmDelete && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            setShowConfirmDelete(false);
          }}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full border border-zinc-200 dark:border-zinc-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              Delete {note.isFolder ? 'Folder' : 'Note'}
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
              {hasChildren
                ? `Move "${note.title || (note.isFolder ? 'Untitled Folder' : 'Untitled')}" and ALL its contents to Trash? You can restore from Trash before it auto-purges after 30 days.`
                : `Move "${note.title || (note.isFolder ? 'Untitled Folder' : 'Untitled')}" to Trash? You can restore from Trash before it auto-purges after 30 days.`}
            </p>
            <div className="flex justify-end gap-3">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  setShowConfirmDelete(false);
                }}
                className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-4 py-2 text-sm font-medium text-white bg-red-500 rounded-lg hover:bg-red-600 transition"
              >
                Move to Trash
              </button>
            </div>
          </div>
        </div>
      )}

      {showRenameModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            closeRenameModal();
          }}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full border border-zinc-200 dark:border-zinc-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
              Rename {note.isFolder ? 'Folder' : 'Note'}
            </h3>
            <p className="text-sm text-zinc-500 dark:text-zinc-400 mb-3">
              Enter a new name. Press Enter to save, Escape to cancel.
            </p>
            {/* form + submit-on-Enter lets users hit Enter inside the
                input without needing the keyboard shortcut to be
                on focus on the button. */}
            <form onSubmit={submitRename}>
              <input
                autoFocus
                /* select-all so the user can type-to-replace without
                   having to manually delete the previous title first.
                   matches Finder/Explorer rename behavior. */
                onFocus={(e) => e.currentTarget.select()}
                type="text"
                value={renameDraft}
                onChange={(e) => setRenameDraft(e.target.value)}
                placeholder={
                  note.isFolder ? 'Untitled Folder' : 'Untitled'
                }
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.preventDefault();
                    e.stopPropagation();
                    closeRenameModal();
                  }
                }}
                className="w-full px-3 py-2 text-sm bg-white dark:bg-zinc-800 border border-zinc-200 dark:border-zinc-700 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400/50 text-zinc-900 dark:text-zinc-100 placeholder:text-zinc-400"
              />
              {/* Inline validation hint — kept short so the modal stays
                  compact. We avoid the "red border" treatment because the
                  Save button being disabled already conveys the same
                  message visually. */}
              {!renameValidation.valid &&
                renameValidation.reason === 'empty-or-whitespace' && (
                  <p className="mt-2 text-xs text-red-500 dark:text-red-400">
                    Title cannot be empty.
                  </p>
                )}
              <div className="flex justify-end gap-3 mt-5">
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    closeRenameModal();
                  }}
                  className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!renameValidation.valid}
                  onClick={(e) => {
                    // form onSubmit still fires after this; we keep
                    // stopPropagation so the click doesn't bubble to the
                    // backdrop close handler.
                    e.stopPropagation();
                  }}
                  className="px-4 py-2 text-sm font-medium text-white bg-blue-500 rounded-lg hover:bg-blue-600 transition disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  Save
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </>
  );
}
