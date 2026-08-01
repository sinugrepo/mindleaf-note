import React from 'react';
import {
  SORT_DIRECTION_LABELS,
  SORT_MODE_LABELS,
  SORT_MODES,
  useStore,
} from '../store/useStore';
import { ArrowDownAZ, ArrowUpAZ } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Sort controls for the root-level tree. The field selector and direction
 * are separate so users can choose combinations such as Title descending
 * or Updated ascending without cycling through unrelated modes.
 */
export function SortDropdown({ visible }: { visible: boolean }) {
  const sortMode = useStore((s) => s.sortMode);
  const setSortMode = useStore((s) => s.setSortMode);
  const sortDirection = useStore((s) => s.sortDirection);
  const setSortDirection = useStore((s) => s.setSortDirection);

  if (!visible) return null;

  const DirectionIcon = sortDirection === 'asc' ? ArrowUpAZ : ArrowDownAZ;

  return (
    <div
      data-testid="sort-dropdown"
      className="flex items-center justify-end gap-1 text-[11px]"
      aria-label="Tree sort controls"
    >
      <label htmlFor="tree-sort-mode" className="sr-only">
        Sort field
      </label>
      <select
        id="tree-sort-mode"
        value={sortMode}
        onChange={(e) => setSortMode(e.target.value as (typeof SORT_MODES)[number])}
        title={`Sort by ${SORT_MODE_LABELS[sortMode]}`}
        className="max-w-[6.5rem] rounded border border-zinc-200/70 bg-white/50 px-1.5 py-1 font-medium text-zinc-600 outline-none transition-colors hover:bg-white focus:ring-2 focus:ring-blue-400/50 dark:border-zinc-700/70 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-800"
      >
        {SORT_MODES.map((mode) => (
          <option key={mode} value={mode}>
            {SORT_MODE_LABELS[mode]}
          </option>
        ))}
      </select>
      <button
        type="button"
        onClick={() => setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc')}
        title={`${SORT_DIRECTION_LABELS[sortDirection]} — click to switch`}
        aria-label={`Sort direction: ${SORT_DIRECTION_LABELS[sortDirection]}`}
        aria-pressed={sortDirection === 'desc'}
        className={cn(
          'inline-flex items-center gap-1 rounded border px-1.5 py-1 font-medium transition-colors',
          'border-zinc-200/70 bg-white/50 text-zinc-600 hover:bg-white',
          'dark:border-zinc-700/70 dark:bg-zinc-900/40 dark:text-zinc-300 dark:hover:bg-zinc-800',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-400/60',
        )}
      >
        <DirectionIcon className="h-3.5 w-3.5" />
        <span className="hidden sm:inline">{sortDirection === 'asc' ? 'Asc' : 'Desc'}</span>
      </button>
    </div>
  );
}
