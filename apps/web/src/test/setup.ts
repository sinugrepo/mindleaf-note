import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

// ---------------------------------------------------------------------------
// jsdom DOM polyfills required by ProseMirror (TipTap's editor engine).
//
// jsdom does not implement a few DOM APIs that ProseMirror relies on for
// cursor / focus / range geometry. Without these polyfills, mounting the
// real <Editor /> in tests throws uncaught TypeErrors:
//   * TypeError: document.elementFromPoint is not a function
//   * TypeError: target.getClientRects is not a function
//   * TypeError: HTMLElement.scrollIntoView is not a function
// These usually surface as 4 uncaught exceptions that tear down the test
// file rather than fail an individual assertion.
// ---------------------------------------------------------------------------
if (typeof document !== 'undefined' && typeof document.elementFromPoint !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (document as any).elementFromPoint = () => null;
}

if (typeof Range !== 'undefined' && typeof Range.prototype.getClientRects !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Range.prototype as any).getClientRects = function getClientRects(this: Range) {
    // Empty rectlist: jsdom has no layout, so we tell ProseMirror "nothing here".
    const empty = {
      length: 0,
      item: () => null,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [Symbol.iterator]: function* (this: any) {
        // intentionally empty: yields no DOMRects.
      },
    };
    return empty as unknown as DOMRectList;
  };
}

if (typeof Range !== 'undefined' && typeof Range.prototype.getBoundingClientRect !== 'function') {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (Range.prototype as any).getBoundingClientRect = function getBoundingClientRect(this: Range) {
    // Empty bounding rect: jsdom has no layout. Returning zeros is enough to
    // satisfy ProseMirror's `coordsAtPos` / `scrollToSelection` code paths
    // without throwing. NOTE: lie to ProseMirror is intentional and harmless
    // for editor-update flow tests; do NOT add cursor/decoration assertions
    // in tests that rely on this polyfill — they would pass false-positives.
    const emptyRect: DOMRect = {
      x: 0,
      y: 0,
      width: 0,
      height: 0,
      top: 0,
      right: 0,
      bottom: 0,
      left: 0,
      toJSON() {
        return {};
      },
    } as DOMRect;
    return emptyRect;
  };
}

if (typeof window !== 'undefined' && typeof window.HTMLElement !== 'undefined') {
  const proto = window.HTMLElement.prototype as unknown as {
    scrollIntoView?: () => void;
  };
  if (typeof proto.scrollIntoView !== 'function') {
    proto.scrollIntoView = () => {
      // no-op; jsdom has no scroll container to scroll into.
    };
  }
}
