import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { ReportForm } from "@/components/report-form";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Report a Scam" };

export default async function ReportPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [{ data: cats }, { data: resources }, { data: countries }] = await Promise.all([
    db.from("scam_categories").select("id, name").eq("status", "active").order("sort_order"),
    db.from("reporting_resources").select("organization, official_url, phone, description, country_id").eq("status", "active").order("organization"),
    db.from("countries").select("id, name").order("name"),
  ]);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Report a Scam</h1>
        <p className="mt-1 text-slate-500">
          Your report stays private (only you and the support team can see it) and helps us keep the scam
          library accurate. For official action, also report to the verified organisation for your country —
          we never invent those.
        </p>
      </div>

      <ReportForm categories={(cats.data ?? []) as { id: string; name: string }[]} countries={(countries.data ?? []) as { id: string; name: string }[]} />

      {(resources.data ?? []).length > 0 ? (
        <Card>
          <h2 className="font-bold text-slate-900">Official reporting resources</h2>
          <div className="mt-3 space-y-2">
            {(resources.data as { organization: string; official_url: string; phone: string; description: string; country_id: string }[]).map((r, i) => (
              <div key={i} className="rounded-xl bg-slate-50 px-3 py-2.5 text-sm">
                <p className="font-semibold text-slate-800">
                  {r.organization} <span className="font-normal text-slate-400">({r.country_id})</span>
                </p>
                <p className="text-slate-600">{r.description}</p>
                <p className="mt-0.5">
                  <a href={r.official_url} target="_blank" rel="noopener noreferrer" className="font-medium text-brand-600 hover:underline">{r.official_url}</a>
                  {r.phone ? <span className="ml-2 text-slate-500">{r.phone}</span> : null}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-slate-400">Last verified by the MATRIX AI content team. Only official, verified resources are listed.</p>
        </Card>
      ) : null}
    </div>
  );
}
