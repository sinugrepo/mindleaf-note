import React, { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useStore } from '../store/useStore';
import Fuse from 'fuse.js';
import { Note } from '../types';
import { cn } from '../lib/utils';
import { Search } from 'lucide-react';
import { isActiveNote } from '../lib/notes';
import { queuedPatchNote } from '../sync/queue';

export function SearchResults() {
  const { searchQuery, setActiveNoteId } = useStore();
  // Only ACTIVE notes are searchable. Trash items intentionally
  // excluded so users can't accidentally revive-and-jump-to a deleted
  // note by typing its old title. Filter at the query boundary so the
  // Fuse index never contains trashed items.
  const notes = useLiveQuery(
    async () => (await db.notes.toArray()).filter(isActiveNote),
    [],
  );

  const fuse = useMemo(() => {
    if (!notes) return null;
    return new Fuse(notes, {
      keys: ['title', 'content'],
      threshold: 0.3,
      includeMatches: true,
      ignoreLocation: true,
      minMatchCharLength: 2,
    });
  }, [notes]);

  if (!notes || !fuse) return <div className="p-4 text-xs text-zinc-500">Preparing search...</div>;

  const results = fuse.search(searchQuery);

  const getBreadcrumbs = (note: Note) => {
    let current = note;
    const path = [];
    while (current.parentId) {
      const parent = notes.find(n => n.id === current.parentId);
      if (parent) {
        path.unshift(parent.title || 'Untitled');
        current = parent;
      } else {
        break;
      }
    }
    return path;
  };

  const handleSelectResult = async (noteId: string) => {
    // Need to expand parents to ensure it's visible in tree when search is cleared
    let currentNote = notes.find(n => n.id === noteId);
    while (currentNote && currentNote.parentId) {
      await queuedPatchNote(currentNote.parentId, { isExpanded: true });
      currentNote = notes.find(n => n.id === currentNote.parentId);
    }
    
    // setActiveNote and clear search
    useStore.getState().setSearchQuery('');
    setActiveNoteId(noteId);
  };

  if (results.length === 0) {
    return (
      <div className="p-4 text-center text-zinc-500 mt-10">
        <Search className="w-8 h-8 opacity-20 mx-auto mb-2" />
        <p className="text-sm">No notes found matching "{searchQuery}".</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col">
      <div className="px-3 py-2 text-xs font-semibold text-zinc-500 uppercase tracking-wider sticky top-0 bg-transparent backdrop-blur-3xl border-b border-white/60 dark:border-white/5 z-10">
        Search Results ({results.length})
      </div>
      
      <div className="flex flex-col p-2 gap-1 pb-4">
        {results.map(({ item }) => {
          const path = getBreadcrumbs(item);
          return (
            <button
              key={item.id}
              onClick={() => handleSelectResult(item.id)}
              className="text-left p-2 rounded border border-transparent hover:border-white/80 dark:hover:border-white/10 bg-white/40 dark:bg-zinc-800/20 hover:bg-white/70 dark:hover:bg-zinc-800/40 transition-all group shadow-sm backdrop-blur-sm"
            >
              {path.length > 0 && (
                <div className="text-[10px] text-zinc-400 mb-0.5 font-medium truncate">
                  {path.join(' > ')}
                </div>
              )}
              <div className="text-sm font-semibold text-zinc-800 dark:text-zinc-200 truncate">
                {item.title || 'Untitled'}
              </div>
              {item.content && (
                <div className="text-xs text-zinc-500 dark:text-zinc-400 mt-1 line-clamp-2"
                     dangerouslySetInnerHTML={{ __html: item.content.replace(/<[^>]+>/g, ' ') }} 
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}
