"use client";

// Safe coding-assistance renderer. AI markup is text inside a highlighted code
// block, never trusted application HTML. Publishing belongs to the explicit
// Agent/project workflow, not to an ordinary code answer.
import { memo, useMemo, useState } from "react";
import { Check, Copy, Download } from "lucide-react";
import { filenameForCode, highlightCode, looksLikeRawMarkup, parseFenceInfo } from "@/lib/code-blocks";

type Block =
  | { type: "p" | "h"; text: string }
  | { type: "ul" | "ol"; items: string[] }
  | { type: "quote" | "math"; text: string }
  | { type: "table"; rows: string[][] }
  | { type: "image"; alt: string; src: string }
  | { type: "code"; lang: string; filename: string; code: string; open?: boolean };

export function parseBlocks(raw: string): Block[] {
  if (looksLikeRawMarkup(raw)) return [{ type: "code", lang: "html", filename: "index.html", code: raw.trim() }];
  const lines = raw.split("\n"); const blocks: Block[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  let fence: { lang: string; filename: string; code: string[] } | null = null;
  let codeIndex = 0;
  let quote: string[] = [];
  const flushQuote = () => { if (quote.length) { blocks.push({ type: "quote", text: quote.join("\n") }); quote = []; } };
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
      flushList(); flushQuote(); const info = parseFenceInfo(opening[1] ?? "", lines[i - 1] ?? "", codeIndex++);
      fence = { lang: info.language, filename: info.filename, code: [] }; continue;
    }
    const t = line.trim();
    if (!t) { flushList(); flushQuote(); continue; }
    if (/^>\s?/.test(t)) { flushList(); quote.push(t.replace(/^>\s?/, "")); continue; }
    flushQuote();
    if (t === "$$") {
      flushList();
      const math: string[] = [];
      while (++i < lines.length && lines[i].trim() !== "$$") math.push(lines[i]);
      blocks.push({ type: "math", text: math.join("\n") }); continue;
    }
    const image = t.match(/^!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)$/);
    if (image) { flushList(); blocks.push({ type: "image", alt: image[1], src: image[2] }); continue; }
    if (t.includes("|") && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1] ?? "")) {
      flushList();
      const cells = (row: string) => row.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((cell) => cell.trim());
      const rows = [cells(line)]; i += 1;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) rows.push(cells(lines[++i]));
      blocks.push({ type: "table", rows }); continue;
    }
    // A filename label immediately before a fence is shown in the code header,
    // not duplicated as a prose paragraph.
    if (/^(?:\*\*[\w./-]+\.[a-z0-9]+\*\*|#{1,4}\s+[\w./-]+\.[a-z0-9]+|`[\w./-]+\.[a-z0-9]+`)$/i.test(t) && /^\s*```/.test(lines[i + 1] ?? "")) continue;
    const ul = t.match(/^[-*•]\s+(.*)/); const ol = t.match(/^\d+[.)]\s+(.*)/);
    if (ul || ol) { if (!list || list.ordered !== Boolean(ol)) { flushList(); list = { ordered: Boolean(ol), items: [] }; } list.items.push((ul ? ul[1] : ol![1]).trim()); continue; }
    flushList();
    if (/^#{1,6}\s/.test(t)) blocks.push({ type: "h", text: t.replace(/^#{1,6}\s/, "") });
    else blocks.push({ type: "p", text: line });
  }
  // `open` marks a fence the stream has not closed yet.
  if (fence) blocks.push({ type: "code", lang: fence.lang, filename: fence.filename, code: fence.code.join("\n"), open: true });
  flushList(); flushQuote(); return blocks;
}

/**
 * While a reply is streaming, the last line often ends inside an inline
 * construct ("**bol", "`cod", "[label](https://exa"). Rendered literally the
 * markers flash on screen and the line reflows when the closing marker
 * arrives. This closes them provisionally so the text looks the same before
 * and after — it only ever affects the final, still-growing block.
 */
