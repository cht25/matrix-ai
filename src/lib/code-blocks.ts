import { safeAgentPath } from "@/lib/ai/agent";

export type CodeBlockView = { language: string; filename: string; code: string };
const LANGS: Record<string, string> = { js: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", py: "python", html: "html", htm: "html", css: "css", scss: "scss", json: "json", md: "markdown", sh: "bash", yml: "yaml", yaml: "yaml", sql: "sql", txt: "text" };
const EXT_LANG: Record<string, string> = { html: "html", htm: "html", css: "css", scss: "scss", js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "jsx", ts: "typescript", tsx: "tsx", json: "json", py: "python", sh: "bash", sql: "sql", yaml: "yaml", yml: "yaml", md: "markdown", txt: "text" };
export function normalizeLanguage(value: string): string { const key = value.toLowerCase().replace(/^[{.]*/, ""); return LANGS[key] ?? (/^[a-z0-9_+-]{1,24}$/.test(key) ? key : "text"); }
export function filenameForCode(language: string, index: number, explicit?: string | null): string {
  const safe = explicit ? safeAgentPath(explicit.replace(/^["'`]|["'`]$/g, "")) : null;
  if (safe) return safe;
  const ext = Object.entries(EXT_LANG).find(([, lang]) => lang === normalizeLanguage(language))?.[0] ?? "txt";
  return index === 0 ? `main.${ext}` : `snippet-${index + 1}.${ext}`;
}
export function parseFenceInfo(info: string, previousLine = "", index = 0): { language: string; filename: string } {
  const tokens = info.trim().replace(/[{}]/g, "").split(/\s+/).filter(Boolean);
  let language = "text"; let filename: string | null = null;
  for (const token of tokens) {
    const pair = token.match(/^([\w+-]+):(.+)$/);
    if (pair) { language = normalizeLanguage(pair[1]); filename = pair[2]; continue; }
    const cleaned = token.replace(/^["'`]|["'`]$/g, "");
    if (cleaned.includes(".") || cleaned.includes("/")) { const path = safeAgentPath(cleaned); if (path) { filename = path; const ext = path.split(".").pop() ?? ""; language = EXT_LANG[ext] ?? language; continue; } }
    if (language === "text") language = normalizeLanguage(cleaned);
  }
  if (!filename) { const heading = previousLine.trim().match(/^(?:\*\*|#{1,4}\s*|`)([\w./-]+\.[a-z0-9]+)(?:\*\*|`)?$/i); if (heading) filename = heading[1]; }
  if (language === "text" && filename) language = EXT_LANG[filename.split(".").pop() ?? ""] ?? "text";
  return { language, filename: filenameForCode(language, index, filename) };
}
/** Detect unfenced HTML/markup answers, including a short prose lead-in. */
export function looksLikeRawMarkup(text: string): boolean {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const value = source.trim();
  if (!value || value.includes("```")) return false;
  const lower = value.toLowerCase();
  if (lower.startsWith("<!doctype html") || lower.startsWith("<html ") || lower.startsWith("<html>")) return true;

  // Detect balanced tag-rich replies even if the model adds one sentence first.
  const tags: Array<{ name: string; closing: boolean }> = [];
  let cursor = 0;
  while ((cursor = value.indexOf("<", cursor)) >= 0) {
    const end = value.indexOf(">", cursor + 1);
    if (end < 0) break;
    let token = value.slice(cursor + 1, end).trim();
    cursor = end + 1;
    if (!token || token.startsWith("!") || token.startsWith("?")) continue;
    const closing = token.startsWith("/");
    if (closing) token = token.slice(1).trimStart();
    const name = token.split(" ")[0].split("\t")[0].split("/")[0].toLowerCase();
    if (!name || !((name[0] >= "a" && name[0] <= "z") || name.includes(":"))) continue;
    if ([...name].some((char) => !((char >= "a" && char <= "z") || (char >= "0" && char <= "9") || char === "-" || char === ":"))) continue;
    tags.push({ name, closing });
  }
  if (tags.some((tag) => tag.closing) && tags.some((tag) => !tag.closing) && tags.length >= 2) return true;

  // A standalone or incomplete HTML fragment is safer as escaped source.
  const first = value.startsWith("<") ? value.slice(1).split(" ")[0].split(">")[0].split("/")[0].toLowerCase() : "";
  const standalone = new Set(["html", "head", "body", "script", "style", "svg", "div", "main", "section", "article", "header", "footer", "nav", "form", "table", "thead", "tbody", "tr", "td", "th", "ul", "ol", "li", "p", "h1", "h2", "h3", "h4", "h5", "h6", "button", "input", "textarea", "select", "label", "a", "img", "canvas", "video", "audio", "template", "details", "summary"]);
  return standalone.has(first);
}
export type HighlightToken = { text: string; kind: "plain" | "comment" | "string" | "keyword" | "number" | "tag" | "attribute" };
const KEYWORDS = new Set("const let var function return if else for while class extends new import from export default async await try catch throw typeof instanceof interface type enum public private static void null undefined true false def elif None True False print select insert update delete where create table".split(" "));
export function highlightCode(code: string, language: string): HighlightToken[] {
  const lang = normalizeLanguage(language);
  const pattern = /(\/\*[\s\S]*?\*\/|\/\/[^\n]*|<!--[\s\S]*?-->|#[^\n]*)|("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`)|(<\/?[A-Za-z][\w:-]*|\/?>)|([A-Za-z_$][\w$-]*)(?=\s*=)|\b(\d+(?:\.\d+)?)\b|\b([A-Za-z_$][\w$]*)\b/g;
  const out: HighlightToken[] = []; let cursor = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(code))) {
    if (match.index > cursor) out.push({ text: code.slice(cursor, match.index), kind: "plain" });
    const kind: HighlightToken["kind"] = match[1] ? (lang === "python" || lang === "bash" || match[1].startsWith("//") || match[1].startsWith("/*") || match[1].startsWith("<!--") ? "comment" : "plain") : match[2] ? "string" : match[3] ? "tag" : match[4] ? "attribute" : match[5] ? "number" : KEYWORDS.has(match[6]) ? "keyword" : "plain";
    out.push({ text: match[0], kind }); cursor = pattern.lastIndex;
  }
  if (cursor < code.length) out.push({ text: code.slice(cursor), kind: "plain" });
  return out;
}
