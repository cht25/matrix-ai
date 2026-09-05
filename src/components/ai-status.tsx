"use client";

// Real AI service status. Polls the AI gateway's `health` action (which
// performs a live reachability check against the configured OpenAI-compatible
// provider, or the environment fallback provider). Never claims "Online"
// without a successful response — failures show "AI Unavailable" and clicking
// the indicator retries the check immediately.

import { useCallback, useEffect, useState } from "react";
import { firebaseBrowserConfigured } from "@/lib/firebase/client";
import { cachedRequest, peekCache, subscribe } from "@/lib/client/cache";
import { cn } from "@/lib/utils";

const CACHE_KEY = "ai:health";
// The status pill can be mounted more than once (mobile top bar + sidebar).
// A shared cache means every copy is served by ONE request, and the poll only
// runs while the tab is visible.
const POLL_MS = 60_000;
const CHECK_TIMEOUT_MS = 6_000;

type AiState = "checking" | "online" | "unavailable" | "not-configured";

const LABEL: Record<AiState, string> = {
  checking: "Checking…",
  online: "AI Online",
  unavailable: "AI Unavailable",
  "not-configured": "AI not configured",
};

async function probe(): Promise<AiState> {
  try {
    const res = await fetch("/api/ai", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "health" }),
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    const data = (await res.json().catch(() => ({}))) as { status?: string };
    return res.ok && data.status === "online" ? "online" : "unavailable";
  } catch {
    return "unavailable";
  }
}

export function AiStatus({ className }: { className?: string }) {
  const [state, setState] = useState<AiState>(
    firebaseBrowserConfigured ? (peekCache<AiState>(CACHE_KEY) ?? "checking") : "not-configured",
  );

  const check = useCallback(async (force = false) => {
    if (!firebaseBrowserConfigured) {
      setState("not-configured");
      return;
    }
    setState(await cachedRequest(CACHE_KEY, probe, { ttlMs: POLL_MS, force }));
  }, []);

  useEffect(() => {
    if (!firebaseBrowserConfigured) return;
    // Keep every mounted pill in sync from the single shared request.
    const unsubscribe = subscribe<AiState>(CACHE_KEY, setState);
    void check();

    let interval = 0;
    const start = () => {
      if (!interval) interval = window.setInterval(() => void check(true), POLL_MS);
    };
    const stop = () => {
      if (interval) {
        window.clearInterval(interval);
        interval = 0;
      }
    };
    // Never poll a hidden tab — it wakes the device and wastes requests.
    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void check();
        start();
      } else {
        stop();
      }
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
      unsubscribe();
    };
  }, [check]);

  return (
    <button
      type="button"
      onClick={() => void check(true)}
      title={state === "unavailable" ? "The AI service is unavailable — press to retry the check" : `Service status: ${LABEL[state]}`}
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-[10.5px] font-medium uppercase tracking-[0.14em] transition-colors",
        state === "online" && "text-success",
        state === "unavailable" && "text-danger",
        state === "checking" && "text-ink-3",
        state === "not-configured" && "text-warning",
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          state === "online" && "bg-success",
          state === "unavailable" && "bg-danger",
          state === "checking" && "animate-pulse bg-ink-3",
          state === "not-configured" && "bg-warning",
        )}
      />
      {LABEL[state]}
    </button>
  );
}
