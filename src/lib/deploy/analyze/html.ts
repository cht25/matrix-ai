// HTML tokenizer, structural analysis and deterministic repair.
//
// The previous validator matched tags with one regular expression over the
// whole document, so it read `<` inside scripts, styles and comments as markup
// and reported tags HTML allows to stay open. This module tokenizes the
// document the way a browser does (comments, raw-text elements, quoted
// attributes, void and optional-end elements) and can rewrite a broken
// document into a balanced one without a model.

export type HtmlIssueCode =
  | "html-unclosed"
  | "html-stray-close"
  | "html-mismatch"
  | "html-unterminated-raw"
  | "html-unterminated-comment"
  | "html-unterminated-tag"
  | "html-document-open";

export type HtmlIssue = { line: number; message: string; code: HtmlIssueCode; severity: "error" | "warning" };

export type HtmlToken =
  | { type: "text" | "comment" | "doctype"; start: number; end: number; unterminated?: boolean }
  | { type: "open"; start: number; end: number; name: string; attrs: string; selfClosing: boolean; unterminated?: boolean }
  | { type: "close"; start: number; end: number; name: string }
  | { type: "raw"; start: number; end: number; name: string; attrs: string; unterminated: boolean; openLine: number };

export type InlineBlock = { kind: "script" | "style" | "json"; content: string; line: number; module: boolean; start: number; end: number };

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
/** Elements whose end tag HTML allows authors to omit. */
const OPTIONAL_END = new Set(["p", "li", "dt", "dd", "option", "optgroup", "tr", "td", "th", "thead", "tbody", "tfoot", "colgroup", "caption", "rt", "rp"]);
/** Document-level elements: omitting the end tag is valid HTML, reported as a warning. */
const DOCUMENT_LEVEL = new Set(["html", "head", "body"]);
const CLOSES_P = new Set([
  "address", "article", "aside", "blockquote", "details", "div", "dl", "fieldset", "figcaption", "figure", "footer", "form",
  "h1", "h2", "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "main", "menu", "nav", "ol", "p", "pre", "section", "table", "ul",
]);
/** opening tag → open elements it implicitly closes when they are on top of the stack. */
const IMPLIED_CLOSE: Record<string, string[]> = {
  li: ["li"],
  dt: ["dt", "dd"],
  dd: ["dt", "dd"],
  option: ["option"],
  optgroup: ["option", "optgroup"],
  tr: ["tr", "td", "th", "caption", "colgroup"],
  td: ["td", "th"],
  th: ["td", "th"],
  thead: ["tbody", "tfoot", "tr", "td", "th", "caption", "colgroup"],
  tbody: ["thead", "tbody", "tfoot", "tr", "td", "th", "caption", "colgroup"],
  tfoot: ["thead", "tbody", "tr", "td", "th", "caption", "colgroup"],
  body: ["head"],
  rt: ["rt", "rp"],
  rp: ["rt", "rp"],
};

export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i += 1) if (text.charCodeAt(i) === 10) line += 1;
  return line;
}

/** End index (exclusive) of a tag starting at `from`, honouring quoted attributes. -1 when unterminated. */
function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i += 1) {
    const ch = html[i];
    if (quote) {
      if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      // Only an attribute value opens a quote: `=` must precede it.
      let back = i - 1;
      while (back > from && /\s/.test(html[back])) back -= 1;
      if (html[back] === "=") quote = ch;
    } else if (ch === ">") return i + 1;
    else if (ch === "<" && i > from) {
      // A new tag began before this one ended: the author forgot `>`.
      return -1;
    }
  }
  if (quote) {
    // An unbalanced quote swallowed the rest of the file; fall back to the first `>`.
    const plain = html.indexOf(">", from);
    return plain === -1 ? -1 : plain + 1;
  }
  return -1;
}

