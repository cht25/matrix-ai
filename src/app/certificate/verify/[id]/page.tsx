import type { Metadata } from "next";
import { db } from "@/lib/data";
import { verifyCertificateLookup } from "@/lib/server/rpc";
import { isCertificateIdShape, type PublicCertificate } from "@/lib/server/certificates";
import { MatrixMark, MatrixWordmark } from "@/components/logo";
import { CertificateDocument } from "@/components/certificate/certificate-document";
import { CertificateActions } from "@/components/certificate/certificate-actions";
import { ServerProblemScreen } from "@/components/server-problem";
import { isConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Certificate verification" };
export const dynamic = "force-dynamic";

export default async function CertificateVerifyPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isConfigured()) return <ServerProblemScreen kind="config" />;

  let result: PublicCertificate | null = null;
  if (isCertificateIdShape(id)) {
    result = await verifyCertificateLookup(db(), id).catch(() => null);
  }
  const valid = result?.valid === true;

  return (
    <div className="min-h-dvh">
      <header className="app-topbar sticky top-0 z-30">
        <div className="mx-auto flex h-14 max-w-4xl items-center justify-between px-4">
          <span className="flex items-center gap-2.5">
            <MatrixMark className="h-6 w-6 text-ink" />
            <MatrixWordmark className="h-3.5 w-14 text-ink" />
          </span>
          <span className="eyebrow">Certificate verification</span>
        </div>
      </header>

      <main className="mx-auto max-w-4xl px-4 py-8 sm:py-12">
        {valid && result ? (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2">
              <span className="chip border-success/40 bg-success-soft text-success">
                <span className="status-dot" data-state="ok" aria-hidden="true" /> Verified certificate
              </span>
              <span className="text-xs text-ink-3">
                Issued {new Date(result.issued_at).toLocaleDateString("en-GB", { year: "numeric", month: "long", day: "numeric" })}
              </span>
            </div>

            <CertificateDocument cert={result} />

            <div className="no-print">
              <CertificateActions cert={result} />
            </div>

            <p className="no-print text-center text-xs text-ink-3">
              Verification shows only public certificate information — never email, phone, date of
              birth, address or school details.
            </p>
          </div>
        ) : (
          <div className="card mx-auto max-w-md space-y-3 text-center">
            <MatrixMark className="mx-auto h-10 w-10 text-ink-3" />
            <h1 className="text-xl font-semibold text-ink">Certificate not found</h1>
            <p className="text-sm text-ink-2">
              No valid certificate matches this ID. Check the ID and try again — certificate IDs look
              like <span className="mono text-ink">MTRX-CERT-2026-000123</span>.
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
