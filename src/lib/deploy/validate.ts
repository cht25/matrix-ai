// =============================================================================
// MATRIX build validation (§14)
//
// Real, local, deterministic checks that run before anything is published:
//
//   Dependencies   manifests parse, no unresolvable local dependency
//   Syntax         HTML tag balance, JS/CSS bracket balance, JSON parse
//   Build          the result of the actual bundling step (passed in)
//   Routes         every internal page link resolves to a project file
//   Assets         every local src/href/url() reference exists and is non-empty
//
// A check reports "skipped" when this hosting environment genuinely cannot run
// it (TypeScript/JSX compilation, npm install, a real browser test…). Skipped is
// never rendered as a pass — the product must not imply work that did not happen.
//
// Pure module: no network, no Firestore, no React. Fully unit tested.
// =============================================================================

import type { ProjectFile } from "@/lib/projects/paths";
import { PROJECT_LIMITS, isImagePath } from "@/lib/projects/paths";

export type CheckStatus = "passed" | "failed" | "skipped";

export type BuildIssue = {
  path: string;
  line?: number;
  message: string;
  severity: "error" | "warning";
};

export type BuildCheckId = "dependencies" | "syntax" | "build" | "routes" | "assets";

export type BuildCheck = {
  id: BuildCheckId;
  label: string;
  status: CheckStatus;
  /** One-line outcome for the UI. */
  message: string;
  issues: BuildIssue[];
};

export type BuildReport = {
  checks: BuildCheck[];
  blocking: boolean;
  errors: number;
  warnings: number;
  summary: string;
};

export const BUILD_CHECK_LABELS: Record<BuildCheckId, string> = {
  dependencies: "Dependencies",
  syntax: "Syntax",
  build: "Build",
  routes: "Routes",
  assets: "Assets",
};

/** The bundling outcome from the pipeline (`buildPublishedFiles`). */
export type BundleOutcome =
  | { ran: false; reason: string }
  | {
      ran: true;
      ok: boolean;
      error?: string;
      outFileCount?: number;
      inlinedRefs?: number;
      standalone?: string | null;
    };

const VOID_TAGS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr", "area", "keygen",
]);

const FRAMEWORK_DEPS = [
  "react", "react-dom", "next", "vite", "@vitejs/plugin-react", "vue", "svelte",
  "nuxt", "astro", "@angular/core", "webpack", "esbuild", "tailwindcss",
];

// ---------------------------------------------------------------------------
// Small scanners
// ---------------------------------------------------------------------------

export function lineAt(text: string, index: number): number {
  let line = 1;
  const limit = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < limit; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * Blank out string / template / comment / regex bodies so bracket counting and
 * brace balance are not fooled by their contents. Length and newlines are kept
 * so offsets (and therefore line numbers) stay valid.
 */
export function neutralizeCode(code: string): string {
  const out: string[] = new Array(code.length);
  let i = 0;
  const fill = (from: number, to: number) => {
    for (let k = from; k < to && k < code.length; k++) out[k] = code[k] === "\n" ? "\n" : " ";
  };
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    if (ch === "/" && next === "/") {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? code.length : end;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? code.length : end + 2;
      fill(i, stop);
      i = stop;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      let j = i + 1;
      let closed = false;
      while (j < code.length) {
        if (code[j] === "\\") {
          j += 2;
          continue;
        }
        if (code[j] === ch) {
          closed = true;
          j++;
          break;
        }
        // Unterminated single/double quoted strings end at the line break.
        if (code[j] === "\n" && ch !== "`") break;
        // Template literals can nest ${ ... } — leave the body scan naive but
        // balanced by treating the closing backtick only.
        j++;
      }
      if (ch !== "`" && !closed) {
        // Unterminated string: report later via issues; blank to end of line.
        const end = code.indexOf("\n", i);
        fill(i, end === -1 ? code.length : end);
        i = end === -1 ? code.length : end;
        continue;
      }
      fill(i, j);
      i = j;
      continue;
    }
    if (ch === "/" && regexAllowedHere(code, i)) {
      let j = i + 1;
      let inClass = false;
      let closed = false;
      while (j < code.length) {
        const c = code[j];
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) {
          closed = true;
          j++;
          break;
        } else if (c === "\n") break;
        j++;
      }
      if (closed) {
        while (j < code.length && /[a-z]/i.test(code[j])) j++;
        fill(i, j);
        i = j;
        continue;
      }
    }
    out[i] = ch;
    i++;
  }
  return out.join("");
}

