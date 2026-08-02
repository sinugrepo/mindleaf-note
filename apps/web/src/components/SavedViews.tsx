import React, { useState } from 'react';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import { cn } from '../lib/utils';

export function SavedViews() {
  const views = useStore((state) => state.savedViews);
  const selectedId = useStore((state) => state.activeSavedViewId);
  const addSavedView = useStore((state) => state.addSavedView);
  const deleteSavedView = useStore((state) => state.deleteSavedView);
  const applySavedView = useStore((state) => state.applySavedView);
  const clearActiveSavedView = useStore((state) => state.clearActiveSavedView);
  const [name, setName] = useState('');

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addSavedView(trimmed);
    setName('');
  };

  const handleSelectionChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const id = event.target.value;
    if (id) applySavedView(id);
    else clearActiveSavedView();
  };

  const deleteSelected = () => {
    if (selectedId) deleteSavedView(selectedId);
  };

  return (
    <div className="px-3 pb-2 flex flex-wrap items-center gap-1.5">
      <Bookmark className="w-3.5 h-3.5 text-zinc-400 shrink-0" aria-hidden="true" />
      <select
        aria-label="Saved views"
        value={selectedId ?? ''}
        onChange={handleSelectionChange}
        className="order-1 min-w-0 flex-1 basis-[8rem] rounded border border-zinc-200/70 bg-white/50 px-1.5 py-1 text-[11px] text-zinc-600 outline-none transition-colors hover:bg-white focus:ring-2 focus:ring-blue-400/50 dark:border-zinc-700/70 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        <option value="">Saved views</option>
        {views.map((view) => (
          <option key={view.id} value={view.id}>
            {view.name}
          </option>
        ))}
      </select>
      <input
        aria-label="New saved view name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') save();
        }}
        placeholder="Save current…"
        className="order-3 min-w-0 flex-1 basis-[7rem] bg-transparent text-[11px] border-b border-zinc-200 py-1 focus:outline-none focus:border-blue-400 dark:border-zinc-700"
      />
      <div className="order-2 flex items-center gap-0.5 shrink-0">
        <button
          type="button"
          aria-label="Save current view"
          title="Save current view"
          onClick={save}
          disabled={!name.trim()}
          className={cn(
            'p-1.5 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60 disabled:opacity-30',
          )}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          aria-label="Delete selected saved view"
          title="Delete selected saved view"
          disabled={!selectedId}
          onClick={deleteSelected}
          className="p-1.5 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400/60 disabled:opacity-30"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}
