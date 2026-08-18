"use client";

// Route-group error boundary. Any unexpected server/database failure renders
// a professional "Server problem" with [Retry] — never a stack trace,
// never a raw database error, never fabricated data.

import { useEffect } from "react";
import { ServerProblemScreen } from "@/components/server-problem";

export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    // Full detail stays in server/client logs only. A missing backend
    // configuration is expected on misconfigured deployments — the config
    // warning is already logged once at startup; don't spam per request.
    if ((error as { code?: string }).code !== "SUPABASE_NOT_CONFIGURED") {
      console.error("[MATRIX] Route error boundary caught an error.", error);
    }
  }, [error]);

  return (
    <div className="min-h-[100dvh]">
      <ServerProblemScreen kind={(error as { code?: string }).code === "SUPABASE_NOT_CONFIGURED" ? "config" : "server"} onRetry={reset} />
    </div>
  );
}
