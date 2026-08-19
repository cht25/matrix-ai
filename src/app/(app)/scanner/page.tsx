import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getScannerData } from "@/lib/server/queries";
import { ScannerClient } from "@/components/scanner-client";
import { Card } from "@/components/ui";
import { riskColor } from "@/lib/utils";

export const metadata: Metadata = { title: "Screenshot Scanner" };

export default async function ScannerPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const list = await getScannerData(db(), user.uid);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Screenshot Scanner</h1>
        <p className="mt-1 text-ink-2">
          Analyse a suspicious screenshot — SMS, email, login page, payment request. MATRIX tells you the
          risk level, what to do, and how to report it. Calmly.
        </p>
      </div>

      <ScannerClient />

      {list.length > 0 ? (
        <div className="space-y-2.5">
          <h2 className="font-bold text-ink">Previous scans</h2>
          {list.map((a) => (
            <Card key={a.id} className="!p-4">
              <div className="flex items-center justify-between gap-3">
                <span className={`rounded-md border px-2.5 py-0.5 text-xs font-medium capitalize ${riskColor(a.risk_level)}`}>
                  {a.risk_level} risk
                </span>
                <span className="text-xs text-ink-3">{Math.round(a.confidence * 100)}% confidence</span>
              </div>
              <p className="mt-2 line-clamp-2 text-sm text-ink-2">{a.recommendation}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
