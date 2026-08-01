import React from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { useStore } from '../store/useStore';
import { extractAllTags } from '../lib/tags';
import { isTrashedNote } from '../lib/notes';
import { Hash, X } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Sidebar filter chip set. Renders the top-K most-used tags so the
 * user can click one (or several) to AND-filter the tree to "notes
 * that contain every selected tag". The selected set is mirrored by
 * `useStore.tagFilter` so the filter survives page reloads.
 *
 * Mounts immediately under the search box in Sidebar.tsx. Hidden
 * when the search query is non-empty OR when the trash view is
 * shown — those flows have their own scoping rules. Visible even
 * when there are zero tags (renders an empty state hint so the user
 * learns the feature exists).
 */
export function TagFilterBar() {
  const tagFilter = useStore((s) => s.tagFilter);
  const toggleTagFilter = useStore((s) => s.toggleTagFilter);
  const clearTagFilter = useStore((s) => s.clearTagFilter);

  // Live list of all available tags, recomputed on every table change.
  // We filter to ACTIVE notes because the sidebar never surfaces trash
  // items; this matches the existing `treeCount` / `trashCount`
  // selectors' filtering policy.
  const tags = useLiveQuery(async () => {
    const activeNotes: import('../types').Note[] = [];
    // Stream rows through Dexie instead of materializing the whole notes
    // table at once. The tag catalogue still has the same semantics, but
    // uses less peak memory as the local database grows.
    await db.notes.each((note) => {
      if (!isTrashedNote(note)) activeNotes.push(note);
    });
    return extractAllTags(activeNotes, 25);
  }, []);

  if (tags === undefined) {
    // Loading state — keep the layout height stable so the sidebar
    // doesn't jitter on every Dexie update.
    return (
      <div
        className="px-3 pb-2 shrink-0"
        style={{ minHeight: 32 }}
        aria-hidden
      />
    );
  }

  return (
    <div
      data-testid="tag-filter-bar"
      className="px-3 pb-2 shrink-0 flex flex-wrap items-center gap-1.5"
    >
      {tags.length === 0 ? (
        <span className="text-[11px] text-zinc-400 dark:text-zinc-600 italic">
          <Hash className="w-3 h-3 inline -mt-0.5 mr-0.5 opacity-50" />
          Add tags in the editor to filter the tree
        </span>
      ) : (
        <>
          {tags.map(({ tag, count }) => {
            const selected = tagFilter.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTagFilter(tag)}
                aria-pressed={selected}
                title={`Filter by #${tag} (${count} note${count === 1 ? '' : 's'})`}
                className={cn(
                  'group inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium transition-all',
                  selected
                    ? 'bg-blue-500 text-white shadow-sm hover:bg-blue-600'
                    : 'bg-white/60 dark:bg-zinc-800/40 text-zinc-600 dark:text-zinc-300 hover:bg-white dark:hover:bg-zinc-800 border border-zinc-200/60 dark:border-zinc-700/50',
                )}
              >
                <Hash className="w-2.5 h-2.5 opacity-60" />
                {tag}
                <span
                  className={cn(
                    'font-mono text-[9px] px-1 rounded',
                    selected
                      ? 'bg-blue-600/60 text-blue-50'
                      : 'bg-zinc-200/80 dark:bg-zinc-700/60 text-zinc-500 dark:text-zinc-400',
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
          {tagFilter.length > 0 && (
            <button
              onClick={clearTagFilter}
              title="Clear all tag filters"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100 hover:bg-zinc-200/60 dark:hover:bg-zinc-700/60 transition-colors"
            >
              <X className="w-3 h-3" />
              Clear ({tagFilter.length})
            </button>
          )}
        </>
      )}
    </div>
  );
}
