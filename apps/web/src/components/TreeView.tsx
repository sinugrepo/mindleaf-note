import React, {
  useState,
  useMemo,
  useRef,
  useEffect,
  memo,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Note } from '../types';
import { useStore } from '../store/useStore';
import {
  validateDropTarget,
  computeDropUpdates,
  computeOrderSwap,
  flattenTree,
  buildMoveSupportMap,
  type FlatTreeItem,
  type MoveSupport,
} from '../lib/tree-ops';
import {
  filterActiveNotesByTagSet,
  sortRootNotes,
} from '../lib/tags';
import { useFocusTrap } from '../hooks/useFocusTrap';
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
import { queuedPatchNote } from '../sync/queue';

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
const CONTEXT_MENU_WIDTH = 176;
const CONTEXT_MENU_HEIGHT = 248;
const VIEWPORT_MARGIN = 8;

function getContextMenuPosition(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(
      VIEWPORT_MARGIN,
      Math.min(x, window.innerWidth - CONTEXT_MENU_WIDTH - VIEWPORT_MARGIN),
    ),
    y: Math.max(
      VIEWPORT_MARGIN,
      Math.min(y, window.innerHeight - CONTEXT_MENU_HEIGHT - VIEWPORT_MARGIN),
    ),
  };
}

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
  const sortDirection = useStore((s) => s.sortDirection);

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

  // Tree rows may be filtered or hidden when a folder is collapsed, but
  // drag/drop operations must always see the complete active tree. Using
  // `flatNotes` here would make order calculations ignore hidden children.
  const activeNotesForOps = useMemo(
    () => (allNotes ?? []).filter(isActiveNote),
    [allNotes],
  );

  // Apply root-sort: chunk-sort only the root-level entries (the
  // children of `parentId: null`); children of any folder stay in
  // their stored `order`, which preserves drag/move-up/move-down
  // intent. Done in a useMemo so the comparator runs once per
  // notes / mode change, not once per row.
  const sortedNotes = useMemo(() => {
    const roots = notes.filter((n) => !n.parentId);
    const sortedRoots = sortRootNotes(roots, sortMode, sortDirection);
    const rootIds = new Set(sortedRoots.map((n) => n.id));
    // Reassemble: sorted roots first, then non-roots (children of
    // whatever root owns them — `flattenTree` will do its own
    // child grouping).
    const rest = notes.filter((n) => n.parentId !== null);
    return [
      ...sortedRoots,
      ...rest.filter((n) => rootIds.has(n.parentId!) || n.parentId !== null),
    ];
  }, [notes, sortMode, sortDirection]);

  // O(N) flatten once per notes change. The result defines both display
  // order AND which rows are currently visible (collapsed subtrees don't
  // even appear in the flat list — the DFS prunes them). Pass the
  // already-sorted notes so the DFS preserves the root ordering
  // applied above.
  const flatNotes = useMemo(() => flattenTree(sortedNotes), [sortedNotes]);

  // O(N log N) batch pre-computation of move-up / move-down support for
  // every visible row. Each TreeRow can then answer its own move
  // question with a single Map.get(note.id) instead of re-running
  // findMoveSibling (which would scale as O(N² log N) across the
  // visible window). The map is keyed by noteId and matches the
  // per-call findMoveSibling output exactly (cross-checked in
  // tree-ops.test.ts).
  const moveSupportMap = useMemo(
    () => buildMoveSupportMap(flatNotes.map((f) => f.note)),
    [flatNotes],
  );

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
      allNotesForOps={activeNotesForOps}
      moveSupportMap={moveSupportMap}
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
  /** Complete active tree used by drag/drop validation and ordering. */
  allNotesForOps: Note[];
  /**
   * Precomputed move-up / move-down support for every visible row.
   * Built once per `flatNotes` change in the parent TreeView so each
   * TreeRow can answer its own move question with a Map.get — keeps
   * the cost at O(N log N) per change instead of O(N² log N).
   */
  moveSupportMap: Map<string, MoveSupport>;
  disableVirtualization?: boolean;
}

