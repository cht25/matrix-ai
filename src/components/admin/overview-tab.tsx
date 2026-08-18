import { getDataClient } from "@/lib/data";
import { Card } from "@/components/ui";

export async function OverviewTab({ codes }: { codes: Set<string> }) {
  const db = await getDataClient();

  const [users, reports, pendingVerification, pendingConsents, safetyEvents] = await Promise.all([
    codes.has("users.view") ? db.rpc("admin_list_users") : Promise.resolve({ data: null, error: null }),
    codes.has("reports.view") ? db.from("scam_reports").select("id, status").eq("status", "submitted") : Promise.resolve({ data: null, error: null }),
    codes.has("verification.review") ? db.from("identity_verifications").select("id").eq("verification_status", "pending_review") : Promise.resolve({ data: null, error: null }),
    codes.has("consent.review") ? db.from("guardian_consents").select("id").eq("status", "pending") : Promise.resolve({ data: null, error: null }),
    codes.has("ai.view") ? db.from("ai_safety_events").select("id").order("created_at", { ascending: false }).limit(50) : Promise.resolve({ data: null, error: null }),
  ]);

  const stats = [
    { label: "Registered users", value: (users?.data ?? []).length, visible: codes.has("users.view") },
    { label: "New scam reports", value: (reports?.data ?? []).length, visible: codes.has("reports.view") },
    { label: "Pending age verifications", value: (pendingVerification?.data ?? []).length, visible: codes.has("verification.review") },
    { label: "Pending consents", value: (pendingConsents?.data ?? []).length, visible: codes.has("consent.review") },
    { label: "AI safety events (last 50)", value: (safetyEvents?.data ?? []).length, visible: codes.has("ai.view") },
  ];

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {stats.filter((s) => s.visible).map((s) => (
        <Card key={s.label}>
          <p className="text-sm font-medium text-slate-500">{s.label}</p>
          <p className="mt-2 text-3xl font-extrabold text-slate-900">{s.value}</p>
        </Card>
      ))}
      {!stats.some((s) => s.visible) ? (
        <Card><p className="text-sm text-slate-500">Your role has no overview permissions. Ask a super admin for the appropriate role.</p></Card>
      ) : null}
      <Card>
        <p className="text-sm font-medium text-slate-500">Your permissions</p>
        <div className="mt-2 flex flex-wrap gap-1.5">
          {[...codes].map((c) => (
            <span key={c} className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs text-slate-600">{c}</span>
          ))}
        </div>
      </Card>
    </div>
  );
}
