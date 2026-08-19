"use client";

// Docs shell: sticky sidebar (desktop), collapsible menu (mobile), reading
// progress, breadcrumbs, TOC, prev/next navigation, Ctrl+K search.

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Search } from "lucide-react";
import { Logo, MatrixWordmark } from "@/components/logo";
import { ThemeToggle } from "@/lib/theme";
import { DOC_INDEX, DOC_SECTIONS, docNav, type DocSection } from "@/content/docs";
import { cn } from "@/lib/utils";

function DocBlockRenderer({ section }: { section: DocSection }) {
  return (
    <article>
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-widest text-accent">
        <span aria-hidden="true">{section.icon}</span> MATRIX Documentation
      </div>
      <h1 className="mt-2 text-3xl font-display font-semibold tracking-tight text-ink">{section.title}</h1>
      <div className="mt-6 space-y-4">
        {section.blocks.map((b, i) => {
          switch (b.t) {
            case "h2":
              return <h2 key={i} id={`h-${b.text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} className="scroll-mt-24 pt-4 text-xl font-bold text-ink">{b.text}</h2>;
            case "h3":
              return <h3 key={i} className="pt-2 text-base font-bold text-ink">{b.text}</h3>;
            case "ul":
              return (
                <ul key={i} className="list-disc space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-2 marker:text-accent">
                  {b.items.map((it, j) => <li key={j}>{it}</li>)}
                </ul>
              );
            case "ol":
              return (
                <ol key={i} className="list-decimal space-y-1.5 pl-5 text-[15px] leading-relaxed text-ink-2 marker:font-semibold marker:text-accent">
                  {b.items.map((it, j) => <li key={j}>{it}</li>)}
                </ol>
              );
            case "callout": {
              const tones = {
                info: "border-accent/30 bg-accent-soft text-accent",
                warn: "border-warning/30 bg-warning-soft text-warning",
                success: "border-success/30 bg-success-soft text-success",
              };
              return (
                <div key={i} className={cn("rounded-xl border px-4 py-3 text-sm leading-relaxed", tones[b.tone])}>
                  {b.text}
                </div>
              );
            }
            case "code":
              return (
                <pre key={i} className="code-block overflow-x-auto"><code className="block whitespace-pre p-4">{b.code}</code></pre>
              );
            default:
              return <p key={i} className="text-[15px] leading-relaxed text-ink-2">{b.text}</p>;
          }
        })}
      </div>
    </article>
  );
}

function DocSearch({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => inputRef.current?.focus(), []);

  const results = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return [];
    return DOC_INDEX.flatMap((s) => {
      const hits: { slug: string; section: string; title: string }[] = [];
      if (s.title.toLowerCase().includes(needle)) hits.push({ slug: s.slug, section: "Overview", title: s.title });
      for (const h of s.headings) {
        if (h.toLowerCase().includes(needle)) hits.push({ slug: s.slug, section: h, title: s.title });
      }
      return hits;
    }).slice(0, 12);
  }, [q]);

  return (
    <div className="fade-in fixed inset-0 z-[80] flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Search documentation">
      <div className="card w-full max-w-lg overflow-hidden !rounded-lg shadow-[var(--shadow-pop)]">
        <div className="flex items-center gap-2 border-b border-border px-4">
          <span className="text-ink-3"><Search size={15} strokeWidth={1.6} /></span>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            placeholder="Search documentation…"
            aria-label="Search documentation"
            className="w-full bg-transparent py-4 text-sm text-ink outline-none placeholder:text-ink-3"
          />
          <kbd className="rounded-md border border-border px-1.5 py-0.5 text-[10px] text-ink-3">ESC</kbd>
        </div>
        <div className="max-h-72 overflow-y-auto p-2">
          {results.length === 0 ? (
            <p className="px-3 py-6 text-center text-sm text-ink-3">{q ? "No results." : "Type to search the documentation."}</p>
          ) : (
            results.map((r, i) => (
              <Link
                key={i}
                href={`/docs/${r.slug}`}
                onClick={onClose}
                className="block rounded-lg px-3 py-2.5 transition-colors hover:bg-surface-2"
              >
                <p className="text-sm font-semibold text-ink">{r.title}</p>
                <p className="text-xs text-ink-3">{r.section}</p>
              </Link>
            ))
          )}
        </div>
      </div>
    </div>
  );
}

export function DocsShell({ slug, children }: { slug: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [progress, setProgress] = useState(0);
  const [tocOpen, setTocOpen] = useState(false);

  const section = DOC_SECTIONS.find((s) => s.slug === slug);
  const { prev, next } = docNav(slug);

  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  // Ctrl+K / Cmd+K search
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setSearchOpen((v) => !v);
      }
      if (e.key === "Escape") setSearchOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Reading progress
  useEffect(() => {
    const onScroll = () => {
      const el = document.documentElement;
      const total = el.scrollHeight - el.clientHeight;
      setProgress(total > 0 ? (el.scrollTop / total) * 100 : 0);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const toc = section?.blocks.filter((b): b is Extract<typeof b, { t: "h2" }> => b.t === "h2") ?? [];

  return (
    <div className="min-h-dvh">
      {/* Progress bar */}
      <div className="fixed inset-x-0 top-0 z-50 h-0.5 bg-transparent">
        <div className="h-full bg-accent transition-[width] duration-150" style={{ width: `${progress}%` }} />
      </div>

      <header className="sticky top-0 z-40 flex h-14 items-center justify-between border-b border-border bg-surface/85 px-4 backdrop-blur-xl">
        <div className="flex items-center gap-2">
          <button onClick={() => setMenuOpen(!menuOpen)} aria-label="Toggle documentation menu" className="grid h-11 w-11 place-items-center rounded-xl text-ink-2 hover:bg-surface-2 lg:hidden">
            ☰
          </button>
          <Logo size="sm" href="/" />
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setSearchOpen(true)}
            className="flex min-h-9 items-center gap-2 rounded-lg border border-border bg-surface px-3 text-[13px] text-ink-3 transition-colors hover:border-border-strong"
            aria-label="Search documentation (Ctrl+K)"
          >
            <Search size={14} strokeWidth={1.6} /> <span className="hidden sm:inline">Search</span>
            <kbd className="hidden rounded-md border border-border px-1.5 py-0.5 text-[10px] sm:inline">Ctrl K</kbd>
          </button>
          <ThemeToggle compact />
        </div>
      </header>

      <div className="mx-auto flex max-w-6xl">
        {/* Sidebar */}
        <aside className={cn(
          "fixed inset-y-14 left-0 z-30 w-64 overflow-y-auto border-r border-border bg-surface px-3 py-4 lg:sticky lg:top-14 lg:h-[calc(100dvh-3.5rem)] lg:translate-x-0 lg:bg-transparent",
          menuOpen ? "translate-x-0" : "-translate-x-full transition-transform lg:transition-none",
        )}>
          <p className="px-2 pb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">Documentation</p>
          <nav aria-label="Documentation" className="space-y-0.5">
            {DOC_SECTIONS.map((s) => (
              <Link
                key={s.slug}
                href={`/docs/${s.slug}`}
                className={cn(
                  "block rounded-md px-2.5 py-1.5 text-[13px] transition-colors",
                  s.slug === slug ? "bg-surface-2 font-medium text-ink" : "text-ink-2 hover:bg-surface-2 hover:text-ink",
                )}
              >
                {s.title}
              </Link>
            ))}
          </nav>
          <div className="mt-4 border-t border-border pt-3">
            <Link href="/" className="block rounded-lg px-2.5 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-ink">← Back to MATRIX</Link>
          </div>
        </aside>
        {menuOpen ? <button type="button" className="fixed inset-0 z-[25] bg-black/50 lg:hidden" aria-label="Close menu" onClick={() => setMenuOpen(false)} /> : null}

        {/* Article */}
        <div className="min-w-0 flex-1 px-4 py-8 sm:px-8">
          {/* Breadcrumbs */}
          <nav aria-label="Breadcrumb" className="mb-4 text-xs text-ink-3">
            <Link href="/" className="hover:text-accent">Home</Link>
            <span className="mx-1.5">/</span>
            <Link href="/docs" className="hover:text-accent">Docs</Link>
            <span className="mx-1.5">/</span>
            <span className="text-ink-2">{section?.title}</span>
          </nav>

          {children}

          {/* Prev / Next */}
          <nav className="mt-10 grid gap-3 border-t border-border pt-6 sm:grid-cols-2" aria-label="Documentation navigation">
            {prev ? (
              <Link href={`/docs/${prev.slug}`} className="card card-hover group !p-4">
                <p className="text-xs text-ink-3">← Previous</p>
                <p className="mt-1 font-semibold text-ink group-hover:text-accent">{prev.title}</p>
              </Link>
            ) : <span />}
            {next ? (
              <Link href={`/docs/${next.slug}`} className="card card-hover group !p-4 text-right">
                <p className="text-xs text-ink-3">Next →</p>
                <p className="mt-1 font-semibold text-ink group-hover:text-accent">{next.title}</p>
              </Link>
            ) : null}
          </nav>
        </div>

        {/* TOC */}
        {toc.length > 0 ? (
          <aside className="hidden w-56 shrink-0 px-4 py-8 xl:block">
            <p className="pb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">On this page</p>
            <nav aria-label="Table of contents" className="space-y-1">
              {toc.map((h) => (
                <a
                  key={h.text}
                  href={`#h-${h.text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
                  className="block rounded-md px-2 py-1 text-xs text-ink-2 hover:bg-surface-2 hover:text-accent"
                >
                  {h.text}
                </a>
              ))}
            </nav>
          </aside>
        ) : null}

        {/* Mobile TOC toggle */}
        {toc.length > 0 ? (
          <button onClick={() => setTocOpen(!tocOpen)} className="fixed bottom-4 right-4 z-30 rounded-lg bg-ink px-4 py-2.5 text-sm font-medium text-bg shadow-[var(--shadow-pop)] xl:hidden">
            {tocOpen ? "Hide contents" : "Contents"}
          </button>
        ) : null}
        {tocOpen ? (
          <div className="fixed inset-0 z-40 flex items-end bg-black/50 xl:hidden" onClick={() => setTocOpen(false)}>
            <div className="card w-full !rounded-b-none p-4" onClick={(e) => e.stopPropagation()}>
              <p className="pb-2 text-[10px] font-bold uppercase tracking-widest text-ink-3">On this page</p>
              {toc.map((h) => (
                <a key={h.text} href={`#h-${h.text.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`} onClick={() => setTocOpen(false)} className="block rounded-md px-2 py-2 text-sm text-ink-2 hover:bg-surface-2 hover:text-accent">
                  {h.text}
                </a>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 py-8 text-sm text-ink-3 sm:flex-row">
          <MatrixWordmark className="h-5 w-24 text-ink" />
          <p>Powered by THAMJJ13.TOP White Hat Team</p>
        </div>
      </footer>

      {searchOpen ? <DocSearch onClose={() => setSearchOpen(false)} /> : null}
    </div>
  );
}

export function DocRenderer({ section }: { section: DocSection }) {
  return <DocBlockRenderer section={section} />;
}
