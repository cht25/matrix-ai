"use client";

// Safe coding-assistance renderer. AI markup is text inside a highlighted code
// block, never trusted application HTML. Publishing belongs to the explicit
// Agent/project workflow, not to an ordinary code answer.
import { useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { filenameForCode, highlightCode, looksLikeRawMarkup, parseFenceInfo } from "@/lib/code-blocks";

type Block =
  | { type: "p" | "h"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "code"; lang: string; filename: string; code: string };

export function parseBlocks(raw: string): Block[] {
  if (looksLikeRawMarkup(raw)) return [{ type: "code", lang: "html", filename: "index.html", code: raw.trim() }];
  const lines = raw.split("\n"); const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { lang: string; filename: string; code: string[] } | null = null;
  let codeIndex = 0;
  const flushList = () => { if (list) { blocks.push({ type: list.ordered ? "ol" : "ul", items: list.items }); list = null; } };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      if (/^\s*```+\s*$/.test(line)) { blocks.push({ type: "code", lang: fence.lang, filename: fence.filename, code: fence.code.join("\n") }); fence = null; }
      else fence.code.push(line);
      continue;
    }
    const opening = line.match(/^\s*```+\s*([^`\n]*)$/);
    if (opening) {
      flushList(); const info = parseFenceInfo(opening[1] ?? "", lines[i - 1] ?? "", codeIndex++);
      fence = { lang: info.language, filename: info.filename, code: [] }; continue;
    }
    const t = line.trim();
    if (!t) { flushList(); continue; }
    // A filename label immediately before a fence is shown in the code header,
    // not duplicated as a prose paragraph.
    if (/^(?:\*\*[\w./-]+\.[a-z0-9]+\*\*|#{1,4}\s+[\w./-]+\.[a-z0-9]+|`[\w./-]+\.[a-z0-9]+`)$/i.test(t) && /^\s*```/.test(lines[i + 1] ?? "")) continue;
    const ul = t.match(/^[-*•]\s+(.*)/); const ol = t.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) { if (!list || list.ordered !== Boolean(ol)) { flushList(); list = { ordered: Boolean(ol), items: [] }; } list.items.push((ul ? ul[1] : ol![1]).trim()); continue; }
    flushList();
    if (/^#{1,6}\s/.test(t)) blocks.push({ type: "h", text: t.replace(/^#{1,6}\s/, "") });
    else blocks.push({ type: "p", text: line });
  }
  if (fence) blocks.push({ type: "code", lang: fence.lang, filename: fence.filename, code: fence.code.join("\n") });
  flushList(); return blocks;
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return <>{parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{link[1]}</a>;
    return <span key={i}>{part}</span>;
  })}</>;
}

function CodeBlock({ lang, filename, code }: { lang: string; filename: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(code); setCopied(true); setCopyFailed(false); setTimeout(() => setCopied(false), 1800); }
    catch { setCopyFailed(true); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename || filenameForCode(lang, 0); anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="code-block my-2 min-w-0 overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-1.5">
      <span className="min-w-0 truncate font-mono text-[11px] text-ink-2"><span className="mr-2 font-sans text-[10px] font-bold uppercase tracking-widest text-ink-3">{lang}</span>{filename}</span>
      <div className="flex shrink-0 items-center gap-1">
        <button type="button" onClick={() => void copy()} aria-label={`Copy code from ${filename}`} className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-ink-3 hover:bg-surface/10 hover:text-white">{copied ? <Check size={12} /> : <Copy size={12} />}{copied ? "Copied" : "Copy code"}</button>
        <button type="button" onClick={download} aria-label={`Download ${filename}`} className="inline-flex min-h-8 items-center gap-1 rounded-md px-2 text-[11px] font-semibold text-ink-3 hover:bg-surface/10 hover:text-white"><Download size={12} />Download</button>
      </div>
    </div>
    <pre className="max-w-full overflow-x-auto"><code>{highlightCode(code, lang).map((token, i) => <span key={i} className={`code-token-${token.kind}`}>{token.text}</span>)}</code></pre>
    {copyFailed ? <p className="border-t border-white/10 px-3 py-1.5 text-[11px] text-warning">Clipboard access was blocked. Select the code and copy it manually.</p> : null}
  </div>;
}

export function Markdown({ text }: { text: string }) {
  return <div className="ai-reply min-w-0">{parseBlocks(text).map((block, i) => {
    switch (block.type) {
      case "h": return <p key={i} className="!mt-3 font-bold text-ink"><Inline text={block.text} /></p>;
      case "ul": return <ul key={i}>{block.items.map((item, j) => <li key={j}><Inline text={item} /></li>)}</ul>;
      case "ol": return <ol key={i}>{block.items.map((item, j) => <li key={j}><Inline text={item} /></li>)}</ol>;
      case "code": return <CodeBlock key={i} lang={block.lang} filename={block.filename} code={block.code} />;
      default: return <p key={i} className="whitespace-pre-wrap"><Inline text={block.text} /></p>;
    }
  })}</div>;
}
