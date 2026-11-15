"use client";

// Safe Markdown renderer for assistant replies.
//
//   headings · paragraphs · nested / ordered / task lists · tables ·
//   blockquotes · inline code · highlighted code blocks with Copy and
//   Download · LaTeX / math · links · rules
//
// AI markup is text inside a highlighted code block, never trusted application
// HTML. Publishing belongs to the explicit Agent/project workflow, not to an
// ordinary code answer.
//
// Streaming: every block is memoised on its content and keyed by position, so
// while tokens arrive only the block that is still growing re-renders.
import { memo, useMemo, useState, type ReactNode } from "react";
import { Check, Copy, Download } from "lucide-react";
import { filenameForCode, highlightCode } from "@/lib/code-blocks";
import { copyToClipboard } from "@/lib/deploy/format";
import { closeOpenInline, parseBlocks, sameBlock, type Block, type ListItem, type TableAlign } from "@/lib/markdown/blocks";
import { parseInline, type InlineNode } from "@/lib/markdown/inline";
import { MathView } from "@/components/math";
import { cn } from "@/lib/utils";

export { closeOpenInline, parseBlocks };
export type { Block };

function renderInline(nodes: InlineNode[]): ReactNode[] {
  return nodes.map((node, i) => {
    switch (node.t) {
      case "text": return node.v;
      case "br": return <br key={i} />;
      case "code": return <code key={i}>{node.v}</code>;
      case "math": return <MathView key={i} tex={node.v} display={node.display} />;
      case "strong": return <strong key={i}>{renderInline(node.c)}</strong>;
      case "em": return <em key={i}>{renderInline(node.c)}</em>;
      case "del": return <del key={i}>{renderInline(node.c)}</del>;
      case "link": return <a key={i} href={node.href} target="_blank" rel="noopener noreferrer nofollow">{renderInline(node.c)}</a>;
    }
  });
}

const Inline = memo(function Inline({ text }: { text: string }) {
  const nodes = useMemo(() => parseInline(text), [text]);
  return <>{renderInline(nodes)}</>;
});

const CODE_BUTTON = "inline-flex h-8 items-center gap-1.5 rounded-md px-2 text-[11px] font-medium text-ink-3 transition-colors hover:bg-surface-2 hover:text-ink";

