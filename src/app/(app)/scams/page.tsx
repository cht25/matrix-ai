import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Scam Library" };

export default async function ScamsPage() {
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirectToLogin();

  const [cats, articles] = await Promise.all([
    db.from("scam_categories").select("id, slug, name, description, icon").eq("status", "active").order("sort_order"),
    db.from("scam_articles").select("id, category_id, title, slug, description, source_name, last_verified").eq("status", "active").order("title"),
  ]);

  const categories = (cats.data ?? []) as { id: string; slug: string; name: string; description: string; icon: string }[];
  const articleList = (articles.data ?? []) as { id: string; category_id: string; title: string; slug: string; description: string; source_name: string; last_verified: string }[];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-extrabold text-slate-900 sm:text-3xl">Scam Library</h1>
        <p className="mt-1 text-slate-500">
          Learn the patterns scammers use so you can spot them before they work. Every article is verified and
          sourced from trusted organisations.
        </p>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {categories.map((c) => (
          <Card key={c.id}>
            <p className="text-2xl" aria-hidden="true">{emojiFor(c.icon)}</p>
            <h2 className="mt-2 font-bold text-slate-900">{c.name}</h2>
            <p className="mt-1 text-sm text-slate-600">{c.description}</p>
            <p className="mt-3 text-xs text-slate-400">
              {articleList.filter((a) => a.category_id === c.id).length} article(s)
            </p>
          </Card>
        ))}
      </div>

      <div className="space-y-2.5">
        <h2 className="text-lg font-bold text-slate-900">Articles</h2>
        {articleList.map((a) => (
          <Link key={a.id} href={`/scams/${a.slug}`} className="block">
            <Card className="transition-shadow hover:shadow-md">
              <h3 className="font-semibold text-slate-900 group-hover:text-brand-700">{a.title}</h3>
              <p className="mt-1 line-clamp-2 text-sm text-slate-600">{a.description}</p>
              <p className="mt-2 text-xs text-slate-400">
                Source: {a.source_name || "MATRIX AI research"} · verified {a.last_verified?.slice(0, 10)}
              </p>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

function emojiFor(icon: string): string {
  const map: Record<string, string> = { fish: "🐟", cart: "🛒", briefcase: "💼", wrench: "🔧", gift: "🎁", heart: "💔", chart: "📈", mask: "🎭", bug: "🐛", fingerprint: "🖐️", shield: "🛡️" };
  return map[icon] ?? "🛡️";
}

function redirectToLogin(): never {
  redirect("/login");
}
