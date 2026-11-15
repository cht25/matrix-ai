// =============================================================================
// Inline Markdown → a small AST (pure, no React).
//
// Covers what assistant replies actually contain: **bold**, *italic*,
// ~~strike~~, `code`, [links](https://…), bare URLs, <br>, and inline math
// ($…$ and \(…\)). Anything that does not parse cleanly stays literal text —
// AI output is never interpreted as HTML.
//
// Deliberately written without regex lookbehind: older mobile Safari cannot
// even parse a script that contains one.
// =============================================================================

export type InlineNode =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "math"; v: string; display?: boolean }
  | { t: "br" }
  | { t: "link"; href: string; c: InlineNode[] }
  | { t: "strong" | "em" | "del"; c: InlineNode[] };

const ESCAPABLE = "\\`*_{}[]()#+-.!|~$>";
const LINK = /\[((?:\\.|[^\]\\\n])+)\]\(\s*((?:https?:\/\/|mailto:)(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"\n]*")?\s*\)/y;
const IMAGE = /!\[((?:\\.|[^\]\\\n])*)\]\(\s*(https?:\/\/(?:[^\s()]|\([^\s()]*\))+)(?:\s+"[^"\n]*")?\s*\)/y;
const BARE_URL = /https?:\/\/[^\s<>]+/y;
const ANGLE_URL = /<((?:https?:\/\/|mailto:)[^\s<>]+)>/y;
const BREAK = /<br\s*\/?>/iy;

const isWord = (ch: string | undefined) => Boolean(ch) && /[A-Za-z0-9]/.test(ch as string);
const isSpace = (ch: string | undefined) => ch === undefined || /\s/.test(ch);

function matchAt(pattern: RegExp, src: string, index: number): RegExpExecArray | null {
  pattern.lastIndex = index;
  return pattern.exec(src);
}

/** Length of the run of `ch` starting at `index`. */
function runLength(src: string, index: number, ch: string): number {
  let n = 0;
  while (src[index + n] === ch) n += 1;
  return n;
}

/**
 * Closing delimiter for emphasis opened with a run of `len` × `delim`.
 * Returns the index where the closing run starts, or -1.
 */
function findCloser(src: string, from: number, delim: string, len: number): number {
  let j = from;
  while (j < src.length) {
    const k = src.indexOf(delim, j);
    if (k < 0) return -1;
    const run = runLength(src, k, delim);
    if (src[k - 1] === "\\") { j = k + run; continue; }
    const before = src[k - 1];
    const after = src[k + run];
    // "_" only closes at a real word boundary: `__init__.py` and
    // `snake_case_name` are identifiers, not emphasis.
    const closes = !isSpace(before) && (delim !== "_" || (!isWord(after) && !(after !== undefined && !isSpace(after) && isWord(src[k + run + 1]))));
    // A longer run (***) can close a shorter opener with its last characters;
    // a run of two never closes a single (it belongs to an inner **bold**).
    if (closes && k > from && (run === len || (run === 3 && len < 3))) return k + (run - len);
    j = k + run;
  }
  return -1;
}

/** Bare-URL autolinks should not swallow the sentence punctuation after them. */
function trimUrl(url: string): string {
  let out = url;
  for (;;) {
    const last = out[out.length - 1];
    if (!last) break;
    if (".,;:!?'\"*_~".includes(last)) { out = out.slice(0, -1); continue; }
    if (last === ")" && (out.match(/\(/g) ?? []).length < (out.match(/\)/g) ?? []).length) { out = out.slice(0, -1); continue; }
    if (last === "]" && !out.includes("[")) { out = out.slice(0, -1); continue; }
    break;
  }
  return out;
}

/** `$5 and $10` is money, `$x^2$` is math. */
function looksLikeMath(content: string): boolean {
  if (!content || isSpace(content[0]) || isSpace(content[content.length - 1])) return false;
  if (/^[\d.,\s%-]+$/.test(content)) return false;
  return content.length <= 400;
}

export function parseInline(src: string, depth = 0): InlineNode[] {
  const out: InlineNode[] = [];
  let buffer = "";
  const flush = () => { if (buffer) { out.push({ t: "text", v: buffer }); buffer = ""; } };
  const nested = (text: string) => (depth >= 6 ? [{ t: "text", v: text } as InlineNode] : parseInline(text, depth + 1));

  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    const prev = i > 0 ? src[i - 1] : undefined;

    if (ch === "\\" && i + 1 < src.length) {
      const next = src[i + 1];
      if (next === "(") {
        const end = src.indexOf("\\)", i + 2);
        if (end > i + 2) { flush(); out.push({ t: "math", v: src.slice(i + 2, end).trim() }); i = end + 2; continue; }
      }
      if (ESCAPABLE.includes(next)) { buffer += next; i += 2; continue; }
    }

    if (ch === "`") {
      const run = runLength(src, i, "`");
      // The closing run must be exactly as long as the opening one.
      let end = -1;
      for (let j = i + run; j < src.length;) {
        const k = src.indexOf("`", j);
        if (k < 0) break;
        const length = runLength(src, k, "`");
        if (length === run) { end = k; break; }
        j = k + length;
      }
      if (end > i + run) {
        let code = src.slice(i + run, end);
        if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim()) code = code.slice(1, -1);
        flush(); out.push({ t: "code", v: code }); i = end + run; continue;
      }
      buffer += "`".repeat(run); i += run; continue;
    }

    if (ch === "$" && prev !== "\\" && !isWord(prev)) {
      const display = src[i + 1] === "$";
      const open = display ? 2 : 1;
      const closer = display ? "$$" : "$";
      let end = src.indexOf(closer, i + open);
      while (end >= 0 && src[end - 1] === "\\") end = src.indexOf(closer, end + 1);
      const lineEnd = src.indexOf("\n", i);
      if (end > i + open && (display || lineEnd < 0 || end < lineEnd)) {
        const content = src.slice(i + open, end);
        const after = src[end + open];
        if (looksLikeMath(display ? content.trim() : content) && (display || !/[\d$]/.test(after ?? ""))) {
          flush(); out.push({ t: "math", v: content.trim(), ...(display ? { display: true } : {}) }); i = end + open; continue;
        }
      }
    }

    if (ch === "!" && src[i + 1] === "[") {
      // An inline image is offered as a link — third-party images are never
      // fetched automatically (that would disclose the reader's IP).
      const image = matchAt(IMAGE, src, i);
      if (image) { flush(); out.push({ t: "link", href: image[2], c: [{ t: "text", v: image[1] || "image" }] }); i += image[0].length; continue; }
    }

    if (ch === "[") {
      const link = matchAt(LINK, src, i);
      if (link) { flush(); out.push({ t: "link", href: link[2], c: nested(link[1]) }); i += link[0].length; continue; }
    }

    if (ch === "<") {
      const br = matchAt(BREAK, src, i);
      if (br) { flush(); out.push({ t: "br" }); i += br[0].length; continue; }
      const angle = matchAt(ANGLE_URL, src, i);
      if (angle) { flush(); out.push({ t: "link", href: angle[1], c: [{ t: "text", v: angle[1].replace(/^mailto:/, "") }] }); i += angle[0].length; continue; }
    }

    if ((ch === "*" || ch === "_") && prev !== "\\") {
      const run = Math.min(3, runLength(src, i, ch));
      const after = src[i + run];
      const canOpen = !isSpace(after) && !isWord(prev) && prev !== ch;
      if (canOpen) {
        const end = findCloser(src, i + run, ch, run);
        if (end > i + run) {
          const inner = src.slice(i + run, end);
          if (inner.trim() && !(run === 1 && inner.includes("\n\n"))) {
            flush();
            const children = nested(inner);
            if (run === 3) out.push({ t: "strong", c: [{ t: "em", c: children }] });
            else out.push({ t: run === 2 ? "strong" : "em", c: children });
            i = end + run; continue;
          }
        }
      }
      buffer += ch.repeat(runLength(src, i, ch)); i += runLength(src, i, ch); continue;
    }

    if (ch === "~" && src[i + 1] === "~" && !isSpace(src[i + 2])) {
      const end = src.indexOf("~~", i + 2);
      if (end > i + 2 && !isSpace(src[end - 1])) { flush(); out.push({ t: "del", c: nested(src.slice(i + 2, end)) }); i = end + 2; continue; }
    }

    if (ch === "h" && !isWord(prev) && (src.startsWith("http://", i) || src.startsWith("https://", i))) {
      const url = matchAt(BARE_URL, src, i);
      const href = url ? trimUrl(url[0]) : "";
      if (href.length > 10) { flush(); out.push({ t: "link", href, c: [{ t: "text", v: href }] }); i += href.length; continue; }
    }

    buffer += ch;
    i += 1;
  }
  flush();
  return out;
}

/** Plain text of an inline string — used for accessible labels and copies. */
export function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    switch (node.t) {
      case "text": case "code": case "math": return node.v;
      case "br": return "\n";
      default: return inlineText(node.c);
    }
  }).join("");
}
