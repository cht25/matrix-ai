"use client";

import { useEffect, useState } from "react";

/**
 * SSR-safe media query hook. The first render always reports `false` (matching
 * the server) and then syncs with the browser, so contextual layouts switch by
 * real conditional rendering rather than by hiding markup with CSS.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(false);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener("change", update);
    return () => list.removeEventListener("change", update);
  }, [query]);

  return matches;
}

/** Narrow viewport — contextual actions collapse into the More menu. */
export function useIsCompact(): boolean {
  return useMediaQuery("(max-width: 640px)");
}
