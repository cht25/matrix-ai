import Link from "next/link";
import { QorvynaMark, QorvynaWordmark } from "@/components/logo";
import { BRAND } from "@/lib/brand";

export default function NotFound() {
  return (
    <div className="flex min-h-[100dvh] flex-col items-center justify-center px-6 text-center">
      <QorvynaMark className="h-16 w-16" />
      <QorvynaWordmark className="mt-5 h-3.5 w-auto text-ink" title={BRAND.name} />
      <p className="eyebrow mt-8">Error 404</p>
      <h1 className="mt-2 font-display text-2xl font-semibold tracking-tight text-ink">Page not found</h1>
      <p className="mx-auto mt-3 max-w-md text-sm leading-relaxed text-ink-2">
        The page you are looking for does not exist or was moved.
      </p>
      <Link href="/" className="btn btn-primary mt-6">
        Back to {BRAND.name}
      </Link>
    </div>
  );
}
