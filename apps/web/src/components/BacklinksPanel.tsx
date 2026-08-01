import React, { useMemo } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/db';
import { Note } from '../types';
import { Link2 } from 'lucide-react';
import { useStore } from '../store/useStore';
import { extractBacklinkedNoteIds, WIKILINK_ID_ATTR } from '../lib/wikilink';

/**
 * "Linked references" panel shown above the editor toolbar. Lists every
 * active note whose `content` HTML contains a span with a matching
 * `data-wikilink-id` attribute pointing at the currently-open note.
 *
 * Lives in the editor area rather than the sidebar so the link graph
 * sits next to the content it pertains to — matches the Obsidian /
 * Logseq convention.
 *
 * Reads `notes` via Dexie's `useLiveQuery`, so the list updates live
 * as the user opens, edits, or deletes other notes. The scan is
 * O(notes * content_length), which for a personal outliner (low
 * thousands of short notes) is sub-millisecond. If we ever ship to
 * users with tens of thousands of notes, swap in an indexed
 * in-memory trie keyed on wiki-link id without changing this
 * component's prop surface.
 */
export function BacklinksPanel({ activeNoteId }: { activeNoteId: string }) {
  const allNotes = useLiveQuery(async () => {
    const out: Note[] = [];
    // Iterate through IndexedDB without materializing a second full-table
    // array. Only active backlink candidates are retained for rendering.
    await db.notes.each((note) => {
      if (note.id !== activeNoteId && note.deletedAt == null) out.push(note);
    });
    return out;
  }, [activeNoteId]);

  // Build the list of "notes that reference me". Pure-JS scan of
  // every active note's content; tested by extractBacklinkedNoteIds
  // unit tests for the regex piece.
  const backlinks = useMemo<Note[]>(() => {
    if (!allNotes) return [];
    const out: Note[] = [];
    for (const note of allNotes) {
      if (extractBacklinkedNoteIds(note.content).includes(activeNoteId)) {
        out.push(note);
      }
    }
    return out;
  }, [allNotes, activeNoteId]);

  if (allNotes === undefined) return null;
  if (backlinks.length === 0) return null;

  return (
    <div
      data-testid="backlinks-panel"
      className="mt-3 mb-2 mx-1 px-3 py-2 rounded-md border border-zinc-200/70 dark:border-zinc-700/40 bg-white/40 dark:bg-zinc-900/30 text-xs"
    >
      <div className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 mb-1.5 font-mono uppercase tracking-wide text-[10px]">
        <Link2 className="w-3 h-3" />
        Linked references ({backlinks.length})
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {backlinks.map((note) => (
          <BacklinkChip key={note.id} note={note} />
        ))}
      </ul>
    </div>
  );
}

function BacklinkChip({ note }: { note: Note }) {
  const setActive = useStore((s) => s.setActiveNoteId);
  const title =
    note.title || (note.isFolder ? 'Untitled Folder' : 'Untitled');
  return (
    <li>
      <button
        onClick={() => setActive(note.id)}
        title={`Open: ${title}`}
        data-wikilink-id={WIKILINK_ID_ATTR}
        className="wikilink inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 hover:bg-blue-100 dark:bg-blue-900/30 dark:hover:bg-blue-900/50 text-blue-700 dark:text-blue-300 transition-colors truncate max-w-[260px]"
      >
        <Link2 className="w-3 h-3 opacity-70 shrink-0" />
        <span className="truncate">{title}</span>
      </button>
    </li>
  );
}
