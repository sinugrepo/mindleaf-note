import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { useStore } from '../store/useStore';
import {
  Search,
  Plus,
  FolderPlus,
  Download,
  Upload,
  Moon,
  Sun,
  Monitor,
  PanelLeftClose,
  ChevronsUpDown,
  Inbox,
  Trash2,
  LogOut,
} from 'lucide-react';
import { TreeView } from './TreeView';
import { TrashView } from './TrashView';
import { SearchResults } from './SearchResults';
import { TagFilterBar } from './TagFilterBar';
import { SortDropdown } from './SortDropdown';
import { db } from '../db/db';
import { Theme } from '../types';
import { cn } from '../lib/utils';
import { queuedPatchNote } from '../sync/queue';
import {
  createRootNote,
  createRootFolder,
  isTrashedNote,
  queuedImportNotes,
} from '../lib/notes';
import { exportNotesAsFile, importBackupFromFile } from '../lib/notes-io';
import { api } from '../api/client';

interface SidebarProps {
  className?: string;
  onClose?: () => void;
  onLogout?: () => Promise<void>;
}

export function Sidebar({ className, onClose, onLogout }: SidebarProps) {
  // Granular Zustand selectors: each subscription is scoped to a single
  // field so Sidebar only re-renders when one of the fields we actually
  // render (search query, theme) changes. Action reads use getState() so
  // they don't even register a subscription.
  const searchQuery = useStore((s) => s.searchQuery);
  const theme = useStore((s) => s.theme);
  const [isExporting, setIsExporting] = useState<boolean>(false);
  // Trash visibility toggle. Persists only in component state — closing
  // the app resets to notes view, which matches the user's intuition
  // (the next session probably wants the normal tree first).
  const [showTrash, setShowTrash] = useState<boolean>(false);
  // Live query just for the trash count badge. Cheap O(notes) full scan
  // since deletedAt is not indexed; with hundreds of notes it's <1ms.
  const trashCount = useLiveQuery(
    async () => (await db.notes.toArray()).filter(isTrashedNote).length,
    [],
  );

  const handleAddRootNote = async () => {
    const note = await createRootNote();
    useStore.getState().setActiveNoteId(note.id);
  };

  const handleAddRootFolder = async () => {
    const note = await createRootFolder();
    useStore.getState().setActiveNoteId(note.id);
  };

  const handleExport = async () => {
    setIsExporting(true);
    try {
      // Phase 7 — try cloud export first (cross-device: includes rows
      // synced from other devices, not just the local IndexedDB
      // cache). Fall back to the local-cache export if the backend
      // is unreachable or 401s. User-facing UX is identical either
      // way: a `.treenote` file lands in their downloads folder.
      let json: string | null = null;
      try {
        const payload = await api.exportFull();
        json = JSON.stringify(payload, null, 2);
      } catch (cloudErr) {
        console.warn(
          '[export] Cloud export failed, falling back to local cache:',
          cloudErr,
        );
      }
      if (json !== null) {
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const today = new Date().toISOString().slice(0, 10);
        a.download = `treenote-backup-${today}.treenote`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        return;
      }
      // Fallback: local-cache export (already implemented in
      // notes-io.ts). Skips network call entirely.
      const notes = await db.notes.toArray();
      await exportNotesAsFile(notes);
    } catch (e) {
      console.error(e);
      alert('Failed to export notes.');
    } finally {
      setIsExporting(false);
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    const result = await importBackupFromFile(file);
    if (result === null) {
      alert('Invalid backup file.');
      e.target.value = '';
      return;
    }
    if (result.notes.length === 0 && result.attachments.length === 0) {
      alert(
        'Invalid backup file: expected at least one valid note or attachment.',
      );
      e.target.value = '';
      return;
    }
    // Route through sync queue so imported notes get dirty=true and
    // a create_note mutation is enqueued for the backend drainer.
    await queuedImportNotes(result.notes, result.attachments);
    alert(
      `Import successful! ${result.notes.length} note(s) and ${result.attachments.length} attachment(s) imported.`,
    );
    e.target.value = '';
  };

  return (
    <div
      className={cn(
        'border-r border-white/60 dark:border-white/5 bg-white/50 dark:bg-[#050505]/60 backdrop-blur-xl shadow-[1px_0_10px_-4px_rgba(0,0,0,0.05)] flex flex-col h-full flex-shrink-0 transition-colors duration-300',
        className,
      )}
    >
      {/* Header */}
      <div className="p-4 flex items-center justify-between border-b border-white/60 dark:border-white/5 shrink-0">
        <div className="flex items-center gap-2 overflow-hidden">
          {onClose && (
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-500 dark:text-zinc-400 shrink-0"
              title="Close Sidebar"
              aria-label="Close Sidebar"
            >
              <PanelLeftClose className="w-4 h-4" />
            </button>
          )}
          <h1 className="font-semibold text-zinc-800 dark:text-zinc-200 truncate">
            {showTrash && !searchQuery ? 'Trash' : 'TreeNote'}
          </h1>
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={async () => {
              const notes = await db.notes.toArray();
              const anyCollapsed = notes.some(
                (n) => n.isFolder && !n.isExpanded,
              );
              await Promise.all(
                notes
                  .filter((n) => n.isFolder)
                  .map((n) => queuedPatchNote(n.id, { isExpanded: anyCollapsed })),
              );
            }}
            className="p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-600 dark:text-zinc-400"
            title="Toggle Expand/Collapse All"
            aria-label="Toggle expand and collapse for all folders"
          >
            <ChevronsUpDown className="w-4 h-4" />
          </button>
          {/* Trash toggle. Hidden when searching (search has its own
              scope that already excludes trash items). */}
          {!searchQuery && (
            <button
              type="button"
              onClick={() => setShowTrash((s) => !s)}
              className={cn(
                'p-1.5 rounded transition-colors relative',
                showTrash
                  ? 'bg-blue-100/60 dark:bg-blue-900/40 text-blue-700 dark:text-blue-200'
                  : 'text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800',
              )}
              title={showTrash ? 'Back to Notes' : 'Open Trash'}
              aria-label={showTrash ? 'Back to Notes' : 'Open Trash'}
              aria-pressed={showTrash}
            >
              {showTrash ? (
                <Inbox className="w-4 h-4" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              {!showTrash && (trashCount ?? 0) > 0 && (
                <span
                  className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full text-[9px] font-mono font-semibold bg-red-500 text-white flex items-center justify-center"
                  aria-label={`${trashCount} items in trash`}
                >
                  {trashCount}
                </span>
              )}
            </button>
          )}
          <button
            type="button"
            onClick={handleAddRootFolder}
            className={cn(
              'p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-600 dark:text-zinc-400',
              showTrash && 'hidden sm:inline-flex',
            )}
            title="New Folder"
            aria-label="New Folder"
          >
            <FolderPlus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={handleAddRootNote}
            className={cn(
              'p-1.5 hover:bg-zinc-200 dark:hover:bg-zinc-800 rounded transition-colors text-zinc-600 dark:text-zinc-400',
              showTrash && 'hidden sm:inline-flex',
            )}
            title="New Note (Ctrl+N)"
            aria-label="New Note (Ctrl+N)"
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Search */}
      <div className="p-3 shrink-0">
        <div className="relative">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-zinc-400" />
          <input
            id="global-search"
            type="text"
            placeholder="Search notes (Ctrl+F)..."
            value={searchQuery}
            onChange={(e) => useStore.getState().setSearchQuery(e.target.value)}
            aria-label="Search notes"
            className="w-full bg-white/50 backdrop-blur-md dark:bg-black/40 border border-white/60 dark:border-white/10 rounded-md py-1.5 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400/50 transition-shadow dark:text-zinc-200 placeholder:text-zinc-400 shadow-[inset_0_1px_2px_rgba(0,0,0,0.02)]"
          />
        </div>
      </div>

      {/* Tag-filter chip set + Sort selector. Hidden when the search
          input is non-empty (search has its own scope) and when the
          trash view is showing (trash is keyword-scoped on
          `deletedAt != null`). */}
      {!searchQuery && !showTrash && (
        <div className="border-b border-white/60 dark:border-white/5 pb-2">
          <TagFilterBar />
        </div>
      )}
      <div className="px-3 py-1 shrink-0 flex items-center justify-end">
        <SortDropdown visible={!searchQuery && !showTrash} />
      </div>

      {/* Main List Area */}
      <div className="flex-1 min-h-0 px-2">
        {searchQuery ? (
          <SearchResults />
        ) : showTrash ? (
          <TrashView onBack={() => setShowTrash(false)} />
        ) : (
          <TreeView />
        )}
      </div>

      {/* Footer Settings */}
      <div className="p-3 border-t border-white/60 dark:border-white/5 flex justify-between items-center text-zinc-500 dark:text-zinc-400 shrink-0">
        <div className="flex gap-1">
          {onLogout && (
            <button
              type="button"
              onClick={() => void onLogout()}
              className="p-1.5 hover:bg-red-100/60 dark:hover:bg-red-900/30 rounded transition-colors hover:text-red-600 dark:hover:text-red-400"
              title="Logout"
              aria-label="Logout"
            >
              <LogOut className="w-4 h-4" />
            </button>
          )}
          <button
            type="button"
            onClick={handleExport}
            disabled={isExporting}
            className="p-1.5 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 rounded transition-colors"
            title="Export .treenote"
            aria-label="Export notes as a .treenote backup file"
          >
            <Download className="w-4 h-4" />
          </button>
          <label
            className="p-1.5 hover:bg-zinc-200/50 dark:hover:bg-zinc-800/50 rounded transition-colors cursor-pointer"
            title="Import .treenote or .json"
          >
            <Upload className="w-4 h-4" />
            <input
              type="file"
              accept=".json,.treenote"
              className="hidden"
              onChange={handleImport}
            />
          </label>
        </div>

        <div className="flex bg-zinc-200/50 dark:bg-zinc-800/50 rounded p-0.5">
          <ThemeButton
            current={theme}
            theme="light"
            icon={<Sun className="w-3.5 h-3.5" />}
            onClick={() => useStore.getState().setTheme('light')}
            title="Light"
          />
          <ThemeButton
            current={theme}
            theme="system"
            icon={<Monitor className="w-3.5 h-3.5" />}
            onClick={() => useStore.getState().setTheme('system')}
            title="System"
          />
          <ThemeButton
            current={theme}
            theme="dark"
            icon={<Moon className="w-3.5 h-3.5" />}
            onClick={() => useStore.getState().setTheme('dark')}
            title="Dark"
          />
        </div>
      </div>
    </div>
  );
}

function ThemeButton({
  current,
  theme,
  icon,
  onClick,
  title,
}: {
  current: Theme;
  theme: Theme;
  icon: React.ReactNode;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={`Theme: ${title}`}
      aria-pressed={current === theme}
      className={cn(
        'p-1.5 rounded transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60',
        current === theme
          ? 'bg-white dark:bg-zinc-800 shadow-sm text-zinc-900 dark:text-white'
          : 'text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300',
      )}
    >
      {icon}
    </button>
  );
}
