"use client";

// Resumes an OAuth *link* operation after the full-page redirect returns.
//
// Google sign-in and linking both use `signInWithRedirect`/`linkWithRedirect`,
// so the browser leaves the site and comes back to the URL it started from
// (usually /settings). This component is mounted once by the app shell: when a
// link was in flight it consumes the redirect result — the same memoised
// promise the auth screens use, so the result can never be drained twice —
// records a one-shot notice for Settings, and reloads so the newly linked
// provider is visible.
//
// It is deliberately inert otherwise (no storage marker → no Firebase call), so
// it costs nothing on ordinary page loads and cannot interfere with the login
// screen's own handling.

import { useEffect } from "react";
import { consumeOAuthRedirect, pendingLinkProvider, setOAuthNotice } from "@/lib/auth/oauth";

export function AuthRedirectWatcher() {
  useEffect(() => {
    if (!pendingLinkProvider()) return;
    let cancelled = false;
    void (async () => {
      const result = await consumeOAuthRedirect();
      if (cancelled || !result) return;
      if (result.status === "ok" && result.operation === "link") {
        setOAuthNotice("Linked. You can now use this provider to sign in.", "success");
        window.location.reload();
        return;
      }
      if (result.status === "error") {
        setOAuthNotice(result.message, "danger");
        window.location.reload();
        return;
      }
      if (result.status === "session-failed") {
        setOAuthNotice(result.message, "danger");
        window.location.reload();
      }
      // "cancelled" needs no notice: the user already knows.
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return null;
}
