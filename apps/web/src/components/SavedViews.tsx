import React, { useState } from 'react';
import { Bookmark, Plus, Trash2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import { cn } from '../lib/utils';

export function SavedViews() {
  const views = useStore((state) => state.savedViews);
  const addSavedView = useStore((state) => state.addSavedView);
  const deleteSavedView = useStore((state) => state.deleteSavedView);
  const applySavedView = useStore((state) => state.applySavedView);
  const [name, setName] = useState('');
  const [selectedId, setSelectedId] = useState('');

  const save = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    addSavedView(trimmed);
    setName('');
  };

  return (
    <div className="px-3 pb-2 flex items-center gap-1.5">
      <Bookmark className="w-3 h-3 text-zinc-400 shrink-0" />
      <select
        aria-label="Saved views"
        value={selectedId}
        onChange={(event) => { setSelectedId(event.target.value); if (event.target.value) applySavedView(event.target.value); }}
        className="min-w-0 flex-1 bg-transparent text-[11px] text-zinc-500 dark:text-zinc-400 focus:outline-none"
      >
        <option value="">Saved views</option>
        {views.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
      </select>
      <input
        aria-label="New saved view name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') save(); }}
        placeholder="Save current…"
        className="w-20 bg-transparent text-[11px] border-b border-zinc-200 dark:border-zinc-700 focus:outline-none focus:border-blue-400"
      />
      <button type="button" aria-label="Save current view" title="Save current view" onClick={save} disabled={!name.trim()} className={cn('p-1 rounded hover:bg-zinc-200 dark:hover:bg-zinc-700 disabled:opacity-30')}><Plus className="w-3 h-3" /></button>
      {views.length > 0 && <button type="button" aria-label="Delete selected saved view" title="Delete selected saved view" disabled={!selectedId} onClick={() => { if (selectedId) { deleteSavedView(selectedId); setSelectedId(''); } }} className="p-1 rounded hover:bg-red-100 dark:hover:bg-red-900/30 text-red-500 disabled:opacity-30"><Trash2 className="w-3 h-3" /></button>}
    </div>
  );
}
