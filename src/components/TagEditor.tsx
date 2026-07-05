import React, { useEffect, useRef, useState } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { cn } from '../lib/utils';
import {
  Hash,
  Plus,
  X as XIcon,
} from 'lucide-react';
import {
  MAX_TAG_LENGTH,
  isValidTagInput,
  normalizeTag,
  type SortMode,
} from '../lib/tags';

/**
 * Per-note tag chip editor. Mounted in the Editor header below the
 * title + dates row. Lets the user add / remove tags for the
 * currently-active note. Autocomplete suggestions come from `tags.ts`
 * — we read the global note table via `useLiveQuery` so suggestions
 * track every other note's tag set in real time.
 *
 * Robust against unmount/remount races: the active note id changes
 * on every active-note switch and the editor re-fetches the row.
 *
 * Keyboard interaction:
 *   - Enter / comma : commit current input (if valid)
 *   - Backspace     : if input is empty, pop the last chip
 *   - Escape        : blur the input (doesn't discard the pending tag)
 */
export function TagEditor({ noteId }: { noteId: string }) {
  const note = useLiveQuery(() => db.notes.get(noteId), [noteId]);
  const allNotes = useLiveQuery(() => db.notes.toArray(), []);

  // Local-only state for the chip input. We intentionally keep the
  // typed string RAW (uppercase, mixed whitespace, leading `#`,
  // etc.) so the user sees their input verbatim; the tag is
  // normalized to canonical form only on commit. This mirrors how
  // most chat-message chip inputs behave.
  const [draft, setDraft] = useState<string>('');
  // `error` flashes briefly when the user typed something we
  // refused to commit. Lets them know what happened without
  // silently dropping their keystrokes.
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flashError = (msg: string) => {
    setError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(() => setError(null), 2200);
  };

  // Build the global tag catalogue from `allNotes` so the input
  // shows typeahead suggestions. Cheap O(N), recomputed on every
  // Dexie tick.
  const globalTags = React.useMemo(() => {
    if (!allNotes) return [] as string[];
    const set = new Set<string>();
    for (const n of allNotes) {
      if (n.deletedAt != null) continue;
      if (n.id === noteId) continue;
      for (const t of n.tags ?? []) set.add(t);
    }
    return Array.from(set).sort();
  }, [allNotes, noteId]);

  // Filter suggestions by what the user has typed so far. Same
  // case-insensitive substring rule as WikiLinkAutocomplete so the
  // UX feels consistent.
  const suggestions = React.useMemo(() => {
    const q = draft.trim().toLowerCase().replace(/^#/, '');
    if (!q) return [];
    return globalTags.filter(
      (t) => t.includes(q) && !(note?.tags ?? []).includes(t),
    ).slice(0, 6);
  }, [draft, globalTags, note?.tags]);

  // Typeahead: clicking a suggestion commits it.
  const commitTag = async (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    if (!isValidTagInput(trimmed)) {
      flashError('Tag contains invalid characters or is too long');
      return;
    }
    const canonical = normalizeTag(trimmed);
    if (!canonical) {
      flashError('Tag cannot be empty after normalization');
      return;
    }
    if (canonical.length > MAX_TAG_LENGTH) {
      flashError(`Tag exceeds ${MAX_TAG_LENGTH} characters`);
      return;
    }
    if ((note?.tags ?? []).includes(canonical)) {
      // Already present — quietly clear but don't write.
      setDraft('');
      return;
    }
    const next = [...(note?.tags ?? []), canonical];
    await db.notes.update(noteId, { tags: next, updatedAt: Date.now() });
    setDraft('');
    setError(null);
  };

  const removeTag = async (tag: string) => {
    if (!note) return;
    const next = (note.tags ?? []).filter((t) => t !== tag);
    await db.notes.update(noteId, { tags: next, updatedAt: Date.now() });
  };

  // No note loaded yet — render a skeleton row so the layout stays
  // stable while the editor is still mounting.
  if (!note) {
    return (
      <div
        className="mt-2 flex flex-wrap items-center gap-1.5"
        style={{ minHeight: 28 }}
        aria-hidden
      />
    );
  }

  const tags = note.tags ?? [];

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      void commitTag(draft);
    } else if (
      e.key === 'Backspace' &&
      draft === '' &&
      tags.length > 0
    ) {
      // Pop the last chip with a single Backspace, matching macOS
      // Finder tag bar behaviour.
      void removeTag(tags[tags.length - 1]);
    } else if (e.key === 'Escape') {
      inputRef.current?.blur();
    }
  };

  return (
    <div
      data-testid="tag-editor"
      className="mt-2 flex flex-wrap items-center gap-1.5"
    >
      <span
        className={cn(
          'inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[11px] font-medium',
          'text-zinc-500 dark:text-zinc-400 bg-zinc-100/40 dark:bg-zinc-800/40',
        )}
        title="Tags for this note"
      >
        <Hash className="w-3 h-3 opacity-70" />
        Tags
      </span>
      {tags.map((tag) => (
        <span
          key={tag}
          className="group inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 border border-blue-100 dark:border-blue-900/50"
        >
          {tag}
          <button
            onClick={() => void removeTag(tag)}
            title={`Remove #${tag}`}
            aria-label={`Remove tag ${tag}`}
            className="opacity-50 group-hover:opacity-100 hover:text-blue-900 dark:hover:text-blue-100 transition-opacity"
          >
            <XIcon className="w-3 h-3" />
          </button>
        </span>
      ))}
      <div className="relative inline-flex items-center">
        <input
          ref={inputRef}
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value);
            setError(null);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => {
            // Commit any non-empty draft on blur so users don't lose
            // a half-typed tag when they click elsewhere.
            if (draft.trim()) void commitTag(draft);
          }}
          placeholder="Add tag…"
          maxLength={MAX_TAG_LENGTH + 1}
          aria-label="Add a tag"
          className={cn(
            'px-2 py-1 rounded-md text-[11px] bg-transparent border-0 focus:outline-none focus:ring-0',
            'min-w-[120px] placeholder:text-zinc-400',
            error
              ? 'ring-1 ring-red-400'
              : 'focus:bg-white/40 dark:focus:bg-zinc-800/40',
          )}
        />
        {draft.trim() && (
          <button
            onClick={() => void commitTag(draft)}
            title="Add tag"
            aria-label="Add tag"
            className="px-1 py-0.5 rounded text-zinc-500 hover:text-blue-700 dark:hover:text-blue-300"
          >
            <Plus className="w-3 h-3" />
          </button>
        )}
      </div>

      {/* Typeahead suggestions — show only when the draft is non-empty
          AND there are matching global tags. Click to commit. Hides
          itself when nothing matches. */}
      {suggestions.length > 0 && (
        <div className="basis-full -mt-0.5 pl-1 flex flex-wrap gap-1">
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => void commitTag(s)}
              title={`Add #${s}`}
              className="px-2 py-0.5 rounded text-[10px] text-zinc-500 dark:text-zinc-400 hover:text-blue-700 dark:hover:text-blue-300 hover:bg-white/40 dark:hover:bg-zinc-800/40 transition-colors border border-dashed border-zinc-300/70 dark:border-zinc-700/70"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {error && (
        <span className="basis-full text-[10px] text-red-500 dark:text-red-400 pl-1 italic">
          {error}
        </span>
      )}
    </div>
  );
}

// Re-export SortMode for any code that imports both at once.
export type { SortMode };
