// Self-healing repair engine.
//
// 1. Deterministic repairs first: parser-driven fixes that need no model and
//    are re-validated before they are kept (HTML tag balancing, truncated
//    JavaScript/CSS, leftover Markdown fences).
// 2. Then model repairs, one attempt at a time. The model sees only the files
//    that have problems (plus the files that load them) and may change only
//    those. Every candidate is validated in memory and accepted only when it
//    leaves the project with fewer errors — a "fix" that breaks something else
//    is discarded and the working files stay as they were.
// 3. The loop ends when the project is clean, the attempts are used up, the
//    same errors keep coming back, or the time budget is spent. It never
//    reports success it did not measure.
import type { ProjectFile } from "@/lib/projects/paths";
import type { BuildIssue, BuildReport } from "@/lib/deploy/validate";
import { htmlLocalRefs } from "@/lib/deploy/validate";
import { inlineBlocks, repairHtml } from "@/lib/deploy/analyze/html";
import { cssSyntaxError, jsSyntaxError, repairCss, repairJs, stripFence } from "@/lib/deploy/analyze/code";
import { classifyReport, deployVerdict, errorFingerprint, issueKey, type ClassifiedIssue, type DeployVerdict } from "@/lib/deploy/classify";

export type FileFix = { path: string; fixes: string[] };

const HTML_RE = /\.html?$/i;
const JS_RE = /\.(m?js|cjs)$/i;

function repairInline(html: string): { content: string; fixes: string[] } {
  const fixes: string[] = [];
  let content = html;
  // Right to left so earlier offsets stay valid.
  for (const block of inlineBlocks(html).reverse()) {
    if (block.kind === "script" && jsSyntaxError(block.content, block.module ? true : undefined)) {
      const fixed = repairJs(block.content, block.module ? true : undefined);
      if (fixed) {
        content = content.slice(0, block.start) + fixed.content + content.slice(block.end);
        fixes.push(...fixed.fixes.map((fix) => `Inline script (line ${block.line}): ${fix}`));
      }
    } else if (block.kind === "style" && cssSyntaxError(block.content)) {
      const fixed = repairCss(block.content);
      if (fixed) {
        content = content.slice(0, block.start) + fixed.content + content.slice(block.end);
        fixes.push(...fixed.fixes.map((fix) => `Inline style (line ${block.line}): ${fix}`));
      }
    }
  }
  return { content, fixes };
}

/** Parser-driven repair of one file. Returns null when nothing was changed. */
export function autoRepairFile(file: ProjectFile): { file: ProjectFile; fixes: string[] } | null {
  if (file.encoding === "base64") return null;
  const original = file.content ?? "";
  let content = original;
  const fixes: string[] = [];
  if (HTML_RE.test(file.path)) {
    const fence = stripFence(content);
    if (fence.stripped && /^\s*(?:<!doctype|<html|<)/i.test(fence.content)) {
      content = fence.content;
      fixes.push("Removed a leftover Markdown code fence.");
    }
    const structure = repairHtml(content);
    if (structure.changed) {
      content = structure.content;
      fixes.push(...structure.fixes);
    }
    const inline = repairInline(content);
    content = inline.content;
    fixes.push(...inline.fixes);
  } else if (JS_RE.test(file.path)) {
    const fixed = repairJs(content, /\.mjs$/i.test(file.path) ? true : /\.cjs$/i.test(file.path) ? false : undefined);
    if (fixed) {
      content = fixed.content;
      fixes.push(...fixed.fixes);
    }
  } else if (/\.css$/i.test(file.path)) {
    const fixed = repairCss(content);
    if (fixed) {
      content = fixed.content;
      fixes.push(...fixed.fixes);
    }
  } else if (/\.json$/i.test(file.path)) {
    const fence = stripFence(content);
    if (fence.stripped) {
      try {
        JSON.parse(fence.content);
        content = fence.content;
        fixes.push("Removed a leftover Markdown code fence.");
      } catch { /* still invalid: left for the model */ }
    }
  }
  if (content === original || !fixes.length) return null;
  return { file: { ...file, content }, fixes };
}

export function autoRepairFiles(files: ProjectFile[]): { files: ProjectFile[]; fixes: FileFix[] } {
  const fixes: FileFix[] = [];
  const next = files.map((file) => {
    const repaired = autoRepairFile(file);
    if (!repaired) return file;
    fixes.push({ path: file.path, fixes: repaired.fixes });
    return repaired.file;
  });
  return { files: next, fixes };
}

// ---------------------------------------------------------------------------
// Repair loop
// ---------------------------------------------------------------------------

