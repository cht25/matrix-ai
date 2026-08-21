"use client";

// Safe renderer for AI replies: headings, bold, lists, inline code, fenced
// code blocks with copy + make-public (no HTML upload required).

import { useState } from "react";
import { rpc, RpcCallError } from "@/lib/client/api";

type Block =
  | { type: "p"; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; items: string[] }
  | { type: "h"; text: string }
  | { type: "code"; lang: string; code: string };

function parseBlocks(raw: string): Block[] {
  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { lang: string; code: string[] } | null = null;

  const flushList = () => {
    if (list) {
      blocks.push(list.ordered ? { type: "ol", items: list.items } : { type: "ul", items: list.items });
      list = null;
    }
  };

  for (const line of lines) {
    if (fence) {
      if (line.trim().startsWith("```")) {
        blocks.push({ type: "code", lang: fence.lang, code: fence.code.join("\n") });
        fence = null;
      } else {
        fence.code.push(line);
      }
      continue;
    }
    const fenceMatch = line.match(/^```(\w*)/);
    if (fenceMatch) {
      flushList();
      fence = { lang: fenceMatch[1] || "text", code: [] };
      continue;
    }
    const t = line.trim();
    if (!t) { flushList(); continue; }
    const ul = t.match(/^[-*•]\s+(.*)/);
    const ol = t.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) {
      if (!list || list.ordered !== Boolean(ol)) { flushList(); list = { ordered: Boolean(ol), items: [] }; }
      list.items.push((ul ? ul[1] : ol![1]).trim());
      continue;
    }
    flushList();
    if (/^#{1,4}\s/.test(t)) {
      blocks.push({ type: "h", text: t.replace(/^#{1,4}\s/, "") });
    } else {
      blocks.push({ type: "p", text: t });
    }
  }
  if (fence) blocks.push({ type: "code", lang: fence.lang, code: fence.code.join("\n") });
  flushList();
  return blocks;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return (
    <>
      {parts.map((p, i) => {
        if (p.startsWith("**") && p.endsWith("**")) return <strong key={i}>{p.slice(2, -2)}</strong>;
        if (p.startsWith("`") && p.endsWith("`")) return <code key={i}>{p.slice(1, -1)}</code>;
        const link = p.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
        if (link) {
          return (
            <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">
              {link[1]}
            </a>
          );
        }
        return <span key={i}>{p}</span>;
      })}
    </>
  );
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [pub, setPub] = useState<"idle" | "busy" | "done" | "err">("idle");
  const [url, setUrl] = useState<string | null>(null);

  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard unavailable */
    }
  }

  async function makePublic() {
    if (pub === "busy") return;
    setPub("busy");
    try {
      const result = await rpc<{ public_url: string }>("snippet_publish", { lang, code });
      setUrl(result.public_url);
      setPub("done");
    } catch (err) {
      setPub("err");
      setUrl(err instanceof RpcCallError ? err.code : "Publish failed");
    }
  }

  return (
    <div className="code-block my-2">
      <div className="flex items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
        <span className="text-[10px] font-bold uppercase tracking-widest text-ink-3">{lang}</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded-md px-2 py-1 text-[10px] font-semibold text-ink-3 transition-colors hover:bg-surface/10 hover:text-white"
          >
            {copied ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            onClick={() => void makePublic()}
            disabled={pub === "busy"}
            className="rounded-md px-2 py-1 text-[10px] font-semibold text-ink-3 transition-colors hover:bg-surface/10 hover:text-white disabled:opacity-50"
          >
            {pub === "busy" ? "Publishing…" : pub === "done" ? "Public" : "Make public"}
          </button>
        </div>
      </div>
      <pre><code>{code}</code></pre>
      {url && pub === "done" ? (
        <p className="border-t border-white/10 px-3 py-1.5 text-[11px]">
          Live: <a href={url} target="_blank" rel="noreferrer" className="text-accent underline">{url}</a>
        </p>
      ) : null}
      {pub === "err" && url ? <p className="border-t border-white/10 px-3 py-1.5 text-[11px] text-danger">{url}</p> : null}
    </div>
  );
}

export function Markdown({ text }: { text: string }) {
  const blocks = parseBlocks(text);
  return (
    <div className="ai-reply">
      {blocks.map((b, i) => {
        switch (b.type) {
          case "h":
            return <p key={i} className="!mt-3 font-bold text-ink"><Inline text={b.text} /></p>;
          case "ul":
            return <ul key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ul>;
          case "ol":
            return <ol key={i}>{b.items.map((it, j) => <li key={j}><Inline text={it} /></li>)}</ol>;
          case "code":
            return <CodeBlock key={i} lang={b.lang} code={b.code} />;
          default:
            return <p key={i}><Inline text={b.text} /></p>;
        }
      })}
    </div>
  );
}
