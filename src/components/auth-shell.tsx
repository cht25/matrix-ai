import Link from "next/link";
import { Logo } from "@/components/logo";

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-4 py-12">
      <div className="mb-6"><Logo size="lg" /></div>
      <div className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-8 shadow-sm">
        <h1 className="text-2xl font-bold text-slate-900">{title}</h1>
        {subtitle ? <p className="mt-1.5 text-sm text-slate-500">{subtitle}</p> : null}
        <div className="mt-6">{children}</div>
      </div>
      <p className="mt-6 text-center text-xs text-slate-500">
        MATRIX AI is for users aged 11–17 · Operated by THAMJJ13.TOP White Hat Team
      </p>
    </div>
  );
}

export function OAuthButtons({ onGoogle, onFacebook }: { onGoogle: () => void; onFacebook: () => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <button
        type="button"
        onClick={onGoogle}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1Z" />
          <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23Z" />
          <path fill="#FBBC05" d="M5.84 14.1a6.6 6.6 0 0 1 0-4.2V7.06H2.18a11 11 0 0 0 0 9.88l3.66-2.84Z" />
          <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15A11 11 0 0 0 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52Z" />
        </svg>
        Google
      </button>
      <button
        type="button"
        onClick={onFacebook}
        className="inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-700 transition-colors hover:bg-slate-50"
      >
        <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden="true">
          <path fill="#1877F2" d="M24 12a12 12 0 1 0-13.88 11.85v-8.38H7.08V12h3.04V9.36c0-3 1.79-4.67 4.53-4.67 1.31 0 2.69.24 2.69.24v2.95h-1.52c-1.49 0-1.96.92-1.96 1.87V12h3.33l-.53 3.47h-2.8v8.38A12 12 0 0 0 24 12Z" />
        </svg>
        Facebook
      </button>
    </div>
  );
}

export function AuthDivider() {
  return (
    <div className="my-5 flex items-center gap-3 text-xs font-medium uppercase tracking-wide text-slate-400" aria-hidden="true">
      <span className="h-px flex-1 bg-slate-200" /> or <span className="h-px flex-1 bg-slate-200" />
    </div>
  );
}

export function AuthFooterLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <p className="mt-5 text-center text-sm text-slate-500">
      <Link href={href} className="font-semibold text-brand-600 hover:text-brand-700">{children}</Link>
    </p>
  );
}
