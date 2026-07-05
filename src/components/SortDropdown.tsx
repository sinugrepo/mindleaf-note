import React from 'react';
import { useStore, SORT_MODE_LABELS, SORT_MODES } from '../store/useStore';
import { ArrowUpDown } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Compact sort-mode selector for the sidebar header. Cycle button
 * (rather than a full dropdown) — the four modes fit naturally on
 * 4 clicks, and this slot is already crowded with icon buttons.
 *
 * Pure presentational — reads `sortMode` and `setSortMode` from
 * zustand so the choice persists across page reloads and is
 * consumed by TreeView.
 *
 * Hidden from the trash view and from search-scoped results to
 * avoid confusing semantics (sort applies to root notes only).
 */
export function SortDropdown({ visible }: { visible: boolean }) {
  const sortMode = useStore((s) => s.sortMode);
  const setSortMode = useStore((s) => s.setSortMode);

  if (!visible) return null;

  const idx = SORT_MODES.indexOf(sortMode);
  const next = SORT_MODES[(idx + 1) % SORT_MODES.length];

  return (
    <button
      onClick={() => setSortMode(next)}
      title={`Sort by: ${SORT_MODE_LABELS[sortMode]} (click to cycle)`}
      data-testid="sort-dropdown"
      aria-label={`Sort by ${SORT_MODE_LABELS[sortMode]}`}
      className={cn(
        'shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded text-[11px] font-medium',
        'bg-zinc-200/50 dark:bg-zinc-800/50 text-zinc-600 dark:text-zinc-300',
        'hover:bg-zinc-200 dark:hover:bg-zinc-800 transition-colors',
      )}
    >
      <ArrowUpDown className="w-3 h-3 opacity-70" />
      <span className="font-mono">{SORT_MODE_LABELS[sortMode]}</span>
    </button>
  );
}
