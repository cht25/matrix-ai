import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { ReportForm } from "@/components/report-form";
import { Badge, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Report a Scam" };

export default async function ReportPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const [{ data: cats }, { data: resources }, { data: countries }] = await Promise.all([
    db.from("scam_categories").select("id, name").eq("status", "active").order("sort_order"),
    db.from("reporting_resources").select("organization, official_url, phone, description, country_id, last_verified").eq("status", "active").order("organization"),
    db.from("countries").select("id, name").order("name"),
  ]);

  const resourceList = (resources?.data ?? resources ?? []) as { organization: string; official_url: string; phone: string; description: string; country_id: string; last_verified: string }[];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">Report a Scam</h1>
        <p className="mt-1 text-ink-2">
          Three ways to report: a private <strong>platform report</strong> to MATRIX support, an
          <strong> official report</strong> to a verified government organisation, and a
          <strong> platform report</strong> inside the app where the scam happened. We never invent
          reporting websites.
        </p>
      </div>

      {/* Platform report */}
      <Card className="!p-6">
        <div className="flex items-center gap-2">
          <Badge className="border-accent/30 bg-accent-soft text-accent">Platform report</Badge>
          <span className="text-sm text-ink-3">Private — only you and the support team can see it</span>
        </div>
        <div className="mt-4">
          <ReportForm categories={(cats.data ?? []) as { id: string; name: string }[]} countries={(countries.data ?? []) as { id: string; name: string }[]} />
        </div>
      </Card>

      {/* Official resources */}
      {resourceList.length > 0 ? (
        <Card>
          <div className="flex items-center gap-2">
            <Badge className="border-success/30 bg-success-soft text-success">Official · Verified</Badge>
            <h2 className="font-bold text-ink">Reporting resources</h2>
          </div>
          <p className="mt-1 text-sm text-ink-3">Verified official organisations — use these for formal reports.</p>
          <div className="mt-3 space-y-2">
            {resourceList.map((r, i) => (
              <div key={i} className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm">
                <p className="font-semibold text-ink">
                  {r.organization} <span className="font-normal text-ink-3">({r.country_id})</span>
                </p>
                <p className="text-ink-2">{r.description}</p>
                <p className="mt-0.5">
                  <a href={r.official_url} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{r.official_url}</a>
                  {r.phone ? <span className="ml-2 text-ink-3">{r.phone}</span> : null}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-3 text-xs text-ink-3">
            Verified {resourceList.map((r) => r.last_verified?.slice(0, 10)).filter(Boolean)[0] ?? "recently"} by the MATRIX content team.
          </p>
        </Card>
      ) : null}

      <Card className="!p-4 text-sm text-ink-3">
        <strong className="text-ink-2">Tip:</strong> most apps (WhatsApp, Instagram, email) also have built-in
        report buttons — reporting the scam account there helps platforms take it down.
      </Card>
    </div>
  );
}
