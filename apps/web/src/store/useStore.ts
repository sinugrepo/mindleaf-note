import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Theme } from '../types';
import {
  DEFAULT_SORT_DIRECTION,
  DEFAULT_SORT_MODE,
  type SortDirection,
  type SortMode,
} from '../lib/tags';

export interface SavedView {
  id: string;
  name: string;
  searchQuery: string;
  tagFilter: string[];
  sortMode: SortMode;
  sortDirection: SortDirection;
}

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
  savedViews: SavedView[];
  addSavedView: (name: string) => void;
  deleteSavedView: (id: string) => void;
  applySavedView: (id: string) => void;
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

function makeSavedViewId(): string {
  return `view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

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
      savedViews: [],
      addSavedView: (name) =>
        set((state) => ({
          savedViews: [
            ...state.savedViews,
            {
              id: makeSavedViewId(),
              name,
              searchQuery: state.searchQuery,
              tagFilter: [...state.tagFilter],
              sortMode: state.sortMode,
              sortDirection: state.sortDirection,
            },
          ],
        })),
      deleteSavedView: (id) =>
        set((state) => ({ savedViews: state.savedViews.filter((view) => view.id !== id) })),
      applySavedView: (id) =>
        set((state) => {
          const view = state.savedViews.find((candidate) => candidate.id === id);
          if (!view) return state;
          return {
            searchQuery: view.searchQuery,
            tagFilter: [...(view.tagFilter ?? [])],
            sortMode: view.sortMode ?? DEFAULT_SORT_MODE,
            // Saved views created before direction support do not have this
            // field. Falling back here prevents applying one from poisoning
            // the sort comparator with `undefined`.
            sortDirection: view.sortDirection ?? DEFAULT_SORT_DIRECTION,
          };
        }),
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
        savedViews: state.savedViews,
      }),
      version: 4,
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
        if (fromVersion < 4 || !Array.isArray(out.savedViews)) {
          out.savedViews = [];
        } else {
          // Normalize persisted views as well as the top-level state. Older
          // localStorage entries may predate sortDirection and tagFilter.
          out.savedViews = out.savedViews.map((rawView) => {
            const view = rawView as Partial<SavedView>;
            return {
              ...view,
              tagFilter: Array.isArray(view.tagFilter) ? view.tagFilter : [],
              sortMode: view.sortMode ?? DEFAULT_SORT_MODE,
              sortDirection: view.sortDirection ?? DEFAULT_SORT_DIRECTION,
            } as SavedView;
          });
        }
        return out;
      },
    },
  ),
);
