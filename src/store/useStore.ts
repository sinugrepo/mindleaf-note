import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { Theme } from '../types';
import { DEFAULT_SORT_MODE, type SortMode } from '../lib/tags';

interface AppState {
  activeNoteId: string | null;
  setActiveNoteId: (id: string | null) => void;
  searchQuery: string;
  setSearchQuery: (query: string) => void;
  theme: Theme;
  setTheme: (theme: Theme) => void;
  // Tier-2 Sort + Tags state. Both serialize via the persist
  // middleware so the user's preferred sort + active filter survive
  // page reloads. New fields are populated with safe defaults on
  // first read after a version bump (see `migrate` below).
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  tagFilter: string[];
  setTagFilter: (tags: string[]) => void;
  toggleTagFilter: (tag: string) => void;
  clearTagFilter: () => void;
}

/**
 * Human-readable labels for the sort dropdown. Kept here (not in
 * tags.ts) because the UI is the only consumer — keep the storage-
 * layer helper free of i18n concerns.
 */
export const SORT_MODE_LABELS: Record<SortMode, string> = {
  manual: 'Manual',
  updatedAt: 'Updated',
  title: 'Title',
  createdAt: 'Created',
};

export const SORT_MODES: SortMode[] = [
  'manual',
  'updatedAt',
  'title',
  'createdAt',
];

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
      tagFilter: [],
      setTagFilter: (tags) => set({ tagFilter: tags }),
      toggleTagFilter: (tag) =>
        set((state) => {
          // Toggle semantics: add if absent, remove if present. We
          // intentionally re-set to a fresh array so React's
          // referential equality check for useMemo/useEffect picks
          // up the change even when the new array would have the
          // same length (different contents).
          const set = new Set(state.tagFilter);
          if (set.has(tag)) set.delete(tag);
          else set.add(tag);
          return { tagFilter: Array.from(set) };
        }),
      clearTagFilter: () => set({ tagFilter: [] }),
    }),
    {
      name: 'treenote-storage',
      partialize: (state) => ({
        // Persist: theme (already), activeNoteId (already), SortMode
        // and tagFilter (new). searchQuery is intentionally NOT
        // persisted — the next session probably wants an empty
        // search input.
        theme: state.theme,
        activeNoteId: state.activeNoteId,
        sortMode: state.sortMode,
        tagFilter: state.tagFilter,
      }),
      // Bump version when persisted shape changes. v0 / v1 carried
      // only `theme` + `activeNoteId`. v2 adds `sortMode` +
      // `tagFilter`. The `migrate` callback below copies the legacy
      // fields forward and supplies defaults for the new ones so the
      // user's theme/activeNoteId don't get silently reset on first
      // reload after the upgrade. The rehydration test in
      // `useStore.test.ts` relies on this.
      version: 2,
      migrate: (persistedState, fromVersion): Partial<AppState> | unknown => {
        // Guard against a malformed / corrupted blob (e.g. someone
        // hand-tampered localStorage). zustand-persist already
        // catches JSON.parse throws; this catches the case where
        // the parsed shape is structurally wrong.
        if (
          !persistedState ||
          typeof persistedState !== 'object' ||
          Array.isArray(persistedState)
        ) {
          return {};
        }
        const out: Partial<AppState> = {
          ...(persistedState as Partial<AppState>),
        };
        if (fromVersion < 2) {
          // v0 / v1 blobs never had sortMode / tagFilter — supply
          // the documented defaults so the rest of the app sees a
          // fully populated state object.
          if (out.sortMode === undefined) out.sortMode = DEFAULT_SORT_MODE;
          if (out.tagFilter === undefined) out.tagFilter = [];
        }
        return out;
      },
    },
  )
);
