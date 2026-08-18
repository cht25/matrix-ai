"use client";

// Searchable, filterable scam library browser.

import { useMemo, useState } from "react";
import Link from "next/link";
import { Card, EmptyState, Input } from "@/components/ui";
import { cn } from "@/lib/utils";

type Category = { id: string; slug: string; name: string; description: string; icon: string };
type Article = { id: string; category_id: string; title: string; slug: string; description: string; source_name: string; last_verified: string };

const EMOJI: Record<string, string> = {
  fish: "🐟", cart: "🛒", briefcase: "💼", wrench: "🔧", gift: "🎁", heart: "💔",
  chart: "📈", mask: "🎭", bug: "🐛", fingerprint: "🖐️", shield: "🛡️", key: "🔑", otp: "🔢",
};

export function ScamBrowser({ categories, articles }: { categories: Category[]; articles: Article[] }) {
  const [q, setQ] = useState("");
  const [cat, setCat] = useState<string>("all");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return articles.filter((a) => {
      if (cat !== "all" && a.category_id !== cat) return false;
      if (!needle) return true;
      return a.title.toLowerCase().includes(needle) || a.description.toLowerCase().includes(needle);
    });
  }, [q, cat, articles]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row">
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search scams, e.g. 'QR code'…" aria-label="Search the scam library" className="sm:max-w-sm" />
      </div>

      <div className="no-scrollbar flex gap-1.5 overflow-x-auto pb-1" role="group" aria-label="Filter by category">
        <button
          onClick={() => setCat("all")}
          aria-pressed={cat === "all"}
          className={cn(
            "min-h-9 shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors",
            cat === "all" ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-surface text-ink-2 hover:border-accent",
          )}
        >
          All
        </button>
        {categories.map((c) => (
          <button
            key={c.id}
            onClick={() => setCat(c.id)}
            aria-pressed={cat === c.id}
            className={cn(
              "min-h-9 shrink-0 rounded-full border px-3.5 py-1.5 text-xs font-semibold transition-colors",
              cat === c.id ? "border-accent bg-accent-soft text-accent" : "border-border-strong bg-surface text-ink-2 hover:border-accent",
            )}
          >
            {EMOJI[c.icon] ?? "🛡️"} {c.name}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="No articles match" body="Try a different search term or category." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filtered.map((a) => {
            const c = categories.find((x) => x.id === a.category_id);
            return (
              <Link key={a.id} href={`/scams/${a.slug}`} className="card card-hover flex flex-col !p-5">
                <span className="text-2xl" aria-hidden="true">{EMOJI[c?.icon ?? ""] ?? "🛡️"}</span>
                <h3 className="mt-2 font-bold text-ink">{a.title}</h3>
                <p className="mt-1 line-clamp-3 flex-1 text-sm text-ink-2">{a.description}</p>
                <p className="mt-3 text-xs text-ink-3">
                  {c?.name ?? "General"} · verified {a.last_verified?.slice(0, 10)}
                </p>
              </Link>
            );
          })}
        </div>
      )}

      {filtered.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((c) => (
            <Card key={c.id} className="!p-4">
              <p className="text-xl" aria-hidden="true">{EMOJI[c.icon] ?? "🛡️"}</p>
              <h2 className="mt-1 font-bold text-ink">{c.name}</h2>
              <p className="mt-0.5 text-xs text-ink-2">{c.description}</p>
            </Card>
          ))}
        </div>
      ) : null}
    </div>
  );
}
