import React, { useState } from 'react';
import { Download, Hash, Move, Trash2, X } from 'lucide-react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useStore } from '../store/useStore';
import { exportNotesAsFile } from '../lib/notes-io';
import { softDeleteNote } from '../lib/notes';
import { queuedPatchNote } from '../sync/queue';
import { validateDropTarget } from '../lib/tree-ops';

export function BulkActions() {
  const selectedIds = useStore((state) => state.selectedNoteIds);
  const clearNoteSelection = useStore((state) => state.clearNoteSelection);
  const [busy, setBusy] = useState(false);
  const notes = useLiveQuery(() => db.notes.toArray(), [], []);
  if (selectedIds.length === 0 || !notes) return null;

  const selected = notes.filter((note) => selectedIds.includes(note.id) && note.deletedAt == null);
  const folders = notes.filter((note) => note.isFolder && note.deletedAt == null);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
      clearNoteSelection();
    } finally {
      setBusy(false);
    }
  };

  const selectedIdsSet = new Set(selected.map((note) => note.id));
  const selectedRoots = selected.filter((note) => {
    let parentId = note.parentId;
    while (parentId) {
      if (selectedIdsSet.has(parentId)) return false;
      parentId = notes.find((candidate) => candidate.id === parentId)?.parentId ?? null;
    }
    return true;
  });

  const deleteSelected = () => run(async () => {
    for (const note of selectedRoots) await softDeleteNote(note.id);
  });

  const addTag = () => run(async () => {
    const tag = window.prompt('Tag to add (without #):')?.trim().toLowerCase();
    if (!tag) return;
    for (const note of selected) {
      const tags = Array.from(new Set([...(note.tags ?? []), tag]));
      await queuedPatchNote(note.id, { tags });
    }
  });

  const moveTo = (parentId: string | null) => run(async () => {
    const target = parentId ? notes.find((note) => note.id === parentId) : null;
    for (const [index, note] of selectedRoots.entries()) {
      if (target && !validateDropTarget(note.id, target, notes).valid) continue;
      await queuedPatchNote(note.id, { parentId, order: Date.now() + index });
    }
    if (parentId && target) await queuedPatchNote(parentId, { isExpanded: true });
  });

  return (
    <div className="mx-1 mb-2 rounded-lg border border-blue-200/80 dark:border-blue-900/60 bg-blue-50/80 dark:bg-blue-950/30 p-2 shadow-sm">
      <div className="flex items-center gap-1.5 text-[11px] text-blue-700 dark:text-blue-300">
        <span className="font-semibold">{selected.length} selected</span>
        <button type="button" onClick={clearNoteSelection} aria-label="Clear selected notes" className="ml-auto rounded p-1 hover:bg-blue-100 dark:hover:bg-blue-900/50"><X className="w-3 h-3" /></button>
      </div>
      <div className="mt-1.5 flex flex-wrap gap-1">
        <button type="button" disabled={busy} onClick={() => void addTag()} title="Add tag to selected notes" className="inline-flex items-center gap-1 rounded bg-white/80 dark:bg-zinc-800 px-2 py-1 text-[10px] disabled:opacity-50"><Hash className="w-3 h-3" />Tag</button>
        <label className="inline-flex items-center gap-1 rounded bg-white/80 dark:bg-zinc-800 px-2 py-1 text-[10px] text-zinc-700 dark:text-zinc-200">
          <Move className="w-3 h-3" />
          <span>Move to</span>
          <select disabled={busy} aria-label="Move selected notes to folder" value="" onChange={(event) => { if (event.target.value === '__root__') void moveTo(null); else if (event.target.value) void moveTo(event.target.value); }} className="max-w-28 bg-transparent text-[10px] focus:outline-none">
            <option value="">Choose folder</option><option value="__root__">Root</option>{folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.title || 'Untitled folder'}</option>)}
          </select>
        </label>
        <button type="button" disabled={busy} onClick={() => void run(() => exportNotesAsFile(selected))} title="Export selected notes" className="inline-flex items-center gap-1 rounded bg-white/80 dark:bg-zinc-800 px-2 py-1 text-[10px] disabled:opacity-50"><Download className="w-3 h-3" />Export</button>
        <button type="button" disabled={busy} onClick={() => void deleteSelected()} title="Move selected notes to trash" className="inline-flex items-center gap-1 rounded bg-red-100 dark:bg-red-950/50 px-2 py-1 text-[10px] text-red-600 dark:text-red-400 disabled:opacity-50"><Trash2 className="w-3 h-3" />Trash</button>
      </div>
    </div>
  );
}
