import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getScamsData } from "@/lib/server/queries";
import { ScamBrowser } from "@/components/scam-browser";

export const metadata: Metadata = { title: "Scam Library" };

export default async function ScamsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  const { categories: cats, articles } = await getScamsData(db());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Scam Library</h1>
        <p className="mt-1 text-ink-2">
          Learn the patterns scammers use so you can spot them before they work. Every article is verified
          and sourced from trusted organisations.
        </p>
      </div>
      <ScamBrowser
        categories={cats}
        articles={articles}
      />
    </div>
  );
}
