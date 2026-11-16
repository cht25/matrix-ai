"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};
const getSnapshot = () => true;
const getServerSnapshot = () => false;

/**
 * Returns `false` during SSR and the initial client hydration render, then `true`
 * immediately after hydration commits. Use this to guard browser-only values
 * (local timezone/locale formatting, `Date.now()`, module caches, `window`,
 * `navigator`) so SSR HTML and initial client render match byte-for-byte.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
