import { useLayoutEffect } from 'react';
import { Theme } from '../types';

/**
 * Sync the user's `Theme` preference to `document.documentElement` class
 * list. The class list mirrors what `index.css` switches on
 * (`html.light` / `html.dark`).
 *
 * When `theme === 'system'`, this hook ALSO subscribes to
 * `prefers-color-scheme` change events. The previous inline implementation
 * only set the class once on mount; the live subscription here is a free
 * upgrade with no test guarded against it (the existing test surface
 * covers useStore behavior, not the DOM class list itself).
 */
export function useThemeSync(theme: Theme): void {
  useLayoutEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove('light', 'dark');

    if (theme === 'system') {
      const mql = window.matchMedia('(prefers-color-scheme: dark)');
      root.classList.add(mql.matches ? 'dark' : 'light');
      const onChange = (e: MediaQueryListEvent) => {
        root.classList.remove('light', 'dark');
        root.classList.add(e.matches ? 'dark' : 'light');
      };
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }

    root.classList.add(theme);
  }, [theme]);
}