const CodeBlock = memo(function CodeBlock({ lang, filename, code, streaming }: { lang: string; filename: string; code: string; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  // Highlight only after the fence is complete; the active code block keeps
  // the same <pre> and never runs the tokenizer for every incoming fragment.
  const tokens = useMemo(() => streaming ? null : highlightCode(code, lang), [code, lang, streaming]);
  async function copy() {
    const ok = await copyToClipboard(code);
    setCopied(ok); setCopyFailed(!ok);
    if (ok) setTimeout(() => setCopied(false), 1800);
  }
  function download() {
    const url = URL.createObjectURL(new Blob([code], { type: "text/plain;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = filename || filenameForCode(lang, 0); anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return <div className="code-block my-3 min-w-0 overflow-hidden">
    <div className="flex items-center justify-between gap-2 border-b border-border py-1 pl-3 pr-1.5">
      <span className="min-w-0 truncate font-mono text-[11px] text-ink-2"><span className="mr-2 font-sans text-[10px] font-semibold uppercase tracking-widest text-ink-3">{lang}</span>{filename}</span>
      <div className="flex shrink-0 items-center">
        <button type="button" onClick={() => void copy()} aria-label={`Copy code from ${filename}`} className={CODE_BUTTON}>
          {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
          <span aria-live="polite">{copied ? "Copied" : "Copy code"}</span>
        </button>
        <button type="button" onClick={download} aria-label={`Download ${filename}`} title={`Download ${filename}`} className={CODE_BUTTON}>
          <Download size={13} aria-hidden="true" /><span className="hidden sm:inline">Download</span>
        </button>
      </div>
    </div>
    {/* The block scrolls sideways inside itself; it can never widen the page. */}
    <pre className="max-w-full overflow-x-auto" tabIndex={0} aria-label={`${lang} code`}><code>{tokens ? tokens.map((token, i) => <span key={i} className={`code-token-${token.kind}`}>{token.text}</span>) : code}</code></pre>
    {copyFailed ? <p className="border-t border-border px-3 py-1.5 text-[11px] text-warning" role="status">Clipboard access was blocked. Select the code and copy it manually.</p> : null}
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

type ListNode = { item: ListItem; children: ListNode[] };

/** Flat, depth-annotated items → a tree. A level can never be skipped. */
function listTree(items: ListItem[]): ListNode[] {
  const root: ListNode[] = [];
  const path: ListNode[] = [];
  for (const item of items) {
    const node: ListNode = { item, children: [] };
    const depth = Math.min(item.depth, path.length);
    path.length = depth;
    (depth === 0 ? root : path[depth - 1].children).push(node);
    path[depth] = node;
  }
  return root;
}

function ListLevel({ nodes, liveLast }: { nodes: ListNode[]; liveLast: boolean }) {
  // Siblings of mixed kinds ("- a" next to "1. b") become adjacent lists.
  const runs: ListNode[][] = [];
  for (const node of nodes) {
    const current = runs[runs.length - 1];
    if (current && current[0].item.ordered === node.item.ordered) current.push(node);
    else runs.push([node]);
  }
  return <>{runs.map((run, r) => {
    const lastRun = r === runs.length - 1;
    const rows = run.map((node, i) => {
      const last = liveLast && lastRun && i === run.length - 1;
      const text = last && !node.children.length ? closeOpenInline(node.item.text) : node.item.text;
      const task = node.item.task;
      return <li key={i} className={task ? "task-item" : undefined}>
        {task ? <input type="checkbox" checked={task === "done"} readOnly disabled aria-label={task === "done" ? "Completed" : "Not completed"} /> : null}
        <span className="whitespace-pre-wrap"><Inline text={text} /></span>
        {node.children.length ? <ListLevel nodes={node.children} liveLast={last} /> : null}
      </li>;
    });
    return run[0].item.ordered
      ? <ol key={r} start={run[0].item.number && run[0].item.number !== 1 ? run[0].item.number : undefined}>{rows}</ol>
      : <ul key={r} className={run.every((node) => node.item.task) ? "task-list" : undefined}>{rows}</ul>;
  })}</>;
}

const ALIGN: Record<Exclude<TableAlign, null>, string> = { left: "text-left", center: "text-center", right: "text-right" };

function Table({ rows, align }: { rows: string[][]; align: TableAlign[] }) {
  const [head, ...body] = rows;
  const columns = head.length;
  const cellAlign = (j: number) => (align[j] ? ALIGN[align[j]!] : "text-left");
  // Wide tables scroll inside their own box instead of overflowing the screen.
  return <div className="table-wrap my-3 max-w-full overflow-x-auto rounded-lg border border-border" tabIndex={0} role="region" aria-label="Table">
    <table className="w-full border-collapse text-sm">
      <thead><tr>{head.map((cell, j) => <th key={j} scope="col" className={cn("whitespace-nowrap border-b border-border bg-surface-2 px-3 py-2 font-semibold text-ink", cellAlign(j))}><Inline text={cell} /></th>)}</tr></thead>
      <tbody>{body.map((row, r) => <tr key={r} className="border-b border-border last:border-b-0">
        {Array.from({ length: columns }, (_, j) => <td key={j} className={cn("px-3 py-2 align-top", cellAlign(j))}><Inline text={row[j] ?? ""} /></td>)}
      </tr>)}</tbody>
    </table>
  </div>;
}

const HEADING_CLASS = ["md-h1", "md-h2", "md-h3", "md-h4", "md-h4", "md-h4"];

/**
 * One rendered block. Memoised on the block's CONTENT, so during streaming
 * only the block that is still growing re-renders; finished paragraphs, lists
 * and (already highlighted) code blocks above it are left untouched.
 */
const MarkdownBlock = memo(function MarkdownBlock({ block, live }: { block: Block; live: boolean }) {
  const inline = (text: string) => live ? closeOpenInline(text) : text;
  switch (block.type) {
    case "h": {
      // Replies sit under the page's own heading, so "#" maps to <h2>.
      const Tag = (["h2", "h3", "h4", "h5", "h6", "h6"] as const)[Math.min(5, Math.max(0, block.level - 1))];
      return <Tag className={HEADING_CLASS[Math.min(5, Math.max(0, block.level - 1))]}><Inline text={inline(block.text)} /></Tag>;
    }
    case "ul": case "ol": return <ListLevel nodes={listTree(block.items)} liveLast={live} />;
    case "quote": return <blockquote className="whitespace-pre-wrap"><Inline text={inline(block.text)} /></blockquote>;
    // A formula the stream has not closed yet stays readable source text.
    case "math": return block.open ? <pre className="math-block math-source" aria-label="LaTeX expression">{block.text}</pre> : <MathView tex={block.text} display />;
    case "hr": return <hr />;
    case "image": return <RemoteImage src={block.src} alt={block.alt} />;
    case "table": return <Table rows={block.rows} align={block.align} />;
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
