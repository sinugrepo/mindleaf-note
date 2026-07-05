import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useStore } from '../store/useStore';
import { Sidebar } from './Sidebar';
import { Editor } from './Editor';
import { EditorEmptyState } from './EditorEmptyState';
import { cn } from '../lib/utils';
import { useMediaQuery } from '../hooks/useMediaQuery';
import { useThemeSync } from '../hooks/useThemeSync';
import {
  useResizablePanel,
  UseResizablePanelResult,
} from '../hooks/useResizablePanel';
import {
  useGlobalKeyboardShortcuts,
  GlobalShortcuts,
} from '../hooks/useGlobalKeyboardShortcuts';
import { ChevronRight } from 'lucide-react';
import { createRootNote, createChildNote, NEW_CHILD_NOTE_TITLE } from '../lib/notes';

const SIDEBAR_INITIAL_WIDTH = 320;
const SIDEBAR_MIN_WIDTH = 240;
const SIDEBAR_MAX_WIDTH = 600;

export function Layout() {
  const { activeNoteId, setActiveNoteId, theme } = useStore();
  const { width: sidebarWidth, isResizing, startResize }: UseResizablePanelResult =
    useResizablePanel({
      initialWidth: SIDEBAR_INITIAL_WIDTH,
      minWidth: SIDEBAR_MIN_WIDTH,
      maxWidth: SIDEBAR_MAX_WIDTH,
    });

  const isMobile = useMediaQuery('(max-width: 767px)');
  const [isSidebarOpen, setIsSidebarOpen] = useState<boolean>(true);

  // Apply the user's theme preference to <html> (system, light, or dark).
  useThemeSync(theme);

  // On mobile, snap the sidebar closed as soon as a note becomes active so
  // the editor gets the full viewport (mirrors the previous inline effect).
  useEffect(() => {
    if (activeNoteId && isMobile) {
      setIsSidebarOpen(false);
    }
  }, [activeNoteId, isMobile]);

  // --- Keyboard shortcut handlers (memoized so useGlobalKeyboardShortcuts
  //     doesn't re-install its window listener on every Layout render). ---
  const handleNewRootNote = useCallback(async () => {
    const note = await createRootNote();
    setActiveNoteId(note.id);
  }, [setActiveNoteId]);

  const handleNewChildNote = useCallback(async () => {
    if (!activeNoteId) return; // Need an active note to create a child
    const note = await createChildNote(activeNoteId, NEW_CHILD_NOTE_TITLE);
    setActiveNoteId(note.id);
  }, [activeNoteId, setActiveNoteId]);

  const handleFocusSearch = useCallback(() => {
    document.getElementById('global-search')?.focus();
  }, []);

  const shortcuts = useMemo<GlobalShortcuts>(
    () => ({
      onNewRootNote: handleNewRootNote,
      onNewChildNote: handleNewChildNote,
      onFocusSearch: handleFocusSearch,
    }),
    [handleNewRootNote, handleNewChildNote, handleFocusSearch],
  );

  useGlobalKeyboardShortcuts(shortcuts);

  return (
    <div
      className={cn(
        'flex h-[100dvh] w-screen overflow-hidden text-zinc-900 bg-transparent dark:text-zinc-100 transition-colors duration-300 relative',
        isResizing && 'cursor-col-resize select-none',
      )}
    >
      {/* Mobile overlay */}
      {isSidebarOpen && (
        <div
          className="md:hidden fixed inset-0 bg-black/20 dark:bg-black/40 z-20 backdrop-blur-sm"
          onClick={() => setIsSidebarOpen(false)}
        />
      )}

      {/* Sidebar container */}
      <div
        className={cn(
          'absolute md:relative z-30 h-full transition-all duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] flex flex-shrink-0 overflow-hidden',
          isSidebarOpen
            ? 'translate-x-0 shadow-2xl md:shadow-none'
            : '-translate-x-full md:translate-x-0',
          isMobile &&
            'w-[80vw] sm:w-80 border-r border-white/60 dark:border-white/5',
        )}
        style={{ width: isMobile ? undefined : isSidebarOpen ? sidebarWidth : 0 }}
      >
        <div
          className="h-full flex-shrink-0 bg-white/50 dark:bg-[#050505]/60 border-r border-white/60 dark:border-white/5"
          style={{ width: isMobile ? '100%' : sidebarWidth }}
        >
          <Sidebar
            className="w-full h-full border-r-0 !bg-transparent backdrop-blur-none"
            onClose={() => setIsSidebarOpen(false)}
          />
        </div>

        {/* Resize handle (Desktop only) */}
        {isSidebarOpen && !isMobile && (
          <div
            className="absolute right-0 top-0 bottom-0 w-1.5 cursor-col-resize hover:bg-blue-500/50 active:bg-blue-500 transition-colors z-50"
            onMouseDown={startResize}
          />
        )}
      </div>

      {/* Main Content */}
      <main className="flex-1 flex flex-col h-full min-w-0 bg-white/40 dark:bg-[#09090b]/70 backdrop-blur-2xl relative">
        {/* Toggle Sidebar Button (Middle Left) */}
        {!isSidebarOpen && (
          <div className="absolute top-1/2 left-0 -translate-y-1/2 z-10 flex items-center">
            <button
              onClick={() => setIsSidebarOpen(true)}
              className="h-16 w-5 bg-white/80 dark:bg-zinc-800/80 backdrop-blur-md border border-zinc-200 dark:border-zinc-700 border-l-0 rounded-r-lg flex items-center justify-center text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:w-6 hover:bg-white dark:hover:bg-zinc-700 transition-all shadow-sm group"
              title="Open Sidebar"
            >
              <ChevronRight className="w-4 h-4 opacity-70 group-hover:opacity-100" />
            </button>
          </div>
        )}

        {/* INVARIANT: do NOT drop the `key={...}` prop below. See
            src/components/Editor.tsx top-of-file invariant block. The
            init-once pattern in Editor relies on React remounting it on
            every activeNoteId change so its `initializedRef` starts fresh.
            The regression test in Editor.test.tsx
            ("keeps note A image content intact when Editor key changes
            from A to B") guards the runtime behavior, but the `key` prop
            itself is a human/architectural contract — see the comment at
            the top of Editor.tsx for the full reasoning. */}
        {activeNoteId ? (
          <Editor key={activeNoteId} noteId={activeNoteId} />
        ) : (
          <EditorEmptyState />
        )}
      </main>
    </div>
  );
}

