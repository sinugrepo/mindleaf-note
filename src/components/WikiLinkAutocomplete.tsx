import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Editor as TiptapEditor } from '@tiptap/react';
import { db } from '../db/db';
import {
  ActiveWikiQuery,
  AutocompleteCandidate,
  InactiveWikiQuery,
  filterAndRankAutocomplete,
  findActiveWikiQuery,
  noteTitleAutocompleteCandidates,
} from '../lib/wikilink';
import { Hash, CornerDownLeft, X } from 'lucide-react';
import { cn } from '../lib/utils';

/**
 * Imperative API so the Editor component can dispatch navigation /
 * dismiss keypresses without prop-drilling state through the tree.
 *
 *  - isOpen()        : the popover is currently visible
 *  - moveSelection() : cycle the highlighted item
 *  - commitSelection(): insert the highlighted candidate as a wikiLink mark
 *  - dismiss()       : close the popover without inserting
 *
 * Returning false from any keydown lets TipTap / the browser run
 * normal text-input behavior (typing into the active wiki-query,
 * etc.).
 */
export interface WikiLinkAutocompleteHandle {
  isOpen: () => boolean;
  moveSelection: (dir: 1 | -1) => boolean;
  commitSelection: () => boolean;
  dismiss: () => boolean;
}

export interface WikiLinkAutocompleteProps {
  editor: TiptapEditor | null;
  /**
   * Note currently shown in the editor — exclude from candidate list so
   * `[[self]]` autocomplete never suggests itself.
   */
  excludeNoteId: string | null;
}

/**
 * Wiki-style `[[Note Title]]` autocomplete popover.
 *
 * Renders FLOATING (position: fixed) above the editor. TipTap exposes
 * the caret's viewport coordinates via `editor.view.coordsAtPos`; we
 * project those onto the popover's top-left. The popover lives in a
 * React portal-free approach because the Editor's wrapper is the top
 * of its column — overflow:auto scrolls the page around us but the
 * `position:fixed` popover escapes that.
 *
 * Keyboard navigation is delegated to the editor's `handleKeyDown`
 * (Editor.tsx adds it on mount) which calls back into this component
 * via the imperative ref API.
 */
export const WikiLinkAutocomplete = forwardRef<
  WikiLinkAutocompleteHandle,
  WikiLinkAutocompleteProps
