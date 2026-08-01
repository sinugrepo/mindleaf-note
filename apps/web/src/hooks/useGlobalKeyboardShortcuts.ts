import { useEffect } from 'react';

/**
 * Handler map for the global Ctrl/Cmd shortcuts. Only the keys that the
 * caller wants active should be supplied as functions; absent keys are
 * silently ignored, which lets callers opt in incrementally.
 */
export interface GlobalShortcuts {
  /** Ctrl+N (no Shift) — create a new root note. */
  onNewRootNote?: () => void | Promise<void>;
  /** Ctrl+Shift+N — create a child note under the active note. */
  onNewChildNote?: () => void | Promise<void>;
  /** Ctrl+F — focus the global search input. */
  onFocusSearch?: () => void;
  /** Ctrl+K — open the command palette. */
  onOpenCommandPalette?: () => void;
  /** Ctrl/Cmd+Z — undo the latest tree/title/tag operation. */
  onUndo?: () => void | Promise<void>;
  /** Ctrl/Cmd+Y or Ctrl/Cmd+Shift+Z — redo the latest tree/title/tag operation. */
  onRedo?: () => void | Promise<void>;
}

/**
 * Register global keyboard shortcuts.
 *
 *   Ctrl+S             — call `e.preventDefault()` to suppress the browser
 *                         "save page" dialog. Always active, regardless
 *                         of whether the user is typing in a content-
 *                         editable / input / textarea. The original
 *                         Layout-side handler did the same.
 *   Ctrl+N             — `onNewRootNote`  (no Shift)
 *   Ctrl+Shift+N       — `onNewChildNote`
 *   Ctrl+F             — `onFocusSearch`
 *
 * The handler intentionally does NOT gate on `isEditingText()` (INPUT,
 * TEXTAREA, contenteditable focus). The original implementation didn't
 * either, so we preserve that behavior — pressing Ctrl+N while typing in
 * the title input still creates a new root note. Per-component shortcuts
 * (e.g. TreeView's Delete) gate themselves in their own handlers.
 *
 * The hook re-binds the listener whenever the `handlers` object identity
 * changes. Callers with inline arrow functions on every render should
 * wrap their callbacks in `useCallback` (or memoize the `handlers` object)
 * to avoid needless re-binding. This is consistent with the original
 * Layout implementation that listed `[activeNoteId, setActiveNoteId]` as
 * deps; the hook exposes the same level of control.
 */
export function useGlobalKeyboardShortcuts(handlers: GlobalShortcuts): void {
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Always intercept Ctrl+S so the browser doesn't show its save
      // dialog / try to save the page HTML. Autosave handles persistence.
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault();
        return;
      }

      const key = e.key.toLowerCase();
      const modKey = e.ctrlKey || e.metaKey;

      const isTyping = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName || '') || document.activeElement?.getAttribute('contenteditable') === 'true';
      if (modKey && !e.altKey && key === 'z' && !isTyping) {
        if (e.shiftKey ? handlers.onRedo : handlers.onUndo) {
          e.preventDefault();
          void (e.shiftKey ? handlers.onRedo : handlers.onUndo)?.();
        }
        return;
      }
      if (modKey && !e.altKey && key === 'y' && !isTyping) {
        if (handlers.onRedo) {
          e.preventDefault();
          void handlers.onRedo();
        }
        return;
      }

      if (modKey && !e.shiftKey && key === 'n') {
        if (handlers.onNewRootNote) {
          e.preventDefault();
          handlers.onNewRootNote();
        }
        return;
      }

      if (modKey && e.shiftKey && key === 'n') {
        if (handlers.onNewChildNote) {
          e.preventDefault();
          handlers.onNewChildNote();
        }
        return;
      }

      if (modKey && !e.shiftKey && key === 'f') {
        if (handlers.onFocusSearch) {
          e.preventDefault();
          handlers.onFocusSearch();
        }
        return;
      }

      if (modKey && !e.shiftKey && key === 'k') {
        if (handlers.onOpenCommandPalette) {
          e.preventDefault();
          handlers.onOpenCommandPalette();
        }
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlers]);
}
