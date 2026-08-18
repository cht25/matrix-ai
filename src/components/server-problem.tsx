"use client";

// Honest failure surfaces. A backend that is missing/misbehaving renders
// "Server problem" (or "Authentication failed") with an optional [Retry] —
// never fake data, never raw stack traces, PGRST codes or secrets.

import { useRouter } from "next/navigation";
import type { ApiFailure } from "@/lib/api-errors";
import { Button } from "@/components/ui";
import { MatrixMark } from "@/components/logo";

const CONFIG_DETAIL =
  "MATRIX is not connected to its backend services yet. The administrator must set the Supabase environment variables (NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY) and redeploy before sign-in, chat and data can work.";

/** Inline card used inside flows (chat, scanner, forms). */
export function ServerProblem({
  failure,
  onRetry,
  onDismiss,
}: {
  failure: ApiFailure;
  onRetry?: () => void;
  onDismiss?: () => void;
}) {
  const router = useRouter();
  return (
    <div
      className="card fade-in mx-auto max-w-md !rounded-lg border-danger/40 bg-danger-soft !p-4 text-center"
      role="alert"
    >
      <p className="text-sm font-medium text-danger">{failure.title}.</p>
      <p className="mt-1 text-xs leading-relaxed text-ink-2">{failure.detail}</p>
      <div className="mt-3 flex justify-center gap-2">
        {failure.retryable ? (
          <Button
            variant="outline"
            onClick={onRetry ?? (() => router.refresh())}
            className="!min-h-8 !px-3 !py-1 text-xs"
          >
            Retry
          </Button>
        ) : null}
        {failure.action === "sign-in" ? (
          <Button variant="outline" onClick={() => router.push("/login")} className="!min-h-8 !px-3 !py-1 text-xs">
            Sign in
          </Button>
        ) : null}
        {onDismiss ? (
          <Button variant="ghost" onClick={onDismiss} className="!min-h-8 !px-3 !py-1 text-xs">
            Dismiss
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** Full-screen variant for when an entire section cannot work (e.g. the
 *  deployment has no Supabase configuration at all). `onRetry` overrides the
 *  default router.refresh() (error boundaries pass their reset function). */
export function ServerProblemScreen({ kind, onRetry }: { kind: "config" | "server"; onRetry?: () => void }) {
  const router = useRouter();
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
      <MatrixMark className="h-10 w-10 text-ink-2" />
      <p className="eyebrow mt-6">MATRIX</p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">
        Server problem
      </h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
        {kind === "config"
          ? CONFIG_DETAIL
          : "MATRIX could not reach its services right now. Please try again in a moment."}
      </p>
      <div className="mt-6 flex items-center gap-3">
        <Button variant="outline" onClick={onRetry ?? (() => router.refresh())}>
          Retry
        </Button>
        <Button variant="ghost" onClick={() => router.push("/docs")}>
          Documentation
        </Button>
      </div>
    </div>
  );
}
