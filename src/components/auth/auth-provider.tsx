"use client";

// React binding for the centralised auth lifecycle (src/lib/auth/lifecycle.ts).
//
// Mounted once by the ROOT layout, so getRedirectResult() and Firebase's
// initial auth state are processed at application startup — on every page, not
// only when an auth screen happens to render. Screens read the explicit
// states (INITIALIZING / UNAUTHENTICATED / PROFILE_LOADING / READY / ERROR)
// and never guess: an uninitialized state is shown as "wait", never as
// "logged out".

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  authGuardDecision,
  getAuthLifecycleState,
  retryAuthLifecycle,
  startAuthLifecycle,
  subscribeAuthLifecycle,
  type AuthLifecycleState,
} from "@/lib/auth/lifecycle";

type AuthLifecycleContextValue = AuthLifecycleState & {
  /** What an auth page should do right now (wait/navigate/form/error). */
  decision: ReturnType<typeof authGuardDecision>;
  /** Re-run the failed stage. Safe to call repeatedly. */
  retry: () => void;
};

const AuthLifecycleContext = createContext<AuthLifecycleContextValue | null>(null);

export function AuthLifecycleProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthLifecycleState>(getAuthLifecycleState);

  useEffect(() => {
    const unsubscribe = subscribeAuthLifecycle(setState);
    // Kick off the once-per-page-load sequence (idempotent, memoised).
    void startAuthLifecycle();
    return unsubscribe;
  }, []);

  const retry = useCallback(() => {
    void retryAuthLifecycle();
  }, []);

  const value = useMemo<AuthLifecycleContextValue>(
    () => ({ ...state, decision: authGuardDecision(state.status), retry }),
    [state, retry],
  );

  return <AuthLifecycleContext.Provider value={value}>{children}</AuthLifecycleContext.Provider>;
}

export function useAuthLifecycle(): AuthLifecycleContextValue {
  const value = useContext(AuthLifecycleContext);
  if (!value) {
    // A screen rendered outside the root layout would otherwise crash on
    // destructure; the default keeps it functional (always "wait") instead.
    return {
      ...getAuthLifecycleState(),
      decision: "wait",
      retry: () => void startAuthLifecycle(),
    };
  }
  return value;
}
