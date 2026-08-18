import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { ScannerClient } from "@/components/scanner-client";
import { Card } from "@/components/ui";
import { riskColor } from "@/lib/utils";

export const metadata: Metadata = { title: "Screenshot Scanner" };

export default async function ScannerPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const { data: analyses } = await db
    .from("security_analyses")
    .select("id, risk_level, confidence, recommendation, created_at")
    .eq("user_id", user!.id)
    .order("created_at", { ascending: false })
    .limit(10);

  const list = (analyses ?? []) as { id: string; risk_level: string; confidence: number; recommendation: string; created_at: string }[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Screenshot Scanner</h1>
        <p className="mt-1 text-slate-500">
          Upload a suspicious message, login page or app screen. The AI checks it and tells you what to do —
          calmly. Files go to a private bucket and are never shared.
        </p>
      </div>

      <ScannerClient />

      {list.length > 0 ? (
        <div className="space-y-2.5">
          <h2 className="font-bold text-slate-900">Previous scans</h2>
          {list.map((a) => (
            <Card key={a.id} className="!p-4">
              <div className="flex items-center justify-between gap-3">
                <span className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold capitalize ${riskColor(a.risk_level)}`}>
                  {a.risk_level} risk
                </span>
                <span className="text-xs text-slate-400">{Math.round(a.confidence * 100)}% confidence</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-slate-600">{a.recommendation}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
