// JavaScript, CSS and JSON checks backed by real parsers (acorn, PostCSS),
// plus the small set of repairs that can be proven correct by parsing again.
import { parse as parseJs } from "acorn";
import postcss from "postcss";

export type CodeIssue = { line?: number; column?: number; message: string };
export type CodeRepair = { content: string; fixes: string[] };

// ---------------------------------------------------------------------------
// JavaScript
// ---------------------------------------------------------------------------

type AcornError = Error & { loc?: { line: number; column: number }; pos?: number };

function tryParse(code: string, sourceType: "module" | "script"): AcornError | null {
  try {
    parseJs(code, { ecmaVersion: "latest", sourceType, allowHashBang: true, allowAwaitOutsideFunction: sourceType === "module", allowReturnOutsideFunction: false });
    return null;
  } catch (error) {
    return error as AcornError;
  }
}

const FENCE_OPEN = /^\s*```[a-zA-Z0-9_-]*[ \t]*\r?\n/;
const FENCE_CLOSE = /\r?\n```[ \t]*\s*$/;

/** Syntax error of a script, or null when it parses. `module` unknown → either grammar is accepted. */
export function jsSyntaxError(code: string, module?: boolean): CodeIssue | null {
  // ```js … ``` happens to be valid JavaScript (nested tagged templates), so
  // the parser accepts it — and the browser then throws at run time.
  if (FENCE_OPEN.test(code) && FENCE_CLOSE.test(code)) return { line: 1, column: 1, message: "The file is wrapped in a Markdown code fence (```), which is not JavaScript." };
  const first = tryParse(code, module === false ? "script" : "module");
  if (!first) return null;
  if (module === undefined && !tryParse(code, "script")) return null;
  return {
    line: first.loc?.line,
    column: first.loc ? first.loc.column + 1 : undefined,
    message: first.message.replace(/\s*\(\d+:\d+\)\s*$/, ""),
  };
}


/** Remove a Markdown code fence a model left around a file body. */
export function stripFence(code: string): { content: string; stripped: boolean } {
  if (!FENCE_OPEN.test(code) && !FENCE_CLOSE.test(code)) return { content: code, stripped: false };
  return { content: code.replace(FENCE_OPEN, "").replace(FENCE_CLOSE, "\n"), stripped: true };
}

/** Closers still owed at the end of `code`, innermost first. Strings, templates, comments and regex-free. */
function owedClosers(code: string): string | null {
  const pairs: Record<string, string> = { "{": "}", "(": ")", "[": "]" };
  const stack: string[] = [];
  let i = 0;
  let tail = "";
  while (i < code.length) {
    const ch = code[i];
    const two = code.slice(i, i + 2);
    if (two === "//") {
      const nl = code.indexOf("\n", i);
      i = nl === -1 ? code.length : nl;
      continue;
    }
    if (two === "/*") {
      const end = code.indexOf("*/", i + 2);
      if (end === -1) { tail = "*/"; break; }
      i = end + 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < code.length && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      if (j >= code.length) return null; // an unterminated string cannot be completed safely
      i = j + 1;
      continue;
    }
    if (ch === "`") {
      let j = i + 1;
      let depth = 0;
      while (j < code.length) {
        if (code[j] === "\\") { j += 2; continue; }
        if (code[j] === "`" && depth === 0) break;
        if (code[j] === "$" && code[j + 1] === "{") { depth += 1; j += 2; continue; }
        if (code[j] === "}" && depth > 0) depth -= 1;
        j += 1;
      }
      if (j >= code.length) return null;
      i = j + 1;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === "}" || ch === ")" || ch === "]") {
      if (stack[stack.length - 1] !== ch) return null; // genuinely mismatched: not a truncation
      stack.pop();
    }
    i += 1;
  }
  if (!stack.length && !tail) return null;
  return tail + stack.reverse().join("");
}

/**
 * Repairs that are safe because the result is parsed again before it is
 * accepted: a leftover Markdown fence, typographic quotes outside the
 * grammar, and a file cut off before its closing brackets.
 */