>(function WikiLinkAutocomplete({ editor, excludeNoteId }, ref) {
  const [activeQuery, setActiveQuery] =
    useState<ActiveWikiQuery | InactiveWikiQuery>({ active: false });
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(
    null,
  );

  // Candidate list — pulled live from Dexie, filtered to active+named
  // notes (excluding self + trashed).
  const allNotes = useLiveQuery(() => db.notes.toArray(), []);
  const candidates = useMemo<AutocompleteCandidate[]>(() => {
    if (!allNotes) return [];
    return noteTitleAutocompleteCandidates(allNotes, excludeNoteId);
  }, [allNotes, excludeNoteId]);

  // Rank whenever the active query changes.
  const ranked = useMemo(() => {
    if (!activeQuery.active) return [];
    return filterAndRankAutocomplete(candidates, activeQuery.query);
  }, [candidates, activeQuery]);

  // Reset selection whenever the query shifts so the user always
  // starts at the top.
  useEffect(() => {
    if (activeQuery.active) setSelectedIndex(0);
  }, [activeQuery]);

  // Update editor-state-driven inputs on every transaction. TipTap's
  // `update` event covers text changes; `selectionUpdate` covers pure
  // caret moves (e.g. arrow keys that don't insert characters).
  const computeState = useCallback(() => {
    if (!editor) return;
    const text = editor.state.doc.textContent;
    const caret = editor.state.selection.head;
    const q = findActiveWikiQuery(text, caret);
    setActiveQuery(q);
    if (q.active) {
      // TipTap returns viewport coords relative to the editor's
      // root element; coordsAtPos gives the exact pixel. We use
      // `bottom` so the popover sits below the caret, and `left` as
      // the horizontal anchor.
      const vc = editor.view.coordsAtPos(caret);
      setCoords({ top: vc.bottom + 6, left: vc.left });
    } else {
      setCoords(null);
    }
  }, [editor]);

  useEffect(() => {
    if (!editor) return;
    computeState();
    editor.on('update', computeState);
    editor.on('selectionUpdate', computeState);
    return () => {
      editor.off('update', computeState);
      editor.off('selectionUpdate', computeState);
    };
  }, [editor, computeState]);

  // Insert the highlighted candidate as a wikiLink mark, replacing the
  // typed `[[query` substring. Closes the popover regardless of
  // outcome.
  const insertHighlighted = useCallback(() => {
    if (!editor) return false;
    if (!activeQuery.active) return false;
    const choice = ranked[selectedIndex];
    if (!choice) return false;
    const { start, end } = activeQuery;
    editor
      .chain()
      .focus()
      .deleteRange({ from: start, to: end })
      .insertContent({
        type: 'text',
        text: choice.title,
        marks: [
          {
            type: 'wikiLink',
            attrs: { targetId: choice.id, label: choice.title },
          },
        ],
      })
      // Reset the candidate cursor to "after the link" by appending
      // a space. inclusive:false means the mark won't extend over the
      // trailing space, so subsequent typing produces plain text.
      .insertContent(' ')
      .run();
    setCoords(null);
    return true;
  }, [editor, activeQuery, ranked, selectedIndex]);

  // Imperative handle exposed to the parent (Editor) so it can drive
  // keyboard navigation from the editor's handleKeyDown plugin.
  useImperativeHandle(
    ref,
    (): WikiLinkAutocompleteHandle => ({
      isOpen: () => activeQuery.active && coords !== null,
      moveSelection: (dir: 1 | -1) => {
        if (!activeQuery.active || ranked.length === 0) return false;
        setSelectedIndex((idx) => {
          const next = idx + dir;
          if (next < 0) return ranked.length - 1;
          if (next >= ranked.length) return 0;
          return next;
        });
        return true;
      },
      commitSelection: () => {
        if (!activeQuery.active) return false;
        return insertHighlighted();
      },
      dismiss: () => {
        if (!activeQuery.active) return false;
        setCoords(null);
        return true;
      },
    }),
    [activeQuery, coords, ranked, insertHighlighted],
  );

  // Render only when there is an active wiki-query AND there's at
  // least one candidate OR a "no matches" affordance is shown.
  // We DO render with empty ranked so the user sees a "no matches"
  // hint instead of the popover silently disappearing mid-typing.
  if (!activeQuery.active || !coords) return null;

  return (
    <div
      role="listbox"        aria-label="Note title suggestions"
        aria-activedescendant={
          ranked.length > 0
            ? `wikilink-option-${ranked[selectedIndex]?.id ?? ''}`
            : undefined
        }
        data-testid="wikilink-popover"
      className={cn(
        'fixed z-50 min-w-[240px] max-w-[320px]',
        'bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800',
        'rounded-lg shadow-xl overflow-hidden',
        'text-sm text-zinc-900 dark:text-zinc-100',
      )}
      style={{ top: coords.top, left: coords.left }}
    >
      <div className="px-3 py-1.5 border-b border-zinc-100 dark:border-zinc-800 text-[11px] uppercase font-semibold tracking-wide text-zinc-500 dark:text-zinc-400 flex items-center gap-1.5">
        <Hash className="w-3 h-3" />
        {ranked.length > 0 ? `${ranked.length} matches` : 'No matches'}
      </div>
      {ranked.length > 0 ? (
        <ul className="max-h-64 overflow-y-auto py-1">
          {ranked.map((c, i) => (
            <li                key={c.id}
                id={`wikilink-option-${c.id}`}
                role="option"
              aria-selected={i === selectedIndex}
              onMouseDown={(e) => {
                // mousedown (not click) so the editor doesn't lose
                // focus before we insertContent, which keeps the
                // caret layout coherent.
                e.preventDefault();
                setSelectedIndex(i);
                setTimeout(() => insertHighlighted(), 0);
              }}
              className={cn(
                'px-3 py-1.5 cursor-pointer truncate flex items-center gap-2',
                i === selectedIndex
                  ? 'bg-blue-50 dark:bg-blue-900/30 text-blue-900 dark:text-blue-100'
                  : 'hover:bg-zinc-50 dark:hover:bg-zinc-800/50',
              )}
            >
              <span className="truncate flex-1">{c.title}</span>
              {i === selectedIndex && (
                <CornerDownLeft className="w-3 h-3 opacity-70 shrink-0" />
              )}
            </li>
          ))}
        </ul>
      ) : (
        <div className="px-3 py-3 text-zinc-500 dark:text-zinc-400 italic flex items-center gap-2">
          <X className="w-3.5 h-3.5" />
          No notes match "{activeQuery.query}"
        </div>
      )}
    </div>
  );
});
