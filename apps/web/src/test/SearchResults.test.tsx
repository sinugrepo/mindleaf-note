import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useStore } from '../store/useStore';
import type { Note } from '../types';

let liveNotes: Note[] | undefined;

vi.mock('dexie-react-hooks', () => ({
  useLiveQuery: () => liveNotes,
}));

vi.mock('../db/db', () => ({
  db: {
    notes: {},
  },
}));

vi.mock('../sync/queue', () => ({
  queuedPatchNote: vi.fn().mockResolvedValue(undefined),
}));

import { SearchResults } from '../components/SearchResults';

function makeNote(partial: Partial<Note>): Note {
  return {
    id: partial.id ?? 'note-1',
    parentId: partial.parentId ?? null,
    title: partial.title ?? 'Untitled',
    content: partial.content ?? '',
    order: partial.order ?? 0,
    isExpanded: partial.isExpanded ?? false,
    createdAt: partial.createdAt ?? 0,
    updatedAt: partial.updatedAt ?? 0,
    ...partial,
  };
}

describe('SearchResults', () => {
  beforeEach(() => {
    liveNotes = undefined;
    useStore.setState({
      searchQuery: 'abc',
      activeNoteId: null,
    });
  });

  it('survives IndexedDB loading and renders results when notes become available', () => {
    const view = render(<SearchResults />);
    expect(screen.getByText('Preparing search...')).toBeInTheDocument();

    liveNotes = [makeNote({ title: 'ABC project' })];
    view.rerender(<SearchResults />);

    expect(screen.getByText('ABC project')).toBeInTheDocument();
    expect(screen.queryByText('Preparing search...')).not.toBeInTheDocument();
  });
});
