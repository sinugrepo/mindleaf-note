import { useCallback, useEffect, useState } from 'react';

export interface UseResizablePanelOptions {
  initialWidth: number;
  minWidth: number;
  maxWidth: number;
}

export interface UseResizablePanelResult {
  width: number;
  isResizing: boolean;
  /** Attach this to the resize-handle element's `onMouseDown`. */
  startResize: (e: React.MouseEvent) => void;
}

/**
 * Drive a horizontal resizable panel (e.g. the sidebar splitter).
 *
 * Width updates are clamped to `[minWidth, maxWidth]` so consumers don't
 * have to clamp on their end. `isResizing` is true between the
 * `mousedown` on the handle and the next `mouseup` on window, which
 * lets consumers apply cursor / select-none affordances.
 *
 * Listeners are attached to `window` (not the handle element) so that
 * dragging fast off the handle still moves the panel — same behavior as
 * the inline `Layout.tsx` implementation.
 */
export function useResizablePanel({
  initialWidth,
  minWidth,
  maxWidth,
}: UseResizablePanelOptions): UseResizablePanelResult {
  const [width, setWidth] = useState<number>(initialWidth);
  const [isResizing, setIsResizing] = useState<boolean>(false);

  const stopResize = useCallback(() => setIsResizing(false), []);

  useEffect(() => {
    if (!isResizing) return;
    const onMove = (e: MouseEvent) => {
      const candidate = e.clientX;
      if (candidate >= minWidth && candidate <= maxWidth) {
        setWidth(candidate);
      }
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', stopResize);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', stopResize);
    };
  }, [isResizing, minWidth, maxWidth, stopResize]);

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  return { width, isResizing, startResize };
}