export function repairJs(code: string, module?: boolean): CodeRepair | null {
  if (!jsSyntaxError(code, module)) return null;
  const attempts: Array<() => CodeRepair | null> = [
    () => {
      const fence = stripFence(code);
      return fence.stripped ? { content: fence.content, fixes: ["Removed a leftover Markdown code fence."] } : null;
    },
    () => {
      const closers = owedClosers(stripFence(code).content);
      if (!closers) return null;
      const base = stripFence(code).content.replace(/\s*$/, "");
      return { content: `${base}\n${closers}\n`, fixes: [`Added the missing closing ${closers.length === 1 ? "bracket" : "brackets"} "${closers}" at the end of the file.`] };
    },
    () => {
      if (!/[\u201c\u201d\u2018\u2019]/.test(code)) return null;
      return { content: stripFence(code).content.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"), fixes: ["Replaced typographic quotes with straight quotes."] };
    },
  ];
  for (const attempt of attempts) {
    const candidate = attempt();
    if (candidate && !jsSyntaxError(candidate.content, module)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// CSS
// ---------------------------------------------------------------------------

type PostcssError = Error & { reason?: string; line?: number; column?: number };

export function cssSyntaxError(css: string): CodeIssue | null {
  try {
    postcss.parse(css);
    return null;
  } catch (error) {
    const e = error as PostcssError;
    return { line: e.line, column: e.column, message: e.reason ?? e.message };
  }
}

export function repairCss(css: string): CodeRepair | null {
  if (!cssSyntaxError(css)) return null;
  const fixes: string[] = [];
  let content = css;
  const fence = stripFence(content);
  if (fence.stripped) {
    content = fence.content;
    fixes.push("Removed a leftover Markdown code fence.");
  }
  for (let i = 0; i < 12; i += 1) {
    const error = cssSyntaxError(content);
    if (!error) return fixes.length ? { content, fixes } : null;
    if (/Unclosed comment/i.test(error.message)) {
      content = `${content.replace(/\s*$/, "")} */\n`;
      fixes.push("Closed an unterminated CSS comment.");
    } else if (/Unclosed block/i.test(error.message)) {
      content = `${content.replace(/\s*$/, "")}\n}\n`;
      fixes.push("Added a missing closing brace.");
    } else if (/Unexpected }/i.test(error.message) && error.line) {
      const lines = content.split("\n");
      const row = lines[error.line - 1] ?? "";
      const col = (error.column ?? 1) - 1;
      if (row[col] !== "}") return null;
      lines[error.line - 1] = row.slice(0, col) + row.slice(col + 1);
      content = lines.join("\n");
      fixes.push(`Removed an extra closing brace on line ${error.line}.`);
    } else return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// TypeScript / JSX (syntax only, when the compiler is installed on the host)
// ---------------------------------------------------------------------------

type TsModule = {
  transpileModule(input: string, options: { reportDiagnostics: boolean; fileName: string; compilerOptions: Record<string, unknown> }): {
    diagnostics?: Array<{ messageText: string | { messageText: string }; start?: number }>;
  };
};

let tsModule: TsModule | null | undefined;

function loadTypescript(): TsModule | null {
  if (tsModule !== undefined) return tsModule;
  try {
    // Resolved at run time so the compiler is never bundled into the server build.
    const nodeModule = (process as unknown as { getBuiltinModule?: (id: string) => { createRequire(path: string): (id: string) => unknown } }).getBuiltinModule?.("module");
    tsModule = nodeModule ? (nodeModule.createRequire(`${process.cwd()}/`)("typescript") as TsModule) : null;
  } catch {
    tsModule = null;
  }
  return tsModule;
}

/** null = parses; undefined = no compiler on this host, so nothing was checked. */
export function tsSyntaxErrors(path: string, code: string): CodeIssue[] | undefined {
  const ts = loadTypescript();
  if (!ts) return undefined;
  const result = ts.transpileModule(code, { reportDiagnostics: true, fileName: path, compilerOptions: { jsx: 1, target: 99, module: 99, isolatedModules: true } });
  return (result.diagnostics ?? []).slice(0, 5).map((diagnostic) => {
    const before = typeof diagnostic.start === "number" ? code.slice(0, diagnostic.start) : "";
    return {
      line: typeof diagnostic.start === "number" ? before.split("\n").length : undefined,
      message: typeof diagnostic.messageText === "string" ? diagnostic.messageText : diagnostic.messageText.messageText,
    };
  });
}
