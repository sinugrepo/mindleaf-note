import { useEffect, useState } from 'react';

/**
 * Subscribe to a CSS media query.
 *
 * Returns `false` synchronously on the server / before first effect, and the
 * actual match status once the effect mounts. Subscribes to changes via
 * `MediaQueryList.addEventListener('change', ...)` (the modern listener API,
 * not the deprecated `addListener`).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(false);

  useEffect(() => {
    const mql = window.matchMedia(query);
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
