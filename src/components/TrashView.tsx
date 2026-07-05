import React, { useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Note } from '../types';
import {
  ArrowLeft,
  FileText,
  Folder,
  Trash2,
  RotateCcw,
  Inbox,
  Loader2,
} from 'lucide-react';
import { formatDistanceToNowStrict } from 'date-fns';
import { cn } from '../lib/utils';
import {
  emptyTrash,
  isTrashedNote,
  permanentlyDeleteNote,
  restoreNote,
} from '../lib/notes';

/**
 * Side panel listing soft-deleted notes. Renders ONLY trashed notes
 * (isTrashedNote) so the user sees exactly what's recoverable from
 * the trash, not the full notes table. Most recently deleted is at
 * the top — matches the "what did I just delete" expectation.
 *
 * Actions per row:
 *   - Restore       -> soft-restore the note + its subtree
 *   - Delete Forever -> permanently remove the note + its subtree
 *                      AND cascade-delete any attachments that belonged
 *                      to the purged subtree (so storage isn't pinned
 *                      by dead refs)
 *
 * Header actions:
 *   - ← Notes       -> flips the Sidebar's `showTrash` flag back off
 *   - Empty Trash   -> opens a confirm modal that calls emptyTrash()
 *
 * The component is intent-full: it never touches activeNoteId / layout
 * state directly. Sidebar owns the toggle flag and passes props.
 */
export function TrashView({ onBack }: { onBack: () => void }) {
  const trashNotes = useLiveQuery(
    async () =>
      (await db.notes.toArray())
        .filter(isTrashedNote)
        .sort((a, b) => (b.deletedAt ?? 0) - (a.deletedAt ?? 0)),
    [],
  );
  const [showEmptyConfirm, setShowEmptyConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!trashNotes) {
    return <div className="p-4 text-sm text-zinc-500">Loading...</div>;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider sticky top-0 bg-transparent backdrop-blur-3xl border-b border-white/60 dark:border-white/5 z-10 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Inbox className="w-3.5 h-3.5" />
          Trash ({trashNotes.length})
        </div>
        <button
          onClick={onBack}
          className="px-2 py-1 rounded text-[11px] text-zinc-600 dark:text-zinc-300 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 normal-case font-normal flex items-center gap-1"
          title="Back to notes"
        >
          <ArrowLeft className="w-3 h-3" /> Notes
        </button>
      </div>

      {trashNotes.length === 0 ? (
        <div className="p-6 text-center text-zinc-400 dark:text-zinc-600 mt-4 text-sm">
          <Trash2 className="w-10 h-10 opacity-30 mx-auto mb-2" />
          Trash is empty.
        </div>
      ) : (
        <>
          <div className="flex flex-col p-2 gap-1 pb-2">
            {trashNotes.map((note) => (
              <TrashRow key={note.id} note={note} disabled={busy} />
            ))}
          </div>
          <div className="border-t border-white/60 dark:border-white/5 p-2 shrink-0">
            <button
              onClick={() => setShowEmptyConfirm(true)}
              disabled={busy}
              className="w-full text-xs px-3 py-2 rounded text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/30 transition-colors disabled:opacity-50"
            >
              Empty Trash
            </button>
          </div>

          {showEmptyConfirm && (
            <div
              className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/20 dark:bg-black/50 backdrop-blur-sm"
              onClick={() => setShowEmptyConfirm(false)}
            >
              <div
                className="bg-white dark:bg-zinc-900 rounded-xl shadow-xl p-6 max-w-sm w-full border border-zinc-200 dark:border-zinc-800"
                onClick={(e) => e.stopPropagation()}
              >
                <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100 mb-2">
                  Empty Trash?
                </h3>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
                  Permanently delete all {trashNotes.length} trashed
                  {trashNotes.length === 1 ? ' item' : ' items'} and their
                  attachments? This cannot be undone.
                </p>
                <div className="flex justify-end gap-3">
                  <button
                    onClick={() => setShowEmptyConfirm(false)}
                    className="px-4 py-2 text-sm font-medium text-zinc-700 bg-zinc-100 dark:text-zinc-300 dark:bg-zinc-800 rounded-lg hover:bg-zinc-200 dark:hover:bg-zinc-700 transition"
                  >
                    Cancel
                  </button>
                  <button
                    onClick={async () => {
                      setBusy(true);
                      try {
                        await emptyTrash();
                      } finally {
                        setBusy(false);
                        setShowEmptyConfirm(false);
                      }
                    }}
                    className="px-4 py-2 text-sm font-medium text-white bg-red-500 rounded-lg hover:bg-red-600 transition disabled:opacity-50"
                    disabled={busy}
                  >
                    Empty Trash
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function TrashRow({ note, disabled }: { note: Note; disabled: boolean }) {
  const [working, setWorking] = useState<null | 'restore' | 'purge'>(null);

  const onRestore = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setWorking('restore');
    try {
      await restoreNote(note.id);
    } finally {
      setWorking(null);
    }
  };
  const onPurge = async (e: React.MouseEvent) => {
    e.stopPropagation();
    setWorking('purge');
    try {
      await permanentlyDeleteNote(note.id);
    } finally {
      setWorking(null);
    }
  };

  const deletedAt = note.deletedAt ?? 0;
  // formatDistanceToNowStrict emits e.g. "3 minutes", "1 day". Suffix it
  // ourselves because its addSuffix option uses pretty phrasing; we'll
  // prepend "deleted" for a consistent phrasing across the row.
  const relative = formatDistanceToNowStrict(new Date(deletedAt), {
    addSuffix: false,
  });

  return (
    <div
      aria-busy={working !== null}
      className={cn(
        'group flex items-center gap-2 p-2 rounded border border-transparent',
        'bg-white/40 dark:bg-zinc-800/20 text-zinc-700 dark:text-zinc-300',
        'hover:border-white/80 dark:hover:border-white/10 hover:bg-white/70 dark:hover:bg-zinc-800/40',
        'transition-all shadow-sm backdrop-blur-sm',
      )}
    >
      <div className="text-zinc-400 shrink-0">
        {note.isFolder ? (
          <Folder className="w-4 h-4 text-blue-400/60" />
        ) : (
          <FileText className="w-3.5 h-3.5" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">
          {note.title || (note.isFolder ? 'Untitled Folder' : 'Untitled')}
        </div>
        <div className="text-[10px] text-zinc-400 font-mono">
          deleted {relative}
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
        <button
          onClick={onRestore}
          disabled={disabled || working !== null}
          title="Restore"
          aria-label="Restore note"
          className="p-1.5 rounded text-zinc-500 hover:bg-zinc-200 dark:hover:bg-zinc-700 hover:text-zinc-900 dark:hover:text-zinc-100 disabled:opacity-50"
        >
          {working === 'restore' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <RotateCcw className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={onPurge}
          disabled={disabled || working !== null}
          title="Delete forever"
          aria-label="Delete note forever"
          className="p-1.5 rounded text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30 disabled:opacity-50"
        >
          {working === 'purge' ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <Trash2 className="w-3.5 h-3.5" />
          )}
        </button>
      </div>
    </div>
  );
}
