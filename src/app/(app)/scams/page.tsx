import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getDataClient, getCurrentUser } from "@/lib/data";
import { ScamBrowser } from "@/components/scam-browser";

export const metadata: Metadata = { title: "Scam Library" };

export default async function ScamsPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  if (!user) redirect("/login");

  const [cats, articles] = await Promise.all([
    db.from("scam_categories").select("id, slug, name, description, icon").eq("status", "active").order("sort_order"),
    db.from("scam_articles").select("id, category_id, title, slug, description, source_name, last_verified").eq("status", "active").order("title"),
  ]);

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
        categories={(cats.data ?? []) as { id: string; slug: string; name: string; description: string; icon: string }[]}
        articles={(articles.data ?? []) as { id: string; category_id: string; title: string; slug: string; description: string; source_name: string; last_verified: string }[]}
      />
    </div>
  );
}
