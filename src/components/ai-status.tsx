"use client";

// Real AI service status. Polls the ai-gateway edge function's `health`
// action (which performs a live Groq reachability check). Never claims
// "Online" without a successful response — failures show "AI Unavailable"
// and clicking the indicator retries the check immediately.

import { useCallback, useEffect, useRef, useState } from "react";
import { firebaseBrowserConfigured } from "@/lib/firebase/client";
import { cn } from "@/lib/utils";

const POLL_MS = 45_000;
const CHECK_TIMEOUT_MS = 6_000;

type AiState = "checking" | "online" | "unavailable" | "not-configured";

const LABEL: Record<AiState, string> = {
  checking: "Checking…",
  online: "AI Online",
  unavailable: "AI Unavailable",
  "not-configured": "AI not configured",
};

export function AiStatus({ className }: { className?: string }) {
  const [state, setState] = useState<AiState>(firebaseBrowserConfigured ? "checking" : "not-configured");
  const inFlight = useRef(false);

  const check = useCallback(async () => {
    if (!firebaseBrowserConfigured) {
      setState("not-configured");
      return;
    }
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const res = await fetch("/api/ai", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health" }),
        signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      });
      const data = (await res.json().catch(() => ({}))) as { status?: string };
      setState(res.ok && data.status === "online" ? "online" : "unavailable");
    } catch {
      setState("unavailable");
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    void check();
    const interval = setInterval(() => void check(), POLL_MS);
    const onVisible = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [check]);

  return (
    <button
      type="button"
      onClick={() => void check()}
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