function VirtualizedFlatList({
  flatNotes,
  allNotesForOps,
  moveSupportMap,
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
      role="tree"
      aria-label="Notes tree"
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
            <TreeRow
              item={item}
              flatNotes={flatNotes}
              allNotesForOps={allNotesForOps}
              moveSupportMap={moveSupportMap}
            />
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
  /** Complete active tree; unlike the visible flat list, includes collapsed descendants. */
  allNotesForOps: Note[];
  /** Precomputed move-support map; see VirtualizedFlatListProps. */
  moveSupportMap: Map<string, MoveSupport>;
}

function TreeRowImpl({ item, flatNotes, allNotesForOps, moveSupportMap }: TreeRowProps) {
  const { activeNoteId, setActiveNoteId, selectedNoteIds, toggleNoteSelection } = useStore();
  const { note, depth, hasChildren, isOpened } = item;

  const [contextMenuOpen, setContextMenuOpen] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const rowRef = useRef<HTMLDivElement | null>(null);
  const contextMenuButtonRef = useRef<HTMLButtonElement | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [showRenameModal, setShowRenameModal] = useState(false);
  const [renameDraft, setRenameDraft] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);

  // Modal backdrop refs + focus-traps. The trap captures the
  // previously-focused element on mount and restores it on close.
  // Tab/Shift+Tab cycling is wired to the backdrop's onKeyDown so
  // it shares the existing event path with the Escape handler.
  const deleteModalRef = useRef<HTMLDivElement | null>(null);
  const { onKeyDown: onDeleteModalKeyDown } = useFocusTrap(
    deleteModalRef,
    showConfirmDelete,
  );
  const renameModalRef = useRef<HTMLDivElement | null>(null);
  const { onKeyDown: onRenameModalKeyDown } = useFocusTrap(
    renameModalRef,
    showRenameModal,
  );

  const isActive = activeNoteId === note.id;

  // The parent virtualizer scrolls the active row into view first. Once the
  // row is mounted, this effect gives keyboard users a stable focus target
  // without querying selectors or relying on CSS.escape for note ids.
  useEffect(() => {
    if (isActive) rowRef.current?.focus();
  }, [isActive]);

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

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setActiveNoteId(note.id);
    setContextMenuPosition(getContextMenuPosition(e.clientX, e.clientY));
    setContextMenuOpen(true);
  };

  React.useEffect(() => {
    if (!contextMenuOpen) return;

    // Put keyboard focus inside the menu after it is mounted, matching the
    // behavior users expect from a native context menu.
    const firstItem = contextMenuRef.current?.querySelector<HTMLButtonElement>(
      '[role="menuitem"]',
    );
    firstItem?.focus();

    const closeMenu = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        contextMenuRef.current?.contains(target) ||
        contextMenuButtonRef.current?.contains(target)
      ) {
        return;
      }
      setContextMenuOpen(false);
    };
    const closeOtherMenus = (e: MouseEvent) => {
      // Capture phase lets the newly targeted row open its menu while any
      // previously open row closes, even though the row stops propagation.
      if (!rowRef.current?.contains(e.target as Node)) setContextMenuOpen(false);
    };
    const closeOnEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setContextMenuOpen(false);
        contextMenuButtonRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', closeMenu);
    window.addEventListener('contextmenu', closeOtherMenus, true);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('mousedown', closeMenu);
      window.removeEventListener('contextmenu', closeOtherMenus, true);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [contextMenuOpen]);

  const handleContextMenuKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(
      e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
    );
    if (items.length === 0) return;

    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    let nextIndex: number | null = null;
    if (e.key === 'ArrowDown') nextIndex = (currentIndex + 1) % items.length;
    if (e.key === 'ArrowUp') nextIndex = (currentIndex - 1 + items.length) % items.length;
    if (e.key === 'Home') nextIndex = 0;
    if (e.key === 'End') nextIndex = items.length - 1;
    if (nextIndex !== null) {
      e.preventDefault();
      items[nextIndex].focus();
    }
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const draggedNoteId = e.dataTransfer.getData('text/plain');
    // Use the complete active tree, not the visible flat list: collapsed
    // folders still have children whose order must be respected.
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
    // Route through sync queue — `dragged` has parentId + order, `target`
    // has isExpanded. Both are optimistic local writes + enqueued mutations.
    if (updates.dragged.parentId !== undefined) {
      await queuedPatchNote(draggedNoteId, {
        parentId: updates.dragged.parentId,
        order: updates.dragged.order,
      });
    }
    if (updates.target) {
      await queuedPatchNote(note.id, { isExpanded: updates.target.isExpanded });
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

  // O(1) lookup against the parent-precomputed support map. Falls
  // back to "no moves" when the note id is not in the map (only
  // happens for stale closure scenarios — defensive default matches
  // what `findMoveSibling` returns for unknown ids).
  const moveSupport = moveSupportMap.get(note.id);
  const otherUp = moveSupport?.otherUp;
  const otherDown = moveSupport?.otherDown;
  const canMoveUp = moveSupport?.canMoveUp ?? false;
  const canMoveDown = moveSupport?.canMoveDown ?? false;

  const moveUp = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!otherUp) return;
    const updates = computeOrderSwap(note, otherUp, 'up');
    await queuedPatchNote(note.id, { order: updates[note.id].order! });
    await queuedPatchNote(otherUp.id, { order: updates[otherUp.id].order! });
    setContextMenuOpen(false);
  };

  const moveDown = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!otherDown) return;
    const updates = computeOrderSwap(note, otherDown, 'down');
    await queuedPatchNote(note.id, { order: updates[note.id].order! });
    await queuedPatchNote(otherDown.id, { order: updates[otherDown.id].order! });
    setContextMenuOpen(false);
  };

  const toggleExpand = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await queuedPatchNote(note.id, { isExpanded: !isOpened });
  };

  const handleSelect = () => {
    setActiveNoteId(note.id);
    rowRef.current?.focus();
  };

  const handleTreeKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (contextMenuOpen || showConfirmDelete || showRenameModal) return;
    const target = e.target as HTMLElement;
    if (target.closest('input, button, textarea, [contenteditable="true"]') && target !== e.currentTarget) return;
    const index = flatNotes.findIndex((entry) => entry.note.id === note.id);
    if (index < 0) return;

    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const next = flatNotes[index + (e.key === 'ArrowUp' ? -1 : 1)];
      if (next) {
        setActiveNoteId(next.note.id);
      }
      return;
    }
    if (e.key === 'ArrowRight' && hasChildren) {
      e.preventDefault();
      if (!isOpened && note.isFolder) void queuedPatchNote(note.id, { isExpanded: true });
      else {
        const child = flatNotes[index + 1];
        if (child && child.depth > item.depth) {
          setActiveNoteId(child.note.id);
        }
      }
      return;
    }
    if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (isOpened && note.isFolder) {
        void queuedPatchNote(note.id, { isExpanded: false });
        return;
      }
      if (item.depth > 0) {
        const parent = flatNotes.slice(0, index).reverse().find((entry) => entry.depth === item.depth - 1);
        if (parent) {
          setActiveNoteId(parent.note.id);
        }
      }
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      const destination = e.key === 'Home' ? flatNotes[0] : flatNotes[flatNotes.length - 1];
      if (destination) {
        setActiveNoteId(destination.note.id);
      }
    }
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
        ref={rowRef}
        draggable
        onDragStart={handleDragStart}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        onContextMenu={handleContextMenu}
        onKeyDown={handleTreeKeyDown}
        tabIndex={isActive ? 0 : -1}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={isActive}
        aria-expanded={hasChildren ? isOpened : undefined}
        data-tree-row-id={note.id}

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
        <input
          type="checkbox"
          checked={selectedNoteIds.includes(note.id)}
          onChange={() => toggleNoteSelection(note.id)}
          onClick={(e) => e.stopPropagation()}
          aria-label={`Select ${note.title || 'note'}`}
          className="mr-1 h-3.5 w-3.5 accent-blue-500 shrink-0"
        />

        <button
          type="button"
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
        <div className="flex items-center shrink-0 relative">
          <button
            ref={contextMenuButtonRef}
            onClick={(e) => {
              e.stopPropagation();
              const rect = e.currentTarget.getBoundingClientRect();
              setContextMenuPosition(getContextMenuPosition(rect.right, rect.bottom));
              setContextMenuOpen(!contextMenuOpen);
            }}
            aria-label="Open note actions"
            aria-haspopup="menu"
            aria-expanded={contextMenuOpen}
            type="button"
            className="p-1 text-zinc-400 hover:text-zinc-800 dark:hover:text-zinc-200 rounded opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
          >
            <MoreVertical className="w-3.5 h-3.5" />
          </button>

          {contextMenuOpen && (
            <div
              ref={contextMenuRef}
              role="menu"
              aria-label={`Actions for ${note.title || 'note'}`}
              tabIndex={-1}
              onKeyDown={handleContextMenuKeyDown}
              className="fixed w-44 py-1 bg-white/95 dark:bg-zinc-800/95 backdrop-blur-md rounded-lg shadow-[0_8px_30px_-8px_rgba(0,0,0,0.3)] border border-zinc-200/80 dark:border-zinc-700/70 z-[100] text-xs"
              style={{ left: contextMenuPosition.x, top: contextMenuPosition.y }}
            >
              <button
                onClick={addChildFolder}
                role="menuitem"
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <FolderPlus className="w-3 h-3 mr-2" /> Add Folder
              </button>
              <button
                onClick={addChild}
                role="menuitem"
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <CornerDownRight className="w-3 h-3 mr-2" /> Add Child
                Note
              </button>
              {canMoveUp && (
                <button
                  onClick={moveUp}
                  role="menuitem"
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
                >
                  Move Up
                </button>
              )}
              {canMoveDown && (
                <button
                  onClick={moveDown}
                  role="menuitem"
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
                >
                  Move Down
                </button>
              )}
              <button
                onClick={openRenameModal}
                role="menuitem"
                type="button"
                className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 dark:hover:bg-zinc-700 text-zinc-700 dark:text-zinc-300 flex items-center"
              >
                <Pencil className="w-3 h-3 mr-2" /> Rename
              </button>
              <div className="border-t border-zinc-100 dark:border-zinc-700 my-1"></div>
              <button
                onClick={handleDeleteClick}
                role="menuitem"
                type="button"
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
          ref={deleteModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="confirm-delete-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            setShowConfirmDelete(false);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              setShowConfirmDelete(false);
              return;
            }
            onDeleteModalKeyDown(e);
          }}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full border border-zinc-200 dark:border-zinc-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="confirm-delete-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
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
          ref={renameModalRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="rename-title"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm"
          onClick={(e) => {
            e.stopPropagation();
            closeRenameModal();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              closeRenameModal();
              return;
            }
            onRenameModalKeyDown(e);
          }}
        >
          <div
            className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full border border-zinc-200 dark:border-zinc-800"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="rename-title" className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
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

/**
 * `TreeRow` is wrapped in `React.memo` so unchanged rows skip re-render
 * when the parent tree re-renders for unrelated reasons (scrollbar
 * flip, saveStatus toggle elsewhere, etc.). `item`, `flatNotes`, and
 * `moveSupportMap` are all derived from upstream memos and keep
 * stable identity across renders when no underlying notes change,
 * so the default shallow comparison skips render in the common
 * no-change case.
 */
const TreeRow = memo(TreeRowImpl);