export function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = [];
  let i = 0;
  let textStart = 0;
  const flushText = (end: number) => {
    if (end > textStart) tokens.push({ type: "text", start: textStart, end });
  };
  while (i < html.length) {
    const lt = html.indexOf("<", i);
    if (lt === -1) break;
    const next = html[lt + 1] ?? "";
    if (html.startsWith("<!--", lt)) {
      flushText(lt);
      const close = html.indexOf("-->", lt + 4);
      const end = close === -1 ? html.length : close + 3;
      tokens.push({ type: "comment", start: lt, end, unterminated: close === -1 });
      i = textStart = end;
      continue;
    }
    if (next === "!" || next === "?") {
      flushText(lt);
      const close = html.indexOf(">", lt);
      const end = close === -1 ? html.length : close + 1;
      tokens.push({ type: "doctype", start: lt, end, unterminated: close === -1 });
      i = textStart = end;
      continue;
    }
    const closing = next === "/";
    const nameMatch = /^[a-zA-Z][a-zA-Z0-9:-]*/.exec(html.slice(lt + (closing ? 2 : 1), lt + 80));
    if (!nameMatch) {
      i = lt + 1; // a bare `<` is text
      continue;
    }
    flushText(lt);
    const name = nameMatch[0].toLowerCase();
    const end = tagEnd(html, lt + 1);
    if (end === -1) {
      // Unterminated tag: it runs to the next `<` (or the end of the file).
      const stop = html.indexOf("<", lt + 1);
      const until = stop === -1 ? html.length : stop;
      if (closing) tokens.push({ type: "close", start: lt, end: until, name });
      else tokens.push({ type: "open", start: lt, end: until, name, attrs: "", selfClosing: false, unterminated: true });
      i = textStart = until;
      continue;
    }
    if (closing) {
      tokens.push({ type: "close", start: lt, end, name });
      i = textStart = end;
      continue;
    }
    const inner = html.slice(lt + 1 + nameMatch[0].length, end - 1);
    const selfClosing = /\/\s*$/.test(inner);
    const attrs = selfClosing ? inner.replace(/\/\s*$/, "") : inner;
    tokens.push({ type: "open", start: lt, end, name, attrs, selfClosing });
    i = textStart = end;
    if (RAW_TEXT.has(name) && !selfClosing) {
      const closeRe = new RegExp(`</${name}\\s*>`, "i");
      const rest = html.slice(end);
      const found = closeRe.exec(rest);
      const rawEnd = found ? end + found.index : html.length;
      tokens.push({ type: "raw", start: end, end: rawEnd, name, attrs, unterminated: !found, openLine: lineOf(html, lt) });
      if (found) tokens.push({ type: "close", start: rawEnd, end: rawEnd + found[0].length, name });
      i = textStart = found ? rawEnd + found[0].length : html.length;
    }
  }
  flushText(html.length);
  return tokens;
}

function typeAttr(attrs: string): string {
  return (/\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1] ?? "").toLowerCase();
}

/** Inline `<script>` / `<style>` bodies, for the JavaScript and CSS parsers. */
export function inlineBlocks(html: string): InlineBlock[] {
  const out: InlineBlock[] = [];
  for (const token of tokenizeHtml(html)) {
    if (token.type !== "raw" || !html.slice(token.start, token.end).trim()) continue;
    const content = html.slice(token.start, token.end);
    const line = lineOf(html, token.start);
    if (token.name === "style") out.push({ kind: "style", content, line, module: false, start: token.start, end: token.end });
    if (token.name !== "script" || /\bsrc\s*=/i.test(token.attrs)) continue;
    const type = typeAttr(token.attrs);
    if (!type || type === "module" || /^(?:text|application)\/(?:java|ecma)script$/.test(type)) out.push({ kind: "script", content, line, module: type === "module", start: token.start, end: token.end });
    else if (/json$/.test(type) && type !== "importmap") out.push({ kind: "json", content, line, module: false, start: token.start, end: token.end });
  }
  return out;
}

type Open = { name: string; line: number };