function regexAllowedHere(code: string, index: number): boolean {
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i];
    if (/\s/.test(c)) continue;
    return /[([{,;:=!&|?+\-*%~^]/.test(c) || /\breturn$|\btypeof$|\bcase$/.test(code.slice(Math.max(0, i - 8), i + 1));
  }
  return true;
}

type Balance = { unbalanced: Array<{ open: string; close: string; count: number }>; stray: number };

export function bracketBalance(code: string): Balance {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const closers: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  const stack: Array<{ char: string; index: number }> = [];
  const counts: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
  let stray = 0;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (pairs[ch]) {
      stack.push({ char: ch, index: i });
      counts[ch] = (counts[ch] ?? 0) + 1;
      continue;
    }
    if (closers[ch]) {
      const top = stack[stack.length - 1];
      if (top && top.char === closers[ch]) stack.pop();
      else stray++;
    }
  }
  const leftovers: Record<string, number> = { "{": 0, "(": 0, "[": 0 };
  for (const item of stack) leftovers[item.char] = (leftovers[item.char] ?? 0) + 1;
  const unbalanced = Object.entries(leftovers)
    .filter(([, count]) => count > 0)
    .map(([open, count]) => ({ open, close: pairs[open], count }));
  return { unbalanced, stray };
}

/** HTML tag stack check: returns unclosed tags and unmatched closers with lines. */
export function htmlTagIssues(html: string): BuildIssue[] {
  const issues: BuildIssue[] = [];
  const stack: Array<{ tag: string; line: number }> = [];
  const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
  let match: RegExpExecArray | null;
  while ((match = tagRe.exec(html)) !== null) {
    const closing = match[1] === "/";
    const tag = match[2].toLowerCase();
    const selfClosed = /\/\s*$/.test(match[3] ?? "");
    const line = lineAt(html, match.index);
    if (VOID_TAGS.has(tag) || selfClosed) continue;
    if (!closing) {
      stack.push({ tag, line });
      continue;
    }
    const top = stack[stack.length - 1];
    if (top && top.tag === tag) stack.pop();
    else if (top) {
      issues.push({ path: "", line, message: `</${tag}> closes <${top.tag}> opened on line ${top.line}.`, severity: "error" });
      // Recover by popping until the matching tag is found (or the stack empties).
      const idx = [...stack].map((s) => s.tag).lastIndexOf(tag);
      if (idx >= 0) stack.length = idx;
    } else {
      issues.push({ path: "", line, message: `</${tag}> has no matching opening tag.`, severity: "error" });
    }
  }
  for (const open of stack.slice(0, 4)) {
    issues.push({ path: "", line: open.line, message: `<${open.tag}> opened here is never closed.`, severity: "error" });
  }
  return issues;
}

function isRemote(ref: string): boolean {
  return (
    !ref ||
    /^(?:https?:)?\/\//i.test(ref) ||
    /^(?:data|blob|mailto|tel|javascript|about):/i.test(ref) ||
    ref.startsWith("#")
  );
}

