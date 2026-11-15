// =============================================================================
// Block-level Markdown → a flat list of blocks (pure, no React).
//
// Written for STREAMING: text only ever grows at the end, so block N keeps its
// identity while later chunks arrive. The renderer memoises each block on its
// content, which means a 4,000-word answer re-renders one paragraph per frame,
// not the whole reply.
// =============================================================================

import { looksLikeRawMarkup, parseFenceInfo } from "@/lib/code-blocks";

export type ListItem = {
  text: string;
  /** Nesting level, 0 = top. Never skips a level. */
  depth: number;
  ordered: boolean;
  /** The number written in the source ("3." → 3); used for the list's start. */
  number?: number;
  /** GitHub-style task item: "- [ ] todo" / "- [x] done". */
  task?: "open" | "done";
};

export type TableAlign = "left" | "center" | "right" | null;

export type Block =
  | { type: "p"; text: string }
  | { type: "h"; text: string; level: number }
  | { type: "ul" | "ol"; items: ListItem[] }
  | { type: "quote"; text: string }
  | { type: "math"; text: string; open?: boolean }
  | { type: "hr" }
  | { type: "table"; rows: string[][]; align: TableAlign[] }
  | { type: "image"; alt: string; src: string }
  | { type: "code"; lang: string; filename: string; code: string; open?: boolean };

const LIST_ITEM = /^(\s*)(?:([-*+•])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/;
const RULE = /^\s*([-*_])(?:\s*\1){2,}\s*$/;
const TABLE_DIVIDER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-+:?\s*)*\|?\s*$/;
const FILE_LABEL = /^(?:\*\*[\w./-]+\.[a-z0-9]+\*\*|#{1,4}\s+[\w./-]+\.[a-z0-9]+|`[\w./-]+\.[a-z0-9]+`)$/i;

function indentOf(raw: string): number {
  let width = 0;
  for (const ch of raw) {
    if (ch === " ") width += 1;
    else if (ch === "\t") width += 4;
    else break;
  }
  return width;
}

/** Split a table row on unescaped pipes (a `|` inside `code` stays in its cell). */
function tableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  let inCode = false;
  const text = row.trim();
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\" && text[i + 1] === "|") { current += "|"; i += 1; continue; }
    if (ch === "`") inCode = !inCode;
    if (ch === "|" && !inCode) { cells.push(current); current = ""; continue; }
    current += ch;
  }
  cells.push(current);
  if (text.startsWith("|")) cells.shift();
  if (text.endsWith("|") && !text.endsWith("\\|")) cells.pop();
  return cells.map((cell) => cell.trim());
}

function alignments(divider: string): TableAlign[] {
  return tableCells(divider).map((cell) => {
    const left = cell.startsWith(":");
    const right = cell.endsWith(":");
    return left && right ? "center" : right ? "right" : left ? "left" : null;
  });
}

