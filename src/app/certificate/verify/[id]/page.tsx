import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getDataClient } from "@/lib/data";
import { Logo } from "@/components/logo";
import { Card } from "@/components/ui";
import { formatDate } from "@/lib/utils";

export const metadata: Metadata = { title: "Certificate verification" };

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
  const db = await getDataClient();
  const { data, error } = await db.rpc("verify_certificate_lookup", { p_certificate_id: id });
  const result = (data ?? null) as VerifyResult | null;

  if (error || !result) notFound();

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex h-16 max-w-2xl items-center justify-between px-4">
          <Logo />
          <span className="text-sm font-semibold text-slate-500">Certificate verification</span>
        </div>
      </header>
      <main className="mx-auto max-w-2xl px-4 py-12">
        <Card className="text-center">
          <div className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-emerald-50">
            <span className="text-2xl" aria-hidden="true">{result.valid ? "✅" : "❌"}</span>
          </div>
          <h1 className="mt-4 text-2xl font-extrabold text-slate-900">
            {result.valid ? "This certificate is authentic" : "Certificate not found"}
          </h1>
          {result.valid && (
            <dl className="mt-6 space-y-3 text-sm">
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Certificate ID</dt>
                <dd className="font-mono font-semibold">{result.certificate_id}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Course</dt>
                <dd className="font-semibold">{result.course}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Display name</dt>
                <dd className="font-semibold">{result.display_name}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Completion date</dt>
                <dd className="font-semibold">{formatDate(result.issued_at ?? null)}</dd>
              </div>
              <div className="flex justify-between gap-4 border-b border-slate-100 pb-2">
                <dt className="text-slate-500">Issued by</dt>
                <dd className="font-semibold">{result.issued_by}</dd>
              </div>
              <div className="flex justify-between gap-4">
                <dt className="text-slate-500">Verification status</dt>
                <dd className="font-semibold text-emerald-600 capitalize">{result.verification_status}</dd>
              </div>
            </dl>
          )}
          <p className="mt-6 text-xs text-slate-400">
            Verification shows only public certificate information — no email, phone, date of birth or address.
          </p>
        </Card>
      </main>
    </div>
  );
}