function normalizeRef(ref: string): string {
  return ref.replace(/^[./]+/, "").split(/[?#]/)[0];
}

/** All local references of a given kind inside an HTML document. */
export function htmlLocalRefs(html: string, attrs: string[]): Array<{ ref: string; line: number; raw: string }> {
  const found: Array<{ ref: string; line: number; raw: string }> = [];
  for (const attr of attrs) {
    const re = new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, "gi");
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
      const raw = match[1];
      if (isRemote(raw)) continue;
      found.push({ ref: normalizeRef(raw), line: lineAt(html, match.index), raw });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// File helpers
// ---------------------------------------------------------------------------

function pathSet(files: ProjectFile[]): Set<string> {
  const set = new Set<string>();
  for (const file of files) {
    const clean = file.path.replace(/^[./]+/, "").toLowerCase();
    set.add(clean);
    set.add(clean.replace(/\.html?$/, ""));
    if (/(^|\/)index\.html?$/i.test(clean)) set.add(clean.replace(/\/index\.html?$/i, ""));
  }
  return set;
}

function resolveLocal(files: ProjectFile[], paths: Set<string>, ref: string, fromPath: string): ProjectFile | null {
  if (!ref) return null;
  const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/") + 1) : "";
  const candidates = [ref, dir + ref, ref.replace(/^\//, "")];
  for (const candidate of candidates) {
    const hit = files.find((file) => file.path.replace(/^[./]+/, "").toLowerCase() === candidate.toLowerCase());
    if (hit) return hit;
  }
  const base = ref.split("/").pop() ?? ref;
  const byName = files.find((file) => (file.path.split("/").pop() ?? "").toLowerCase() === base.toLowerCase());
  if (byName) return byName;
  const key = ref.toLowerCase().replace(/\.html?$/, "");
  return paths.has(key) ? files.find((file) => file.path.toLowerCase().replace(/\.html?$/, "") === key) ?? null : null;
}

const HTML_RE = /\.html?$/i;
const JS_RE = /\.(m?js|cjs)$/i;
const JSON_RE = /\.jsonc?$/i;
const CSS_RE = /\.(css|scss|less)$/i;
/** Syntax this checker cannot parse without a compiler (never a fake pass). */
const UNPARSABLE_RE = /\.(tsx|jsx|vue|svelte|ts|mdx)$/i;

// ---------------------------------------------------------------------------
// Main entry
// ---------------------------------------------------------------------------

export type ValidateOptions = {
  /** Result of the real bundling step, when the pipeline ran one. */
  bundle?: BundleOutcome;
  envPublic?: Record<string, string>;
};

export function validateProject(files: ProjectFile[], options: ValidateOptions = {}): BuildReport {
  const paths = pathSet(files);
  const text = files.filter((file) => file.encoding !== "base64");
  const html = text.filter((file) => HTML_RE.test(file.path));
  const checks: BuildCheck[] = [
    dependenciesCheck(text, files),
    syntaxCheck(text),
    buildCheck(html, files, options.bundle),
    routesCheck(html, files, paths),
    assetsCheck(text, files, paths),
  ];
  const errors = checks.reduce((sum, check) => sum + check.issues.filter((issue) => issue.severity === "error").length, 0);
  const warnings = checks.reduce((sum, check) => sum + check.issues.filter((issue) => issue.severity === "warning").length, 0);
  const blocking = checks.some((check) => check.status === "failed");
  return {
    checks,
    blocking,
    errors,
    warnings,
    summary: blocking
      ? `${errors} problem${errors === 1 ? "" : "s"} must be fixed before publishing.`
      : `All supported checks passed${warnings ? ` with ${warnings} warning${warnings === 1 ? "" : "s"}` : ""}.`,
  };
}

function dependenciesCheck(text: ProjectFile[], files: ProjectFile[]): BuildCheck {
  const issues: BuildIssue[] = [];
  const manifests = text.filter((file) => /(^|\/)package\.json$/i.test(file.path));
  if (!manifests.length) {
    return {
      id: "dependencies",
      label: BUILD_CHECK_LABELS.dependencies,
      status: "passed",
      message: "No package manifest — a static project needs no install step.",
      issues,
    };
  }
  let needsBundler = false;
  for (const manifest of manifests) {
    let parsed: { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } = {};
    try {
      parsed = (JSON.parse(stripJsonComments(manifest.content)) ?? {}) as {
        dependencies?: Record<string, string>;
        devDependencies?: Record<string, string>;
      };
    } catch (error) {
      issues.push({
        path: manifest.path,
        line: jsonErrorLine(manifest.content, error),
        message: `${manifest.path} is not valid JSON.`,
        severity: "error",
      });
      continue;
    }
    const deps = { ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) };
    for (const [name, range] of Object.entries(deps)) {
      if (typeof range !== "string") {
        issues.push({ path: manifest.path, message: `"${name}" has a dependency spec that is not a version string.`, severity: "error" });
        continue;
      }
      if (range.startsWith("file:") || range.startsWith("link:")) {
        const target = normalizeRef(range.replace(/^(?:file|link):/, ""));
        const hit = resolveLocal(files, pathSet(files), target, manifest.path);
        if (!hit) issues.push({ path: manifest.path, message: `"${name}" points at ${target}, which is not in the project.`, severity: "error" });
      }
      if (FRAMEWORK_DEPS.includes(name)) needsBundler = true;
    }
  }
  const hasStaticEntry = htmlEntry(files);
  if (needsBundler && !hasStaticEntry) {
    issues.push({
      path: "package.json",
      message: "This project needs a bundler (React/Vite/Next) and MATRIX hosting serves built static files, so nothing was installed or compiled. Ask MATRIX for a self-contained static build (index.html + CSS + JS) instead.",
      severity: "error",
    });
    return { id: "dependencies", label: BUILD_CHECK_LABELS.dependencies, status: "failed", message: "A bundler build is required but is not supported by this host.", issues };
  }
  const failed = issues.some((issue) => issue.severity === "error");
  if (failed) return { id: "dependencies", label: BUILD_CHECK_LABELS.dependencies, status: "failed", message: "Dependency manifest problems found.", issues };
  return {
    id: "dependencies",
    label: BUILD_CHECK_LABELS.dependencies,
    status: needsBundler ? "skipped" : "passed",
    message: needsBundler
      ? "Manifest parsed. Framework packages are referenced from a CDN in the built page — no install runs on this host."
      : "No local dependency could not be resolved.",
    issues,
  };
}

function syntaxCheck(text: ProjectFile[]): BuildCheck {
  const issues: BuildIssue[] = [];
  const skipped: string[] = [];
  for (const file of text) {
    const content = file.content ?? "";
    if (UNPARSABLE_RE.test(file.path)) {
      skipped.push(file.path);
      continue;
    }
    if (HTML_RE.test(file.path)) {
      for (const issue of htmlTagIssues(content)) issues.push({ ...issue, path: file.path });
      continue;
    }
    if (JSON_RE.test(file.path)) {
      try {
        JSON.parse(stripJsonComments(content));
      } catch (error) {
        issues.push({ path: file.path, line: jsonErrorLine(content, error), message: `${file.path} is not valid JSON (${jsonErrorMessage(error)}).`, severity: "error" });
      }
      continue;
    }
    if (JS_RE.test(file.path)) {
      const clean = neutralizeCode(content);
      const balance = bracketBalance(clean);
      for (const item of balance.unbalanced) {
        issues.push({
          path: file.path,
          message: `${item.count} ${labelFor(item.open)} never closed — unexpected end of ${file.path}.`,
          severity: "error",
        });
      }
      if (balance.stray) {
        issues.push({
          path: file.path,
          line: firstStrayLine(clean),
          message: `${balance.stray} unmatched closing ${balance.stray === 1 ? "bracket" : "brackets"} — unexpected token.`,
          severity: "error",
        });
      }
      const smart = /[\u201c\u201d\u2018\u2019]/.exec(clean);
      if (smart) {
        issues.push({
          path: file.path,
          line: lineAt(content, smart.index),
          message: "Smart quotes found in code — use straight quotes \" ' instead.",
          severity: "error",
        });
      }
      continue;
    }
    if (CSS_RE.test(file.path)) {
      const balance = bracketBalance(neutralizeCode(content));
      if (balance.unbalanced.some((item) => item.open === "{") || balance.stray) {
        issues.push({ path: file.path, message: "CSS braces are unbalanced.", severity: "error" });
      }
    }
  }
  const errors = issues.filter((issue) => issue.severity === "error").length;
  if (errors) return { id: "syntax", label: BUILD_CHECK_LABELS.syntax, status: "failed", message: `${errors} file${errors === 1 ? "" : "s"} failed the syntax check.`, issues };
  if (skipped.length) {
    return {
      id: "syntax",
      label: BUILD_CHECK_LABELS.syntax,
      status: "skipped",
      message: `${skipped.length} file${skipped.length === 1 ? "" : "s"} (${skipped.slice(0, 3).join(", ")}${skipped.length > 3 ? "…" : ""}) need a TSX/JSX compiler that MATRIX does not run — not verified.`,
      issues: [
        ...issues,
        ...skipped.slice(0, 8).map((path) => ({ path, message: "Not syntax-checked by this host.", severity: "warning" as const })),
      ],
    };
  }
  return { id: "syntax", label: BUILD_CHECK_LABELS.syntax, status: "passed", message: "HTML, JavaScript, CSS and JSON structure look sound.", issues };
}

/** Offset of the first closing bracket with no matching opener. */
function firstStrayLine(code: string): number | undefined {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const closers: Record<string, string> = { "}": "{", ")": "(", "]": "[" };
  const stack: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (pairs[ch]) stack.push(ch);
    else if (closers[ch]) {
      if (stack[stack.length - 1] === closers[ch]) stack.pop();
      else return lineAt(code, i);
    }
  }
  return undefined;
}

function labelFor(char: string): string {
  if (char === "{") return "brace";
  if (char === "(") return "parenthesis";
  if (char === "[") return "bracket";
  return char;
}

function buildCheck(html: ProjectFile[], files: ProjectFile[], bundle: BundleOutcome | undefined): BuildCheck {
  const issues: BuildIssue[] = [];
  const entry = htmlEntry(files);
  if (!entry) {
    issues.push({ path: "index.html", message: "A publishable site needs an index.html entry page.", severity: "error" });
    return { id: "build", label: BUILD_CHECK_LABELS.build, status: "failed", message: "No entry page to build.", issues };
  }
  if (!bundle) {
    return { id: "build", label: BUILD_CHECK_LABELS.build, status: "skipped", message: "Build step was not run for this request.", issues };
  }
  if (!bundle.ran) {
    return { id: "build", label: BUILD_CHECK_LABELS.build, status: "skipped", message: bundle.reason, issues };
  }
  if (!bundle.ok) {
    issues.push({ path: entry.path, message: bundle.error ?? "The bundler could not produce a publishable page.", severity: "error" });
    return { id: "build", label: BUILD_CHECK_LABELS.build, status: "failed", message: "Bundling failed.", issues };
  }
  return {
    id: "build",
    label: BUILD_CHECK_LABELS.build,
    status: "passed",
    message:
      `Bundled ${bundle.outFileCount ?? files.length} file${(bundle.outFileCount ?? files.length) === 1 ? "" : "s"}` +
      (bundle.inlinedRefs ? `, inlined ${bundle.inlinedRefs} local reference${bundle.inlinedRefs === 1 ? "" : "s"}` : "") +
      (bundle.standalone ? ` — self-contained ${bundle.standalone}` : "."),
    issues,
  };
}

function routesCheck(html: ProjectFile[], files: ProjectFile[], paths: Set<string>): BuildCheck {
  const issues: BuildIssue[] = [];
  const entry = htmlEntry(files);
  if (!entry) return { id: "routes", label: BUILD_CHECK_LABELS.routes, status: "failed", message: "No entry page.", issues };
  let checked = 0;
  for (const file of html) {
    for (const ref of htmlLocalRefs(file.content, ["href"])) {
      if (/\.(png|jpe?g|gif|webp|svg|ico|avif|css|js|mjs|json|webmanifest|woff2?|txt|xml|pdf)$/i.test(ref.ref)) continue;
      checked++;
      const target = ref.ref.replace(/\/$/, "") || "index.html";
      const hit = resolveLocal(files, paths, target, file.path);
      if (!hit) {
        issues.push({ path: file.path, line: ref.line, message: `Link "${ref.raw}" does not match any project file.`, severity: "error" });
      }
    }
  }
  if (!checked) {
    return { id: "routes", label: BUILD_CHECK_LABELS.routes, status: "passed", message: "Single-page site: no internal routes to resolve.", issues };
  }
  if (issues.length) return { id: "routes", label: BUILD_CHECK_LABELS.routes, status: "failed", message: `${issues.length} internal link${issues.length === 1 ? "" : "s"} broken.`, issues };
  return { id: "routes", label: BUILD_CHECK_LABELS.routes, status: "passed", message: `${checked} internal link${checked === 1 ? "" : "s"} resolve to project files.`, issues };
}

function assetsCheck(text: ProjectFile[], files: ProjectFile[], paths: Set<string>): BuildCheck {
  const issues: BuildIssue[] = [];
  let checked = 0;
  const empty = files.filter((file) => (file.encoding === "base64" ? !file.content : !file.content.trim()));
  for (const file of empty) {
    issues.push({ path: file.path, message: `${file.path} is empty.`, severity: "warning" });
  }
  for (const file of text.filter((item) => HTML_RE.test(item.path))) {
    for (const ref of htmlLocalRefs(file.content, ["src", "poster", "data-src"])) {
      checked++;
      const hit = resolveLocal(files, paths, ref.ref, file.path);
      if (!hit) {
        issues.push({ path: file.path, line: ref.line, message: `Asset "${ref.raw}" was not found in the project.`, severity: "error" });
      } else if (isImagePath(hit.path) && !hit.content.trim()) {
        issues.push({ path: file.path, line: ref.line, message: `Asset "${hit.path}" has no content.`, severity: "error" });
      }
    }
    for (const raw of cssUrlRefs(file.content)) {
      checked++;
      if (!resolveLocal(files, paths, normalizeRef(raw.value), file.path)) {
        issues.push({ path: file.path, line: raw.line, message: `CSS url("${raw.value}") does not exist in the project.`, severity: "error" });
      }
    }
  }
  // Stylesheets shipped as their own file are where most missing images and
  // fonts actually hide, so resolve their url() references too.
  for (const file of text.filter((item) => /\.css$/i.test(item.path))) {
    for (const raw of cssUrlRefs(file.content)) {
      checked++;
      if (!resolveLocal(files, paths, normalizeRef(raw.value), file.path)) {
        issues.push({ path: file.path, line: raw.line, message: `CSS url("${raw.value}") does not exist in the project.`, severity: "error" });
      }
    }
  }
  for (const file of files) {
    const bytes = file.encoding === "base64" ? Math.floor(file.content.length * 0.75) : file.content.length;
    if (bytes > PROJECT_LIMITS.maxTextBytes * 4) {
      issues.push({ path: file.path, message: `${file.path} is unusually large for static hosting (${Math.round(bytes / 1024)} KB).`, severity: "warning" });
    }
  }
  if (issues.some((issue) => issue.severity === "error")) {
    return { id: "assets", label: BUILD_CHECK_LABELS.assets, status: "failed", message: "Some referenced files are missing from the project.", issues };
  }
  if (!checked) {
    return { id: "assets", label: BUILD_CHECK_LABELS.assets, status: "passed", message: "No local asset references to resolve.", issues };
  }
  return { id: "assets", label: BUILD_CHECK_LABELS.assets, status: "passed", message: `${checked} local asset reference${checked === 1 ? "" : "s"} resolved.`, issues };
}

/** Every non-remote `url(...)` value in a stylesheet or inline style, with lines. */
function cssUrlRefs(content: string): Array<{ value: string; line: number }> {
  const found: Array<{ value: string; line: number }> = [];
  for (const match of content.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
    const value = (match[1] ?? "").trim();
    if (!value || isRemote(value) || value.startsWith("data:")) continue;
    found.push({ value, line: lineAt(content, match.index ?? 0) });
  }
  return found;
}

function htmlEntry(files: ProjectFile[]): ProjectFile | null {
  return files.find((file) => /(^|\/)index\.html?$/i.test(file.path) && file.encoding !== "base64") ?? null;
}

function stripJsonComments(value: string): string {
  return value.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/[^\n]*/g, "$1");
}

function jsonErrorLine(content: string, error: unknown): number | undefined {
  const position = (error as { position?: number; lineNumber?: number }) ?? {};
  if (typeof position.lineNumber === "number") return position.lineNumber;
  if (typeof position.position === "number") return lineAt(content, position.position);
  const match = /position (\d+)/.exec(String((error as Error)?.message ?? ""));
  return match ? lineAt(content, Number(match[1])) : undefined;
}

function jsonErrorMessage(error: unknown): string {
  const message = String((error as Error)?.message ?? "invalid JSON");
  return message.replace(/^JSON\.parse: /, "").slice(0, 140);
}

// ---------------------------------------------------------------------------
// Reporting helpers
// ---------------------------------------------------------------------------

export function blockingIssues(report: BuildReport): BuildIssue[] {
  return report.checks.flatMap((check) => check.issues.filter((issue) => issue.severity === "error"));
}

/** `src/App.jsx:42  Unexpected token` style lines, capped for chat/UI/logs. */
export function formatIssues(issues: BuildIssue[], limit = 12): string {
  return issues
    .slice(0, limit)
    .map((issue) => `${issue.path || "project"}${issue.line ? `:${issue.line}` : ""}\n${issue.message}`)
    .join("\n\n");
}

/** Prompt body for the auto-fix loop (§15). Only real, structured problems. */
export function buildFixPrompt(report: BuildReport, projectFiles: number): string {
  const issues = blockingIssues(report);
  return [
    `The MATRIX build validator rejected this project (${projectFiles} files). Fix every problem listed below and return the COMPLETE corrected files using the MATRIX_FILE protocol. Change nothing unrelated to these problems.`,
    ``,
    `PROBLEMS:`,
    formatIssues(issues) || "Unknown validation failure.",
    issues.length > 12 ? `\n(+${issues.length - 12} more problems of the same kind)` : "",
    ``,
    `Rules: keep the entry page index.html, reference local files with simple relative paths, do not add binary files, and do not use any framework that needs a bundler.`,
  ].join("\n");
}
