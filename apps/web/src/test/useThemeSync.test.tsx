import React from 'react';
import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useThemeSync } from '../hooks/useThemeSync';
import type { Theme } from '../types';

function ThemeHarness({ theme }: { theme: Theme }) {
  useThemeSync(theme);
  return null;
}

type MediaListener = (event: MediaQueryListEvent) => void;

function installMatchMedia(initialMatches: boolean) {
  let matches = initialMatches;
  const listeners = new Set<MediaListener>();
  const media = {
    get matches() {
      return matches;
    },
    media: '(prefers-color-scheme: dark)',
    onchange: null,
    addEventListener: (_type: string, listener: MediaListener) => listeners.add(listener),
    removeEventListener: (_type: string, listener: MediaListener) => listeners.delete(listener),
    addListener: (listener: MediaListener) => listeners.add(listener),
    removeListener: (listener: MediaListener) => listeners.delete(listener),
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;

  vi.stubGlobal('matchMedia', vi.fn(() => media));
  return {
    setMatches(next: boolean) {
      matches = next;
      const event = { matches: next, media: media.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

describe('useThemeSync', () => {
  beforeEach(() => {
    document.documentElement.classList.remove('light', 'dark');
    vi.unstubAllGlobals();
  });

  it('applies explicit light and dark preferences', () => {
    installMatchMedia(true);
    const { rerender } = render(<ThemeHarness theme="light" />);
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');

    rerender(<ThemeHarness theme="dark" />);
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });

  it('follows system preference changes while in system mode', () => {
    const system = installMatchMedia(true);
    const { rerender } = render(<ThemeHarness theme="system" />);
    expect(document.documentElement).toHaveClass('dark');

    act(() => system.setMatches(false));
    expect(document.documentElement).toHaveClass('light');
    expect(document.documentElement).not.toHaveClass('dark');

    rerender(<ThemeHarness theme="dark" />);
    expect(document.documentElement).toHaveClass('dark');

    act(() => system.setMatches(false));
    expect(document.documentElement).toHaveClass('dark');
    expect(document.documentElement).not.toHaveClass('light');
  });
});
