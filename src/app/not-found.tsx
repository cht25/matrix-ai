import Link from "next/link";
import { MatrixMark } from "@/components/logo";

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
      <MatrixMark className="h-10 w-10 text-ink-2" aria-hidden="true" />
      <p className="eyebrow mt-6">MATRIX</p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">Page not found</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
        The page you are looking for does not exist or was moved.
      </p>
      <Link
        href="/"
        className="mt-6 rounded-lg border border-border px-4 py-2 text-sm font-medium text-ink-2 transition-colors hover:border-border-strong hover:text-ink"
      >
        Back to MATRIX
      </Link>
    </div>
  );
}