export function closeOpenInline(text: string): string {
  let out = text;
  // A link whose URL is still arriving: show the label only.
  out = out.replace(/\[([^\]\n]*)\]\((?:[^)\s]*)$/, "$1");
  out = out.replace(/\[([^\]\n]*)$/, "$1");
  const ticks = (out.match(/`/g) ?? []).length;
  if (ticks % 2 === 1) out += "`";
  const outsideCode = out.replace(/`[^`]*`/g, "");
  const bold = (outsideCode.match(/\*\*/g) ?? []).length;
  if (bold % 2 === 1) out = /\*\*\s*$/.test(out) ? out.replace(/\*\*\s*$/, "") : `${out}**`;
  else if (/(?:^|[^*])\*$/.test(out)) out = out.slice(0, -1);
  return out;
}

const Inline = memo(function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\(https?:\/\/[^)\s]+\))/g);
  return <>{parts.map((part, i) => {
    if (part.startsWith("**") && part.endsWith("**")) return <strong key={i}>{part.slice(2, -2)}</strong>;
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    const link = part.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
    if (link) return <a key={i} href={link[2]} target="_blank" rel="noopener noreferrer" className="text-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent">{link[1]}</a>;
    return <span key={i}>{part}</span>;
  })}</>;
});

const CodeBlock = memo(function CodeBlock({ lang, filename, code, streaming }: { lang: string; filename: string; code: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Highlight only after the fence is complete; the active code block keeps
  // the same <pre> and never runs the tokenizer for every incoming fragment.
  const tokens = useMemo(() => streaming ? null : highlightCode(code, lang), [code, lang, streaming]);
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
    <pre className="max-w-full overflow-x-auto"><code>{tokens ? tokens.map((token, i) => <span key={i} className={`code-token-${token.kind}`}>{token.text}</span>) : code}</code></pre>
    {copyFailed ? <p className="border-t border-white/10 px-3 py-1.5 text-[11px] text-warning">Clipboard access was blocked. Select the code and copy it manually.</p> : null}
  </div>;
});

// Provider-generated Markdown can contain arbitrary URLs. Do not auto-request
// third-party images (which would disclose a reader's IP); load on consent.
const RemoteImage = memo(function RemoteImage({ src, alt }: { src: string; alt: string }) {
  const [load, setLoad] = useState(false);
  if (!load) return <button type="button" onClick={() => setLoad(true)}
    className="my-2 flex min-h-16 w-full max-w-xl items-center justify-center rounded-lg border border-border bg-surface-2 px-3 text-sm text-ink-2"
    aria-label={`Load image: ${alt || "image"}`}>Load image: {alt || "Image"}</button>;
  return <img src={src} alt={alt} loading="lazy" decoding="async"
    className="my-2 max-h-[65svh] max-w-full rounded-lg object-contain"
    style={{ aspectRatio: "16 / 9" }} />;
});

function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "ul": case "ol": { const other = b as typeof a; return a.items.length === other.items.length && a.items.every((item, i) => item === other.items[i]); }
    case "table": { const other = b as typeof a; return a.rows.length === other.rows.length && a.rows.every((row, i) => row.length === other.rows[i].length && row.every((cell, j) => cell === other.rows[i][j])); }
    case "image": { const other = b as typeof a; return a.src === other.src && a.alt === other.alt; }
    case "code": { const other = b as typeof a; return a.code === other.code && a.lang === other.lang && a.filename === other.filename && a.open === other.open; }
    default: return a.text === (b as typeof a).text;
  }
}

/**
 * One rendered block. Memoised on the block's CONTENT, so during streaming
 * only the block that is still growing re-renders; finished paragraphs, lists
 * and (already highlighted) code blocks above it are left untouched.
 */
const MarkdownBlock = memo(function MarkdownBlock({ block, live }: { block: Block; live: boolean }) {
  const inline = (text: string) => live ? closeOpenInline(text) : text;
  switch (block.type) {
    case "h": return <p className="!mt-3 font-bold text-ink"><Inline text={inline(block.text)} /></p>;
    case "ul": return <ul>{block.items.map((item, j) => <li key={j}><Inline text={live && j === block.items.length - 1 ? closeOpenInline(item) : item} /></li>)}</ul>;
    case "ol": return <ol>{block.items.map((item, j) => <li key={j}><Inline text={live && j === block.items.length - 1 ? closeOpenInline(item) : item} /></li>)}</ol>;
    case "quote": return <blockquote className="border-l-2 border-accent/50 pl-3 text-ink-2"><Inline text={inline(block.text)} /></blockquote>;
    case "math": return <pre className="max-w-full overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-xs" aria-label="LaTeX expression">{block.text}</pre>;
    case "image": return <RemoteImage src={block.src} alt={block.alt} />;
    case "table": return <div className="max-w-full overflow-x-auto"><table className="w-full border-collapse text-left text-sm"><thead><tr>{block.rows[0].map((cell, j) => <th key={j} className="border-b border-border px-2 py-1"><Inline text={cell} /></th>)}</tr></thead><tbody>{block.rows.slice(1).map((row, r) => <tr key={r}>{row.map((cell, j) => <td key={j} className="border-b border-border px-2 py-1"><Inline text={cell} /></td>)}</tr>)}</tbody></table></div>;
    // Only a fence the stream has not closed yet skips highlighting; every
    // completed code block is highlighted once and then never re-tokenised.
    case "code": return <CodeBlock lang={block.lang} filename={block.filename} code={block.code} streaming={live && block.open === true} />;
    default: return <p className="whitespace-pre-wrap"><Inline text={inline(block.text)} /></p>;
  }
}, (prev, next) => prev.live === next.live && sameBlock(prev.block, next.block));

export const Markdown = memo(function Markdown({ text, streaming = false }: { text: string; streaming?: boolean }) {
  const blocks = useMemo(() => parseBlocks(text), [text]);
  // Keys are positional: blocks only ever grow at the end while streaming, so
  // block N keeps its identity (and DOM) for the whole reply.
  return <div className="ai-reply min-w-0" data-streaming={streaming ? "true" : undefined}>
    {blocks.map((block, i) => <MarkdownBlock key={i} block={block} live={streaming && i === blocks.length - 1} />)}
  </div>;
});
