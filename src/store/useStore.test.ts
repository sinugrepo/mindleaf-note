import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useStore } from './useStore';

describe('useStore', () => {
  beforeEach(() => {
    // Reset store and persisted storage between tests
    localStorage.clear();
    useStore.setState({
      activeNoteId: null,
      searchQuery: '',
      theme: 'system',
    });
  });

  describe('setters', () => {
    it('updates activeNoteId', () => {
      useStore.getState().setActiveNoteId('abc');
      expect(useStore.getState().activeNoteId).toBe('abc');
    });

    it('allows clearing activeNoteId to null', () => {
      useStore.getState().setActiveNoteId('abc');
      useStore.getState().setActiveNoteId(null);
      expect(useStore.getState().activeNoteId).toBeNull();
    });

    it('updates searchQuery', () => {
      useStore.getState().setSearchQuery('hello');
      expect(useStore.getState().searchQuery).toBe('hello');
    });

    it('updates theme', () => {
      useStore.getState().setTheme('dark');
      expect(useStore.getState().theme).toBe('dark');
    });
  });

  describe('default state', () => {
    it('initializes activeNoteId to null', () => {
      expect(useStore.getState().activeNoteId).toBeNull();
    });

    it('initializes searchQuery to empty', () => {
      expect(useStore.getState().searchQuery).toBe('');
    });

    it('initializes theme to "system"', () => {
      expect(useStore.getState().theme).toBe('system');
    });
  });

  describe('persist / partialize', () => {
    it('persists theme and activeNoteId to localStorage', () => {
      useStore.getState().setActiveNoteId('persisted-id');
      useStore.getState().setTheme('dark');
      const raw = localStorage.getItem('treenote-storage');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      expect(parsed.state.activeNoteId).toBe('persisted-id');
      expect(parsed.state.theme).toBe('dark');
    });

    it('does NOT persist searchQuery (partialize excludes it)', () => {
      useStore.getState().setSearchQuery('transient');
      const raw = localStorage.getItem('treenote-storage');
      const parsed = JSON.parse(raw!);
      // searchQuery should not appear in the persisted state
      expect(parsed.state.searchQuery).toBeUndefined();
    });

    it('uses storage key "treenote-storage"', () => {
      useStore.getState().setTheme('light');
      expect(localStorage.getItem('treenote-storage')).not.toBeNull();
    });
  });

  describe('state transitions', () => {
    it('handles rapid successive updates without losing values', () => {
      useStore.getState().setSearchQuery('a');
      useStore.getState().setSearchQuery('b');
      useStore.getState().setSearchQuery('c');
      expect(useStore.getState().searchQuery).toBe('c');
    });

    it('handles cross-field updates independently', () => {
      useStore.getState().setTheme('dark');
      useStore.getState().setActiveNoteId('n1');
      expect(useStore.getState().theme).toBe('dark');
      expect(useStore.getState().activeNoteId).toBe('n1');
      // searchQuery remained untouched
      expect(useStore.getState().searchQuery).toBe('');
    });
  });

  describe('rehydration', () => {
    /**
     * Helper: seed localStorage with a zustand-persist-shaped blob and trigger
     * `useStore.persist.rehydrate()` so the OUTER (top-of-file) useStore is
     * re-populated from storage. We deliberately do NOT use vi.resetModules +
     * dynamic import because that would create a second store instance and
     * introduce a state-leak risk; the persist API is the documented way to
     * re-run hydration on the same store.
     */
    async function rehydrateFrom(blob: { version: number; state: Record<string, unknown> }) {
      localStorage.setItem('treenote-storage', JSON.stringify(blob));
      await useStore.persist.rehydrate();
      // Browser-promise chain: rehydrate is async, but setState happens synchronously
      // inside it; an explicit microtask await ensures tests see the post-hydrate state.
      await Promise.resolve();
    }

    it('restores theme and activeNoteId from a clean persisted blob', async () => {
      // Realistic blob shape: a normal save produces ONLY the partialized fields
      // (theme + activeNoteId). searchQuery is intentionally absent because the
      // SAVE path filters it out via partialize (covered by the next test).
      await rehydrateFrom({
        version: 0,
        state: {
          theme: 'light',
          activeNoteId: 'restored-note-id',
        },
      });

      const state = useStore.getState();
      expect(state.theme).toBe('light');
      expect(state.activeNoteId).toBe('restored-note-id');
      // Action functions remain present after rehydration.
      expect(typeof state.setActiveNoteId).toBe('function');
      expect(typeof state.setTheme).toBe('function');
      expect(typeof state.setSearchQuery).toBe('function');
    });

    it('does NOT write searchQuery through to localStorage when calling setSearchQuery (partialize-on-save)', async () => {
      // After potential rehydrate, start clean.
      localStorage.clear();
      await useStore.persist.rehydrate();

      useStore.getState().setSearchQuery('transient-session-value');
      useStore.getState().setTheme('dark');
      useStore.getState().setActiveNoteId('note-42');

      // Defensive microtask flush: zustand persist writes via subscriber
      // callback; in jsdom + localStorage it's typically synchronous, but we
      // await once to remove any timing risk before reading storage back.
      await Promise.resolve();

      const raw = localStorage.getItem('treenote-storage');
      expect(raw).not.toBeNull();
      const parsed = JSON.parse(raw!);
      // partialize only emitted theme + activeNoteId
      expect(parsed.state.theme).toBe('dark');
      expect(parsed.state.activeNoteId).toBe('note-42');
      expect(parsed.state.searchQuery).toBeUndefined();
    });

    it('rehydrate with empty storage does not clobber in-memory state', async () => {
      // Snapshot whatever the previous test left as the current in-memory state,
      // then clear localStorage and call rehydrate: the store must NOT pull
      // anything new from storage (because there is none) and must keep the
      // in-memory values intact.
      const before = useStore.getState();

      localStorage.clear();
      await useStore.persist.rehydrate();
      await Promise.resolve();

      const after = useStore.getState();
      // Theme + activeNoteId must be unchanged from before-clear.
      expect(after.theme).toBe(before.theme);
      expect(after.activeNoteId).toBe(before.activeNoteId);
      // Action functions stay defined.
      expect(typeof after.setTheme).toBe('function');
      expect(typeof after.setActiveNoteId).toBe('function');
    });

    it('rehydrate from a corrupt JSON blob falls back without throwing', async () => {
      localStorage.setItem('treenote-storage', '{not valid json');
      // Should not throw.
      await expect(useStore.persist.rehydrate()).resolves.toBeUndefined();
      // Store remains usable after the failed parse.
      expect(typeof useStore.getState().setTheme).toBe('function');
    });
  });
});
