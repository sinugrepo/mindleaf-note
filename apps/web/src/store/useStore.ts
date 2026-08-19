import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Theme } from '../types';
import {
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_MODE,
  type SortDirection,
  type SortMode,
} from '../lib/tags';

interface AppState {
  activeNoteId: string | null;
  setActiveNoteId: (id: string | null) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  sortDirection: SortDirection;
  setSortDirection: (direction: SortDirection) => void;
  tagFilter: string[];
  setTagFilter: (tags: string[]) => void;
  toggleTagFilter: (tag: string) => void;
  clearTagFilter: () => void;
  selectedNoteIds: string[];
  toggleNoteSelection: (id: string) => void;
  clearNoteSelection: () => void;
  setNoteSelection: (ids: string[]) => void;
}

export const SORT_MODE_LABELS: Record<SortMode, string> = {
  manual: 'Manual',
  updatedAt: 'Updated',
  title: 'Title',
  createdAt: 'Created',
};

export const SORT_MODES: SortMode[] = ['manual', 'updatedAt', 'title', 'createdAt'];

export const SORT_DIRECTION_LABELS: Record<SortDirection, string> = {
  asc: 'Ascending',
  desc: 'Descending',
};

export const useStore = create<AppState>()(
  persist(
    (set) => ({
      activeNoteId: null,
      setActiveNoteId: (id) => set({ activeNoteId: id }),
      searchQuery: '',
      setSearchQuery: (query) => set({ searchQuery: query }),
      theme: 'system',
      setTheme: (theme) => set({ theme }),
      sortMode: DEFAULT_SORT_MODE,
      setSortMode: (mode) => set({ sortMode: mode }),
      sortDirection: DEFAULT_SORT_DIRECTION,
      setSortDirection: (direction) => set({ sortDirection: direction }),
      tagFilter: [],
      setTagFilter: (tags) => set({ tagFilter: tags }),
      toggleTagFilter: (tag) =>
        set((state) => {
          const tags = new Set(state.tagFilter);
          if (tags.has(tag)) tags.delete(tag);
          else tags.add(tag);
          return { tagFilter: Array.from(tags) };
        }),
      clearTagFilter: () => set({ tagFilter: [] }),
      selectedNoteIds: [],
      toggleNoteSelection: (id) =>
        set((state) => ({
          selectedNoteIds: state.selectedNoteIds.includes(id)
            ? state.selectedNoteIds.filter((selected) => selected !== id)
            : [...state.selectedNoteIds, id],
        })),
      clearNoteSelection: () => set({ selectedNoteIds: [] }),
      setNoteSelection: (ids) => set({ selectedNoteIds: [...new Set(ids)] }),
    }),
    {
      name: 'treenote-storage',
      partialize: (state) => ({
        theme: state.theme,
        activeNoteId: state.activeNoteId,
        sortMode: state.sortMode,
        sortDirection: state.sortDirection,
        tagFilter: state.tagFilter,
      }),
      version: 6,
      migrate: (persistedState, fromVersion): Partial<AppState> | unknown => {
        if (!persistedState || typeof persistedState !== 'object' || Array.isArray(persistedState)) {
          return {};
        }
        const out: Partial<AppState> = { ...(persistedState as Partial<AppState>) };
        if (fromVersion < 2) {
          if (out.sortMode === undefined) out.sortMode = DEFAULT_SORT_MODE;
          if (out.tagFilter === undefined) out.tagFilter = [];
        }
        if (fromVersion < 3 && out.sortDirection === undefined) {
          out.sortDirection = DEFAULT_SORT_DIRECTION;
        }
        // Version 6 removed Saved Views. Drop the old persisted fields so
        // stale presets do not survive in localStorage after migration.
        const legacyState = out as Partial<AppState> & {
          savedViews?: unknown;
          activeSavedViewId?: unknown;
        };
        delete legacyState.savedViews;
        delete legacyState.activeSavedViewId;
        return out;
      },
    },
  ),
);
