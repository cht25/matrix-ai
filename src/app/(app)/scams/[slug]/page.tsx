import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { getDataClient, isDemoMode, getCurrentUser } from "@/lib/data";
import { Button, Card } from "@/components/ui";

export const metadata: Metadata = { title: "Scam article" };

export default async function ScamArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const db = await getDataClient();
  const user = await getCurrentUser(db);
  const demo = isDemoMode();
  if (!user && !demo) redirect("/login");

  const { data } = await db.from("scam_articles").select("*").eq("slug", slug).eq("status", "active").maybeSingle();
  const article = data as {
    title: string; description: string; warning_signs: string; prevention: string;
    response_steps: string; reporting_guidance: string; source_name: string; source_url: string;
    last_verified: string;
  } | null;
  if (!article) notFound();

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <Link href="/scams" className="text-sm font-medium text-accent hover:text-accent-2">← Back to Scam Library</Link>
      <div>
        <h1 className="text-2xl font-extrabold text-ink sm:text-3xl">{article.title}</h1>
        <p className="mt-2 text-ink-2">{article.description}</p>
      </div>

      <Section title="⚠️ Warning signs" body={article.warning_signs} />
      <Section title="🛡️ How to prevent it" body={article.prevention} />
      <Section title="✅ What to do if it happened" body={article.response_steps} />
      <Section title="📢 Reporting guidance" body={article.reporting_guidance} />

      <Card className="!p-4 text-sm text-ink-3">
        Source: <a href={article.source_url || "#"} target="_blank" rel="noopener noreferrer" className="font-medium text-accent hover:underline">{article.source_name || "Verified research"}</a>
        {" "}· last verified {article.last_verified?.slice(0, 10)}
      </Card>

      <div className="flex flex-wrap gap-3">
        <Link href="/report"><Button>Report a similar scam</Button></Link>
        <Link href="/chat"><Button variant="outline">Ask MATRIX AI about it</Button></Link>
      </div>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <h2 className="font-bold text-ink">{title}</h2>
      <p className="mt-2 whitespace-pre-line text-[15px] leading-relaxed text-ink-2">{body}</p>
    </Card>
  );
}
