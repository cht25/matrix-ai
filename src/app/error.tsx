"use client";

import { useEffect } from "react";
import { ServerProblemScreen } from "@/components/server-problem";

export default function RootError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    if ((error as { code?: string }).code !== "SUPABASE_NOT_CONFIGURED") {
      console.error("[MATRIX] Root error boundary caught an error.", error);
    }
  }, [error]);

  return <ServerProblemScreen kind={(error as { code?: string }).code === "SUPABASE_NOT_CONFIGURED" ? "config" : "server"} onRetry={reset} />;
}
