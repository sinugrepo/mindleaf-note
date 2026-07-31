import { useEffect, useRef, type KeyboardEvent, type RefObject } from 'react';

/**
 * Selector for the elements considered focusable inside the trapped
 * region.
 *
 * Each branch independently excludes `disabled` controls and
 * `tabindex="-1"` so we never cycle onto inert buttons. The catch-all
 * `[tabindex]:not([tabindex="-1"]):not([disabled])` clause picks up
 * custom-tabbable non-form elements (e.g. `<div tabindex="0">`) while
 * STILL honoring the disabled attribute — without the explicit
 * `:not([disabled])` here, a `<button tabindex="0" disabled>` would
 * slip through this clause (the type-specific branches above don't
 * apply because the disabled test fails) and the trap would focus
 * an inert control.
 */
const FOCUSABLE_SELECTOR = [
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  'a[href]:not([tabindex="-1"])',
  '[tabindex]:not([tabindex="-1"]):not([disabled])',
].join(',');

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
}

/**
 * Trap keyboard focus within `containerRef` while `isOpen` is true.
 *
 * Behaviour:
 *   1. **On open**: snapshots the currently-focused element (the
 *      trigger) and moves focus to the first focusable descendant
 *      inside the container.
 *   2. **While open**: the consumer attaches the returned `onKeyDown`
 *      handler to the container/backdrop. The handler cycles Tab /
 *      Shift+Tab within the region and wraps focus from the last
 *      element back to the first (and vice-versa). Other keys pass
 *      through so the consumer's existing Escape-on-backdrop handler
 *      keeps working.
 *   3. **On close**: restores focus to the snapshotted element so the
 *      user lands back where they triggered the modal — matches the
 *      WAI-ARIA Authoring Practices "Modal Dialog" example.
 *
 * Defensive cases:
 *   - Empty focusable list → initial focus is a no-op; Tab is
 *     `preventDefault`'d so focus never leaves the (empty) container.
 *   - Single focusable → Tab/Shift+Tab keep focus on it
 *     (`preventDefault`), no oscillation.
 *   - Snapshot element disappeared from DOM during the open window
 *     (rare, but happens during reactive unmounts) → falls back to
 *     `document.body` instead of throwing.
 *   - StrictMode-safe: a single `prev` ref, not a stack. The dev-mode
 *     unmount-then-remount cycle correctly recalls the trigger that
 *     was focused just before the cycle started.
 *
 * Pure / sync / side-effect-only. Returns the same handler object
 * shape on every render so consumers can attach it inline without
 * breaking memoization of the dialog element.
 */
export function useFocusTrap(
  containerRef: RefObject<HTMLElement | null>,
  isOpen: boolean,
): {
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
} {
  // Snapshot of the element focused just before the modal opened.
  // Single ref (not a stack) so React StrictMode's dev-mode
  // unmount/remount does not save the body twice.
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const container = containerRef.current;
    if (!container) return;

    // Capture the previously-focused element. We treat <body> as
    // "no prior focus" and skip capturing it so a stale restore
    // doesn't dump the user back to a blank viewport.
    const trigger = document.activeElement as HTMLElement | null;
    previouslyFocusedRef.current =
      trigger && trigger !== document.body ? trigger : null;

    // Initial focus moves focus to the first focusable inside.
    const focusables = getFocusableElements(container);
    if (focusables[0]) {
      focusables[0].focus();
    }

    return () => {
      // Restore focus on close. Check `isConnected` because the
      // trigger element might have been removed from the DOM while
      // the modal was open (e.g. an underlying row was deleted).
      //
      // If the trigger was detached, we can't return focus to it —
      // but we MUST still move focus off the modal so the user isn't
      // stranded on a still-keyboard-trapped descendant when the
      // modal disappears. Blurring the currently-focused element
      // falls focus back to the document body, which matches the
      // WAI-ARIA Modal Dialog "return focus to the trigger, else
      // body" contract.
      const prev = previouslyFocusedRef.current;
      previouslyFocusedRef.current = null;
      if (prev && prev.isConnected) {
        prev.focus();
      } else {
        // Fallback: blur the currently-focused element so focus
        // returns to body. Narrowed with `instanceof HTMLElement`
        // so the type system (not `typeof === 'function'`)
        // confirms `.blur()` exists on `current`.
        const current = document.activeElement;
        if (current instanceof HTMLElement) {
          current.blur();
        }
      }
    };
  }, [isOpen, containerRef]);

  // Closure-stable across renders so `onKeyDown={fn}` identity stays
  // constant for downstream memoization (the parent dialog backdrop
  // can safely be memoised). React hooks handle the dependency
  // tracking; we only read `containerRef.current` synchronously at
  // call time, not in a memoised capture.
  const onKeyDown = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== 'Tab') return;
    const container = containerRef.current;
    if (!container) return;

    const focusables = getFocusableElements(container);
    if (focusables.length === 0) {
      // Nothing focusable — swallow Tab so focus cannot leak.
      event.preventDefault();
      return;
    }
    if (focusables.length === 1) {
      // Single focusable — keep focus on it across Tab/Shift+Tab.
      event.preventDefault();
      focusables[0].focus();
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement as HTMLElement | null;

    // Forward Tab on the last element → wrap to first.
    if (!event.shiftKey && active === last) {
      event.preventDefault();
      first.focus();
      return;
    }
    // Shift+Tab on the first element → wrap to last.
    if (event.shiftKey && active === first) {
      event.preventDefault();
      last.focus();
      return;
    }
    // Focus escaped the modal (e.g. user clicked the address bar
    // and Tabbed back into the page). Snap back to the first
    // focusable.
    if (active && !container.contains(active)) {
      event.preventDefault();
      first.focus();
    }
  };

  return { onKeyDown };
}