function impliedPop(stack: Open[], opening: string): void {
  const closes = IMPLIED_CLOSE[opening];
  if (closes) while (stack.length && closes.includes(stack[stack.length - 1].name)) stack.pop();
  if (CLOSES_P.has(opening) && stack.length && stack[stack.length - 1].name === "p") stack.pop();
}

/** Structural problems of one document, each with the line it starts on. */
export function analyzeHtml(html: string): HtmlIssue[] {
  const issues: HtmlIssue[] = [];
  const stack: Open[] = [];
  for (const token of tokenizeHtml(html)) {
    const line = lineOf(html, token.start);
    if (token.type === "comment" && token.unterminated) {
      issues.push({ line, code: "html-unterminated-comment", severity: "error", message: "A comment opened with <!-- is never closed with -->, so the rest of the page is hidden." });
    } else if (token.type === "raw" && token.unterminated) {
      issues.push({ line: token.openLine, code: "html-unterminated-raw", severity: "error", message: `<${token.name}> opened here has no </${token.name}>, so everything after it is treated as ${token.name === "script" ? "JavaScript" : token.name === "style" ? "CSS" : "text"}.` });
    } else if (token.type === "open") {
      if (token.unterminated) {
        issues.push({ line, code: "html-unterminated-tag", severity: "error", message: `<${token.name} is missing its closing ">".` });
        continue;
      }
      impliedPop(stack, token.name);
      if (VOID.has(token.name) || token.selfClosing || RAW_TEXT.has(token.name)) continue;
      stack.push({ name: token.name, line });
    } else if (token.type === "close") {
      if (VOID.has(token.name) || RAW_TEXT.has(token.name)) continue;
      const index = stack.map((item) => item.name).lastIndexOf(token.name);
      if (index === -1) {
        issues.push({ line, code: "html-stray-close", severity: "error", message: `</${token.name}> has no matching opening tag.` });
        continue;
      }
      for (const skipped of stack.slice(index + 1)) {
        if (OPTIONAL_END.has(skipped.name)) continue;
        issues.push({ line: skipped.line, code: "html-mismatch", severity: "error", message: `<${skipped.name}> opened here is never closed (</${token.name}> on line ${line} closes its parent first).` });
      }
      stack.length = index;
    }
  }
  for (const open of stack) {
    if (OPTIONAL_END.has(open.name)) continue;
    if (DOCUMENT_LEVEL.has(open.name)) {
      issues.push({ line: open.line, code: "html-document-open", severity: "warning", message: `<${open.name}> has no closing </${open.name}> tag.` });
    } else {
      issues.push({ line: open.line, code: "html-unclosed", severity: "error", message: `<${open.name}> opened here is never closed.` });
    }
  }
  return issues;
}

export type HtmlRepair = { content: string; fixes: string[]; changed: boolean };

/**
 * Rewrite a document so every element is closed in the right order.
 * Only structure is touched: text, attributes, scripts and styles are copied
 * byte for byte. Anything this cannot decide safely is left for the model.
 */
