import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDataClient } from "@/lib/data";
import { MatrixMark, MatrixWordmark } from "@/components/logo";
import { ServerProblemScreen } from "@/components/server-problem";
import { isConfigured } from "@/lib/env";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Certificate verification" };
export const dynamic = "force-dynamic";

type VerifyResult = {
  valid?: boolean;
  certificate_id?: string;
  course?: string;
  display_name?: string;
  issued_at?: string;
  issued_by?: string;
  verification_status?: string;
};

export default async function CertificateVerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isConfigured()) {
    return <ServerProblemScreen kind="config" />;
  }
  const db = await getDataClient();
  const { data, error } = await db.rpc("verify_certificate_lookup", { p_certificate_id: id });
  const result = (data ?? null) as VerifyResult | null;

  if (error || !result) notFound();

  return (
    <div className="min-h-dvh">
      <header className="border-b border-border bg-surface/85 backdrop-blur-xl">
        <div className="mx-auto flex h-14 max-w-2xl items-center justify-between px-4">
          <span className="flex items-center gap-2.5">
            <MatrixMark className="h-6 w-6 text-ink" />
            <MatrixWordmark className="h-3.5 w-14 text-ink" />
          </span>
          <span className="eyebrow">Certificate verification</span>
        </div>
      </header>

      <main className="mx-auto max-w-2xl px-4 py-12">
        {/* The certificate */}
        <div className="relative overflow-hidden rounded-lg border border-border-strong bg-surface p-8 shadow-[var(--shadow-card)] sm:p-12">
          {/* Geometric corner accents */}
          <div className="pointer-events-none absolute inset-3 rounded border border-border" aria-hidden="true" />
          <div className="pointer-events-none absolute left-8 top-8 h-10 w-10 border-l border-t border-ink/40" aria-hidden="true" />
          <div className="pointer-events-none absolute right-8 top-8 h-10 w-10 border-r border-t border-ink/40" aria-hidden="true" />
          <div className="pointer-events-none absolute bottom-8 left-8 h-10 w-10 border-b border-l border-ink/40" aria-hidden="true" />
          <div className="pointer-events-none absolute bottom-8 right-8 h-10 w-10 border-b border-r border-ink/40" aria-hidden="true" />

          <div className="relative flex flex-col items-center pt-4 text-center">
            <p className="eyebrow mb-6">Cyber Safety Certification</p>
            <MatrixWordmark className="mb-8 h-8 w-52 text-ink" />

            {result.valid ? (
              <>
                <p className="mb-1 text-[11px] uppercase tracking-[0.24em] text-ink-3">This certifies that</p>
                <h1 className="font-display text-3xl font-medium tracking-tight text-ink sm:text-4xl">
                  {result.display_name}
                </h1>
                <p className="mt-3 max-w-sm text-[13px] leading-relaxed text-ink-2">
                  has successfully completed the course
                </p>
                <p className="mt-1 font-display text-lg font-semibold text-ink">{result.course}</p>
                <div className="my-8 h-px w-40 bg-border" />
                <dl className="grid grid-cols-2 gap-x-10 gap-y-4 text-left text-[13px] sm:grid-cols-4">
                  <div>
                    <dt className="text-[10px] uppercase tracking-widest text-ink-3">Certificate</dt>
                    <dd className="mt-1 font-mono text-[11px] text-ink-2">{result.certificate_id}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-widest text-ink-3">Date</dt>
                    <dd className="mt-1 text-ink-2">{formatDate(result.issued_at ?? null)}</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-widest text-ink-3">Issued by</dt>
                    <dd className="mt-1 text-ink-2">MATRIX · White Hat Team</dd>
                  </div>
                  <div>
                    <dt className="text-[10px] uppercase tracking-widest text-ink-3">Status</dt>
                    <dd className="mt-1 capitalize text-ink">{result.verification_status}</dd>
                  </div>
                </dl>
              </>
            ) : (
              <>
                <MatrixMark className="mb-4 h-10 w-10 text-ink-3" />
                <h1 className="font-display text-2xl font-medium text-ink">Certificate not found</h1>
                <p className="mt-2 max-w-sm text-sm text-ink-2">
                  No certificate matches this ID. Check the ID and try again.
                </p>
              </>
            )}

            <p className="mt-10 text-[10px] uppercase tracking-[0.2em] text-ink-3">
              {result.issued_by ?? "MATRIX — THAMJJ13.TOP White Hat Team"}
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-ink-3">
          Verification shows only public certificate information — never email, phone, date of birth or address.
        </p>
      </main>
    </div>
  );
}