export type RepairRequest = {
  attempt: number;
  /** Full source of the files the model may change. */
  targets: ProjectFile[];
  /** Paths of every other file, for orientation only. */
  otherPaths: string[];
  issues: ClassifiedIssue[];
  instruction: string;
};

/** Returns complete replacement/new files. Throws when no model could answer. */
export type RepairModel = (request: RepairRequest) => Promise<Array<{ path: string; content: string }>>;

export type RepairRecord = {
  attempt: number;
  kind: "deterministic" | "model";
  outcome: "accepted" | "partly_accepted" | "rejected" | "no_change" | "provider_error";
  errorsBefore: number;
  errorsAfter: number;
  files: string[];
  detail: string;
};

export type RepairStop = "clean" | "attempts" | "stalled" | "deadline" | "no_model" | "provider" | "unrepairable";

export type RepairResult = {
  files: ProjectFile[];
  report: BuildReport;
  verdict: DeployVerdict;
  attempts: number;
  history: RepairRecord[];
  changedPaths: string[];
  stop: RepairStop;
  providerError: string | null;
};

export type RepairLoopInput = {
  files: ProjectFile[];
  /** Full validation of a candidate file set (build + checks). */
  evaluate: (files: ProjectFile[]) => Promise<BuildReport>;
  model?: RepairModel | null;
  maxAttempts: number;
  /** Stop asking the model after this many attempts in a row that fixed nothing. */
  maxStalls?: number;
  deadlineAt?: number;
  /** Reject a model-written file outright (secrets, unsafe paths). */
  withhold?: (path: string, content: string) => boolean;
  /** Called after each accepted change set, before the next attempt. */
  onAccept?: (changed: ProjectFile[], record: RepairRecord, state: { files: ProjectFile[]; report: BuildReport }) => Promise<void>;
  onProgress?: (record: RepairRecord) => Promise<void> | void;
  /** Called before a model attempt starts. */
  onAttempt?: (attempt: number, issues: ClassifiedIssue[]) => Promise<void> | void;
  now?: () => number;
};

function errorIssues(report: BuildReport): ClassifiedIssue[] {
  return classifyReport(report).filter((issue) => issue.class !== "warning");
}

function errorCount(report: BuildReport): number {
  const listed = errorIssues(report).length;
  // A failed check with no listed issue still counts as one problem.
  const silent = report.checks.filter((check) => check.status === "failed" && !check.issues.some((issue) => issue.severity === "error")).length;
  return listed + silent;
}

function mustFixCount(report: BuildReport): number {
  return deployVerdict(report).blockers.length;
}

/** A candidate is better when it has fewer errors and no more must-fix errors. */
function improves(before: BuildReport, after: BuildReport): boolean {
  const b = errorCount(before);
  const a = errorCount(after);
  if (a < b) return mustFixCount(after) <= mustFixCount(before);
  return a === b && mustFixCount(after) < mustFixCount(before);
}

function merge(files: ProjectFile[], changed: ProjectFile[]): ProjectFile[] {
  const byPath = new Map(changed.map((file) => [file.path, file]));
  const merged = files.map((file) => byPath.get(file.path) ?? file);
  for (const file of changed) if (!files.some((existing) => existing.path === file.path)) merged.push(file);
  return merged;
}

function languageFor(path: string): string {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return ({ html: "html", htm: "html", css: "css", js: "javascript", mjs: "javascript", json: "json", svg: "xml", md: "markdown", txt: "text" } as Record<string, string>)[ext] ?? "text";
}

/**
 * The files a repair may touch: those with problems, and HTML pages that load
 * a broken script or stylesheet (they may need the reference corrected).
 */
export function selectRepairTargets(files: ProjectFile[], issues: BuildIssue[], maxChars = 90_000): { targets: ProjectFile[]; otherPaths: string[] } {
  const wanted = new Set<string>();
  for (const issue of issues) if (issue.path) wanted.add(issue.path);
  for (const file of files) {
    if (!HTML_RE.test(file.path) || file.encoding === "base64") continue;
    const refs = htmlLocalRefs(file.content, ["src", "href"]).map((ref) => ref.ref.toLowerCase());
    if ([...wanted].some((path) => refs.includes(path.toLowerCase()) || refs.includes((path.split("/").pop() ?? path).toLowerCase()))) wanted.add(file.path);
  }
  const targets: ProjectFile[] = [];
  let used = 0;
  // Files that are themselves broken come first when the budget is tight.
  const direct = new Set(issues.map((issue) => issue.path));
  const ordered = files.filter((file) => wanted.has(file.path) && file.encoding !== "base64").sort((a, b) => Number(direct.has(b.path)) - Number(direct.has(a.path)));
  for (const file of ordered) {
    if (targets.length && used + file.content.length > maxChars) continue;
    targets.push(file);
    used += file.content.length;
  }
  const chosen = new Set(targets.map((file) => file.path));
  return { targets, otherPaths: files.filter((file) => !chosen.has(file.path)).map((file) => file.path) };
}