export function repairHtml(html: string): HtmlRepair {
  // A document with nothing to report is returned byte for byte.
  if (!analyzeHtml(html).length) return { content: html, fixes: [], changed: false };
  const fixes: string[] = [];
  const out: string[] = [];
  const stack: Open[] = [];
  const tokens = tokenizeHtml(html);
  const closeDown = (toIndex: number, reason: string) => {
    for (let i = stack.length - 1; i >= toIndex; i -= 1) {
      const item = stack[i];
      if (OPTIONAL_END.has(item.name)) continue; // HTML closes these implicitly
      out.push(`</${item.name}>`);
      fixes.push(`Closed <${item.name}> from line ${item.line}${reason}.`);
    }
    stack.length = toIndex;
  };
  for (let t = 0; t < tokens.length; t += 1) {
    const token = tokens[t];
    const source = html.slice(token.start, token.end);
    const line = lineOf(html, token.start);
    if (token.type === "comment") {
      out.push(source);
      if (token.unterminated) {
        out.push("-->");
        fixes.push(`Closed the comment opened on line ${line}.`);
      }
    } else if (token.type === "doctype" || token.type === "text") {
      out.push(token.type === "doctype" && token.unterminated ? `${source}>` : source);
    } else if (token.type === "raw") {
      if (!token.unterminated) {
        out.push(source);
        continue;
      }
      // The element swallowed the rest of the file. If the page's own closing
      // tags are inside it, the element was meant to end before them.
      const tail = /(?:\s*<\/[a-zA-Z][a-zA-Z0-9]*\s*>)+\s*$/.exec(source);
      const body = tail ? source.slice(0, tail.index) : source;
      out.push(body.replace(/\s*$/, "\n"), `</${token.name}>`);
      fixes.push(`Closed <${token.name}> opened on line ${token.openLine}.`);
      if (tail) {
        // Re-tokenize what follows as markup.
        const rest = repairTail(source.slice(tail.index), stack, out, fixes);
        void rest;
      }
    } else if (token.type === "open") {
      if (token.unterminated) {
        const next = tokens[t + 1];
        if (!next) {
          fixes.push(`Removed the incomplete <${token.name} tag at the end of the file (line ${line}).`);
          continue;
        }
        out.push(`${source.replace(/\s+$/, "")}>`);
        fixes.push(`Added the missing ">" to <${token.name} on line ${line}.`);
      } else out.push(source);
      impliedPop(stack, token.name);
      if (VOID.has(token.name) || token.selfClosing || RAW_TEXT.has(token.name)) continue;
      stack.push({ name: token.name, line });
    } else if (token.type === "close") {
      if (VOID.has(token.name)) {
        fixes.push(`Removed </${token.name}> on line ${line}: <${token.name}> never takes a closing tag.`);
        continue;
      }
      if (RAW_TEXT.has(token.name)) {
        const previous = tokens[t - 1];
        if (previous?.type === "raw" || (previous?.type === "open" && previous.name === token.name)) out.push(`</${token.name}>`);
        else fixes.push(`Removed </${token.name}> on line ${line}: it has no opening tag.`);
        continue;
      }
      const index = stack.map((item) => item.name).lastIndexOf(token.name);
      if (index === -1) {
        fixes.push(`Removed </${token.name}> on line ${line}: it has no opening tag.`);
        continue;
      }
      closeDown(index + 1, ` before </${token.name}> on line ${line}`);
      stack.pop();
      out.push(`</${token.name}>`);
    }
  }
  if (stack.length) {
    if (out.length && !/\n$/.test(out[out.length - 1])) out.push("\n");
    closeDown(0, " at the end of the file");
    out.push("\n");
  }
  let content = out.join("");
  if (/<(?:html|head|body)\b/i.test(content) && !/^\s*<!doctype/i.test(content)) {
    content = `<!DOCTYPE html>\n${content}`;
    fixes.push("Added <!DOCTYPE html>.");
  }
  const changed = content !== html;
  return { content: changed ? content : html, fixes: changed ? fixes : [], changed };
}

/** Markup that followed an unterminated raw-text element: closers only matter. */
function repairTail(tail: string, stack: Open[], out: string[], fixes: string[]): void {
  out.push("\n");
  for (const item of tokenizeHtml(tail)) {
    if (item.type !== "close") continue;
    const token = item as Extract<HtmlToken, { type: "close" }>;
    const index = stack.map((item) => item.name).lastIndexOf(token.name);
    if (index === -1) continue;
    for (let i = stack.length - 1; i > index; i -= 1) {
      if (OPTIONAL_END.has(stack[i].name)) continue;
      out.push(`</${stack[i].name}>`);
      fixes.push(`Closed <${stack[i].name}> from line ${stack[i].line} before </${token.name}>.`);
    }
    stack.length = index;
    out.push(`</${token.name}>\n`);
  }
}