export function parseBlocks(raw: string): Block[] {
  if (looksLikeRawMarkup(raw)) return [{ type: "code", lang: "html", filename: "index.html", code: raw.trim() }];

  const lines = raw.split("\n");
  const blocks: Block[] = [];
  let paragraph: string[] = [];
  let quote: string[] = [];
  let list: { ordered: boolean; items: ListItem[]; indents: number[] } | null = null;
  let fence: { lang: string; filename: string; code: string[]; marker: string } | null = null;
  let codeIndex = 0;

  const flushParagraph = () => { if (paragraph.length) { blocks.push({ type: "p", text: paragraph.join("\n") }); paragraph = []; } };
  const flushQuote = () => { if (quote.length) { blocks.push({ type: "quote", text: quote.join("\n") }); quote = []; } };
  const flushList = () => { if (list) { blocks.push({ type: list.ordered ? "ol" : "ul", items: list.items }); list = null; } };
  const flushAll = () => { flushParagraph(); flushList(); flushQuote(); };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];

    if (fence) {
      const closing = line.trim();
      if (closing.startsWith(fence.marker) && /^[`~]+$/.test(closing)) {
        blocks.push({ type: "code", lang: fence.lang, filename: fence.filename, code: fence.code.join("\n") });
        fence = null;
      } else fence.code.push(line);
      continue;
    }

    const opening = line.match(/^\s*(```+|~~~+)\s*([^`\n]*)$/);
    if (opening) {
      flushAll();
      const info = parseFenceInfo(opening[2] ?? "", lines[i - 1] ?? "", codeIndex++);
      fence = { lang: info.language, filename: info.filename, code: [], marker: opening[1].slice(0, 3) };
      continue;
    }

    const t = line.trim();

    if (!t) {
      flushParagraph();
      flushQuote();
      // A "loose" list has blank lines between items; keep it one list (and
      // one numbering) when the next real line still belongs to it.
      if (list) {
        let next = i + 1;
        while (next < lines.length && !lines[next].trim()) next += 1;
        const upcoming = lines[next];
        const continues = upcoming !== undefined && !/^\s*(```|~~~)/.test(upcoming) && (LIST_ITEM.test(upcoming) || indentOf(upcoming) >= 2);
        if (!continues) flushList();
      }
      continue;
    }

    if (/^>\s?/.test(t)) {
      flushParagraph(); flushList();
      quote.push(t.replace(/^>\s?/, ""));
      continue;
    }
    flushQuote();

    // --- display math: $$ … $$ and \[ … \] -------------------------------
    const mathFence = t === "$$" ? "$$" : t === "\\[" ? "\\]" : null;
    if (mathFence) {
      flushAll();
      const math: string[] = [];
      let closed = false;
      while (++i < lines.length) {
        if (lines[i].trim() === mathFence) { closed = true; break; }
        math.push(lines[i]);
      }
      blocks.push(closed ? { type: "math", text: math.join("\n") } : { type: "math", text: math.join("\n"), open: true });
      continue;
    }
    const inlineMath = t.match(/^\$\$([^$]+)\$\$$/) ?? t.match(/^\\\[(.+)\\\]$/);
    if (inlineMath) { flushAll(); blocks.push({ type: "math", text: inlineMath[1].trim() }); continue; }

    const image = t.match(/^!\[([^\]]*)\]\((https:\/\/[^\s)]+)\)$/);
    if (image) { flushAll(); blocks.push({ type: "image", alt: image[1], src: image[2] }); continue; }

    if (t.includes("|") && TABLE_DIVIDER.test(lines[i + 1] ?? "") && (lines[i + 1] ?? "").includes("-")) {
      flushAll();
      const rows = [tableCells(line)];
      const align = alignments(lines[i + 1]);
      i += 1;
      while (i + 1 < lines.length && lines[i + 1].includes("|") && lines[i + 1].trim()) rows.push(tableCells(lines[++i]));
      blocks.push({ type: "table", rows, align });
      continue;
    }

    // A filename label immediately before a fence is shown in the code header,
    // not duplicated as a prose paragraph.
    if (FILE_LABEL.test(t) && /^\s*(```|~~~)/.test(lines[i + 1] ?? "")) { flushAll(); continue; }

    if (RULE.test(line)) { flushAll(); blocks.push({ type: "hr" }); continue; }

    const item = line.match(LIST_ITEM);
    if (item) {
      flushParagraph();
      const indent = indentOf(item[1]);
      const ordered = item[3] !== undefined;
      if (list && indent < 2 && list.ordered !== ordered) flushList();
      if (!list) list = { ordered, items: [], indents: [] };
      // Indent stack → depth. Two or more extra spaces open a nested level.
      while (list.indents.length > 1 && indent < list.indents[list.indents.length - 1]) list.indents.pop();
      if (!list.indents.length || indent > list.indents[list.indents.length - 1] + 1) list.indents.push(indent);
      const depth = Math.min(list.indents.length - 1, (list.items[list.items.length - 1]?.depth ?? -1) + 1);
      list.indents.length = depth + 1;
      let text = item[4].trim();
      const task = text.match(/^\[( |x|X)\]\s+(.*)$/);
      if (task) text = task[2];
      list.items.push({
        text, depth, ordered,
        ...(ordered ? { number: Number(item[3]) } : {}),
        ...(task ? { task: task[1] === " " ? "open" as const : "done" as const } : {}),
      });
      continue;
    }

    // An indented line directly under a list item continues that item.
    if (list && indentOf(line) >= 2 && list.items.length) {
      const last = list.items[list.items.length - 1];
      list.items[list.items.length - 1] = { ...last, text: `${last.text}\n${t}` };
      continue;
    }
    flushList();

    const heading = t.match(HEADING);
    if (heading) { flushParagraph(); blocks.push({ type: "h", text: heading[2], level: heading[1].length }); continue; }

    paragraph.push(line);
  }

  // `open` marks a fence the stream has not closed yet.
  if (fence) { flushAll(); blocks.push({ type: "code", lang: fence.lang, filename: fence.filename, code: fence.code.join("\n"), open: true }); }
  flushAll();
  return blocks;
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
  const strikes = (outsideCode.match(/~~/g) ?? []).length;
  if (strikes % 2 === 1) out = /~~\s*$/.test(out) ? out.replace(/~~\s*$/, "") : `${out}~~`;
  return out;
}

export function sameBlock(a: Block, b: Block): boolean {
  if (a === b) return true;
  if (a.type !== b.type) return false;
  switch (a.type) {
    case "ul": case "ol": {
      const other = b as typeof a;
      return a.items.length === other.items.length && a.items.every((item, i) => {
        const next = other.items[i];
        return item.text === next.text && item.depth === next.depth && item.ordered === next.ordered && item.number === next.number && item.task === next.task;
      });
    }
    case "table": {
      const other = b as typeof a;
      return a.rows.length === other.rows.length
        && a.align.join() === other.align.join()
        && a.rows.every((row, i) => row.length === other.rows[i].length && row.every((cell, j) => cell === other.rows[i][j]));
    }
    case "image": { const other = b as typeof a; return a.src === other.src && a.alt === other.alt; }
    case "code": { const other = b as typeof a; return a.code === other.code && a.lang === other.lang && a.filename === other.filename && a.open === other.open; }
    case "h": { const other = b as typeof a; return a.text === other.text && a.level === other.level; }
    case "math": { const other = b as typeof a; return a.text === other.text && a.open === other.open; }
    case "hr": return true;
    default: return a.text === (b as typeof a).text;
  }
}
