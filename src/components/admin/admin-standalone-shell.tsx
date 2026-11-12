import Link from "next/link";
import { ArrowLeft, Shield } from "lucide-react";
import { Logo } from "@/components/logo";
import { ThemeToggle } from "@/lib/theme";

/** Dedicated admin frame, intentionally separate from the chat/sidebar shell. */
export function AdminStandaloneShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen text-ink">
      <header className="sticky top-0 z-30 border-b border-border bg-surface/95 backdrop-blur">
        <div className="mx-auto flex min-h-16 max-w-[1600px] items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
          <div className="flex min-w-0 items-center gap-4">
            <Logo href="/admin" size="sm" />
            <div className="hidden border-l border-border pl-4 sm:block">
              <p className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.18em] text-accent">
                <Shield aria-hidden className="h-3.5 w-3.5" /> Admin console
              </p>
              <p className="text-xs text-ink-3">Platform operations & configuration</p>
            </div>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ThemeToggle compact />
            <Link href="/chat" className="btn btn-outline inline-flex min-h-11 items-center gap-2 px-3 text-sm">
              <ArrowLeft aria-hidden className="h-4 w-4" />
              <span className="hidden sm:inline">Back to MATRIX</span>
              <span className="sm:hidden">App</span>
            </Link>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-[1600px] space-y-5 px-4 py-5 sm:px-6 sm:py-7 lg:px-8">
        {children}
      </div>
    </div>
  );
}
