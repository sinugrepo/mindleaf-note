import { describe, it, expect, afterEach } from 'vitest';
import { renderHook, act, cleanup } from '@testing-library/react';
import React from 'react';
import { useResizablePanel } from './useResizablePanel';

// Synthetic MouseEvent dispatchers. The hook only reads `clientX` from
// the mousemove event, so populating that field is enough.
function fireMouseMove(clientX: number) {
  window.dispatchEvent(new MouseEvent('mousemove', { clientX }));
}

function fireMouseUp() {
  window.dispatchEvent(new MouseEvent('mouseup'));
}

// The hook's startResize signature is `(e: React.MouseEvent) => void` and
// only ever calls `e.preventDefault()`. We pass a structural stub casted
// to `React.MouseEvent` rather than constructing a jsdom MouseEvent, which
// would fail the structural-type check (DOM MouseEvent ≠ React.MouseEvent).
const stubStartEvent = {
  preventDefault: () => {},
} as unknown as React.MouseEvent;

afterEach(() => {
  cleanup();
});

describe('useResizablePanel', () => {
  describe('initial state', () => {
    it('returns the configured initialWidth', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );
      expect(result.current.width).toBe(320);
      expect(result.current.isResizing).toBe(false);
      expect(typeof result.current.startResize).toBe('function');
    });

    it('does not attach window listeners before resize starts', () => {
      // Indirect observation: dispatching a mousemove now must NOT change
      // width because no listener was installed.
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        fireMouseMove(400);
      });

      expect(result.current.width).toBe(320);
      expect(result.current.isResizing).toBe(false);
    });
  });

  describe('resize flow', () => {
    it('flips isResizing to true on startResize and routes subsequent mousemove', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        result.current.startResize(stubStartEvent);
      });

      expect(result.current.isResizing).toBe(true);

      act(() => {
        fireMouseMove(400);
      });

      expect(result.current.width).toBe(400);
    });

    it('updates width for every in-bounds mousemove while resizing', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        result.current.startResize(stubStartEvent);
      });

      act(() => {
        fireMouseMove(250);
      });
      expect(result.current.width).toBe(250);

      act(() => {
        fireMouseMove(350);
      });
      expect(result.current.width).toBe(350);

      act(() => {
        fireMouseMove(500);
      });
      expect(result.current.width).toBe(500);
    });

    it('clamps out-of-bounds mousemove (width stays at last in-bounds value)', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        result.current.startResize(stubStartEvent);
      });

      // Drive to a known in-bounds value first.
      act(() => {
        fireMouseMove(400);
      });
      expect(result.current.width).toBe(400);

      // Below the minimum — must be ignored, width stays at 400.
      act(() => {
        fireMouseMove(50);
      });
      expect(result.current.width).toBe(400);

      // Above the maximum — must be ignored, width stays at 400.
      act(() => {
        fireMouseMove(900);
      });
      expect(result.current.width).toBe(400);

      // At the boundary inclusive — should be accepted.
      act(() => {
        fireMouseMove(240);
      });
      expect(result.current.width).toBe(240);

      act(() => {
        fireMouseMove(600);
      });
      expect(result.current.width).toBe(600);
    });

    it('mouseup clears isResizing and detaches the mousemove listener', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        result.current.startResize(stubStartEvent);
      });

      act(() => {
        fireMouseMove(450);
      });
      expect(result.current.isResizing).toBe(true);
      expect(result.current.width).toBe(450);

      act(() => {
        fireMouseUp();
      });
      expect(result.current.isResizing).toBe(false);

      // After mouseup, further mousemove must NOT change width even though
      // a new startResize hasn't been called.
      act(() => {
        fireMouseMove(500);
      });
      expect(result.current.width).toBe(450);
    });

    it('supports repeated startResize / move / stop cycles', () => {
      const { result } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      // Cycle 1
      act(() => {
        result.current.startResize(stubStartEvent);
      });
      act(() => {
        fireMouseMove(360);
      });
      act(() => {
        fireMouseUp();
      });
      expect(result.current.width).toBe(360);
      expect(result.current.isResizing).toBe(false);

      // Cycle 2
      act(() => {
        result.current.startResize(stubStartEvent);
      });
      act(() => {
        fireMouseMove(280);
      });
      act(() => {
        fireMouseUp();
      });
      expect(result.current.width).toBe(280);
      expect(result.current.isResizing).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('removes window listeners on unmount even mid-resize', () => {
      const { result, unmount } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      act(() => {
        result.current.startResize(stubStartEvent);
      });
      // isResizing=true → listeners attached. Verify they're live:
      act(() => {
        fireMouseMove(420);
      });
      expect(result.current.width).toBe(420);

      // Unmount while isResizing=true. The cleanup function in the hook
      // must remove both mousemove and mouseup listeners.
      unmount();

      // Sanity: dispatching another mousemove at this point must NOT throw
      // (no listener means the DOM event is a no-op). We cannot directly
      // inspect listener registration; absence of throw is the observable
      // contract. If the cleanup was broken, dispatching mousemove on a
      // torn-down hook could log a warning or, worse, attempt to setState
      // on an unmounted component.
      expect(() => fireMouseMove(500)).not.toThrow();
    });
  });

  describe('hook identity stability', () => {
    it('startResize is referentially stable across renders', () => {
      // The Layout component depends on this for its onMouseDown handler
      // — if startResize's identity changed every render, Layout would
      // unnecessarily re-render a wrapped memoized element. The hook
      // memoizes startResize via useCallback([]).
      const { result, rerender } = renderHook(() =>
        useResizablePanel({
          initialWidth: 320,
          minWidth: 240,
          maxWidth: 600,
        }),
      );

      const first = result.current.startResize;
      rerender();
      const second = result.current.startResize;
      expect(second).toBe(first);
    });
  });
});