export function repairInstruction(issues: ClassifiedIssue[], rejected: string | null): string {
  const lines = issues.slice(0, 14).map((issue) => `- ${issue.path || "project"}${issue.line ? `:${issue.line}` : ""} — ${issue.message}`);
  return [
    "The MATRIX validator found the problems below in this project. Repair them in the real files.",
    "",
    "PROBLEMS:",
    ...lines,
    issues.length > 14 ? `(+${issues.length - 14} more of the same kind)` : "",
    "",
    "Rules:",
    "- Return ONLY the files you change or create, each one COMPLETE, as MATRIX_FILE blocks.",
    "- Change only what is needed to fix these problems. Keep the design, the content and every feature.",
    "- If a file is referenced but missing, either create it with real content or correct the reference to an existing file.",
    "- Close every tag, bracket, brace and string. Do not wrap file contents in Markdown fences.",
    rejected ? `\nYour previous attempt was not applied: ${rejected}` : "",
  ].filter((line) => line !== "").join("\n");
}

export async function runRepairLoop(input: RepairLoopInput): Promise<RepairResult> {
  const now = input.now ?? (() => Date.now());
  const maxStalls = input.maxStalls ?? 2;
  const history: RepairRecord[] = [];
  const changedPaths = new Set<string>();
  let files = input.files;
  let report = await input.evaluate(files);
  let attempts = 0;
  let providerError: string | null = null;

  const finish = (stop: RepairStop): RepairResult => ({
    files, report, verdict: deployVerdict(report), attempts, history, changedPaths: [...changedPaths], stop, providerError,
  });
  const record = async (entry: RepairRecord) => {
    history.push(entry);
    await input.onProgress?.(entry);
  };
  const accept = async (changed: ProjectFile[], nextFiles: ProjectFile[], nextReport: BuildReport, entry: RepairRecord) => {
    files = nextFiles;
    report = nextReport;
    for (const file of changed) changedPaths.add(file.path);
    history.push(entry);
    await input.onAccept?.(changed, entry, { files, report });
    await input.onProgress?.(entry);
  };

  if (!errorCount(report)) return finish("clean");

  // ---- deterministic pass ---------------------------------------------------
  const auto = autoRepairFiles(files);
  if (auto.fixes.length) {
    const candidateReport = await input.evaluate(auto.files);
    const before = errorCount(report);
    if (improves(report, candidateReport)) {
      const changed = auto.files.filter((file) => auto.fixes.some((fix) => fix.path === file.path));
      await accept(changed, auto.files, candidateReport, {
        attempt: 0, kind: "deterministic", outcome: "accepted", errorsBefore: before, errorsAfter: errorCount(candidateReport),
        files: auto.fixes.map((fix) => fix.path),
        detail: auto.fixes.flatMap((fix) => fix.fixes.map((line) => `${fix.path}: ${line}`)).slice(0, 12).join(" "),
      });
    } else {
      // Try each repaired file on its own: one bad repair must not sink the rest.
      for (const fix of auto.fixes) {
        const single = auto.files.find((file) => file.path === fix.path);
        if (!single) continue;
        const trialFiles = merge(files, [single]);
        const trial = await input.evaluate(trialFiles);
        if (!improves(report, trial)) continue;
        const beforeSingle = errorCount(report);
        await accept([single], trialFiles, trial, {
          attempt: 0, kind: "deterministic", outcome: "accepted", errorsBefore: beforeSingle, errorsAfter: errorCount(trial),
          files: [fix.path], detail: fix.fixes.map((line) => `${fix.path}: ${line}`).join(" "),
        });
      }
    }
  }
  if (!errorCount(report)) return finish("clean");

  // ---- model attempts -------------------------------------------------------
  if (!input.model) return finish("no_model");
  let stalls = 0;
  let providerFailures = 0;
  let rejected: string | null = null;
  const seen = new Set<string>([errorFingerprint(report)]);
  while (attempts < input.maxAttempts) {
    if (input.deadlineAt && now() >= input.deadlineAt) return finish("deadline");
    const issues = errorIssues(report);
    const repairable = issues.filter((issue) => issue.class === "repairable");
    if (!repairable.length) return finish("unrepairable");
    attempts += 1;
    await input.onAttempt?.(attempts, repairable);
    const { targets, otherPaths } = selectRepairTargets(files, repairable);
    const before = errorCount(report);
    let returned: Array<{ path: string; content: string }>;
    try {
      returned = await input.model({ attempt: attempts, targets, otherPaths, issues: repairable, instruction: repairInstruction(repairable, rejected) });
      providerFailures = 0;
    } catch (error) {
      providerFailures += 1;
      providerError = error instanceof Error ? error.message.slice(0, 240) : "The repair model did not answer.";
      await record({ attempt: attempts, kind: "model", outcome: "provider_error", errorsBefore: before, errorsAfter: before, files: [], detail: providerError });
      if (providerFailures >= 2) return finish("provider");
      continue;
    }
    // Only problem files (and new files) may change: working files are preserved.
    const allowed = new Set(targets.map((file) => file.path));
    const existing = new Set(files.map((file) => file.path));
    const dropped: string[] = [];
    const candidates: ProjectFile[] = [];
    for (const item of returned) {
      const path = item.path.replace(/^\.?\/+/, "");
      if (!path || input.withhold?.(path, item.content)) { dropped.push(path || "(unnamed)"); continue; }
      if (existing.has(path) && !allowed.has(path)) { dropped.push(path); continue; }
      const current = files.find((file) => file.path === path);
      const draft: ProjectFile = { path, content: item.content, language: current?.language ?? languageFor(path), encoding: "utf8" };
      const polished = autoRepairFile(draft)?.file ?? draft;
      if (current && current.content === polished.content) continue;
      candidates.push(polished);
    }
    if (!candidates.length) {
      stalls += 1;
      rejected = dropped.length ? `it only changed files that have no problems (${dropped.slice(0, 4).join(", ")}).` : "it returned no changed files.";
      await record({ attempt: attempts, kind: "model", outcome: "no_change", errorsBefore: before, errorsAfter: before, files: [], detail: rejected });
      if (stalls >= maxStalls) return finish("stalled");
      continue;
    }
    const trialFiles = merge(files, candidates);
    const trial = await input.evaluate(trialFiles);
    if (improves(report, trial)) {
      const fingerprint = errorFingerprint(trial);
      const repeated = seen.has(fingerprint);
      seen.add(fingerprint);
      await accept(candidates, trialFiles, trial, {
        attempt: attempts, kind: "model", outcome: "accepted", errorsBefore: before, errorsAfter: errorCount(trial),
        files: candidates.map((file) => file.path), detail: `Fixed ${before - errorCount(trial)} of ${before} problem${before === 1 ? "" : "s"}.`,
      });
      stalls = repeated ? stalls + 1 : 0;
      rejected = null;
      if (!errorCount(report)) return finish("clean");
      if (stalls >= maxStalls) return finish("stalled");
      continue;
    }
    // The set as a whole did not help. Keep any single file that does.
    const kept: ProjectFile[] = [];
    if (candidates.length > 1) {
      for (const candidate of candidates.slice(0, 6)) {
        const singleFiles = merge(files, [...kept, candidate]);
        const single = await input.evaluate(singleFiles);
        if (improves(report, single)) {
          kept.push(candidate);
          const beforeSingle = errorCount(report);
          await accept([candidate], singleFiles, single, {
            attempt: attempts, kind: "model", outcome: "partly_accepted", errorsBefore: beforeSingle, errorsAfter: errorCount(single),
            files: [candidate.path], detail: `Kept ${candidate.path}; the other proposed changes introduced new problems.`,
          });
        }
      }
    }
    if (kept.length) {
      stalls = 0;
      rejected = null;
      if (!errorCount(report)) return finish("clean");
      continue;
    }
    stalls += 1;
    const introduced = errorIssues(trial).filter((issue) => !new Set(issues.map(issueKey)).has(issueKey(issue))).slice(0, 3);
    rejected = introduced.length
      ? `it introduced new problems (${introduced.map((issue) => `${issue.path}: ${issue.message}`).join("; ").slice(0, 300)}).`
      : "the same problems were still present afterwards.";
    await record({ attempt: attempts, kind: "model", outcome: "rejected", errorsBefore: before, errorsAfter: errorCount(trial), files: candidates.map((file) => file.path), detail: `Not applied: ${rejected}` });
    if (stalls >= maxStalls) return finish("stalled");
  }
  return finish(errorCount(report) ? "attempts" : "clean");
}

/** One-line, user-facing account of why the loop ended with problems left. */
export function repairStopCopy(stop: RepairStop): string {
  switch (stop) {
    case "attempts": return "the repair attempts were used up";
    case "stalled": return "further repair attempts stopped making progress";
    case "deadline": return "the time available for this request ran out";
    case "no_model": return "no AI model is available to repair it";
    case "provider": return "the AI provider stopped responding during the repair";
    case "unrepairable": return "the remaining problem cannot be fixed by editing files";
    default: return "";
  }
}
