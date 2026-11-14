// What a validation finding means for publishing.
//
//   blocking   — cannot be published and cannot be repaired by editing files
//                the way the request allows (unsupported runtime, withheld
//                secrets, a host that cannot build the project).
//   repairable — broken source that the repair loop fixes before deployment.
//                `mustFix` says whether the site is unusable while it remains.
//   warning    — never prevents deployment.
//
// After repair, anything still `blocking`, or `repairable` with `mustFix`,
// stops the deployment with the exact reason. Remaining repairable problems
// that only degrade one part of the site (a dead link, a missing image) are
// published and reported as known issues, never hidden.
import type { BuildCheckId, BuildIssue, BuildReport } from "@/lib/deploy/validate";

export type IssueClass = "blocking" | "repairable" | "warning";
export type ClassifiedIssue = BuildIssue & { check: BuildCheckId; class: IssueClass; mustFix: boolean };

const DEGRADES_ONLY = new Set(["broken-link", "missing-asset"]);
const UNREPAIRABLE = new Set(["needs-bundler", "secret-withheld", "runtime-unsupported"]);

export function classifyIssue(check: BuildCheckId, issue: BuildIssue): ClassifiedIssue {
  if (issue.severity === "warning") return { ...issue, check, class: "warning", mustFix: false };
  if (issue.code && UNREPAIRABLE.has(issue.code)) return { ...issue, check, class: "blocking", mustFix: true };
  const degradesOnly = issue.code ? DEGRADES_ONLY.has(issue.code) : check === "routes";
  return { ...issue, check, class: "repairable", mustFix: !degradesOnly };
}

export function classifyReport(report: BuildReport): ClassifiedIssue[] {
  return report.checks.flatMap((check) => check.issues.map((issue) => classifyIssue(check.id, issue)));
}

export type DeployVerdict = {
  deployable: boolean;
  /** Problems that stop the deployment. */
  blockers: ClassifiedIssue[];
  /** Real problems that are published with the site and reported to the user. */
  knownIssues: ClassifiedIssue[];
  warnings: ClassifiedIssue[];
  /** Errors a repair pass should still work on. */
  repairable: ClassifiedIssue[];
};

export function deployVerdict(report: BuildReport): DeployVerdict {
  const all = classifyReport(report);
  const blockers = all.filter((issue) => issue.class === "blocking" || (issue.class === "repairable" && issue.mustFix));
  const knownIssues = all.filter((issue) => issue.class === "repairable" && !issue.mustFix);
  // A check can fail without listing an issue (e.g. "no entry page"): never
  // let that slip through as deployable.
  const silentFailure = report.checks.some((check) => check.status === "failed" && !check.issues.some((issue) => issue.severity === "error"));
  return {
    deployable: blockers.length === 0 && !silentFailure,
    blockers,
    knownIssues,
    warnings: all.filter((issue) => issue.class === "warning"),
    repairable: all.filter((issue) => issue.class === "repairable"),
  };
}

export function issueKey(issue: BuildIssue): string {
  return `${issue.path}|${issue.code ?? ""}|${issue.message.replace(/\d+/g, "#")}`;
}

/** Stable identity of the set of errors in a report (line numbers ignored). */
export function errorFingerprint(report: BuildReport): string {
  return classifyReport(report).filter((issue) => issue.class !== "warning").map(issueKey).sort().join("\n");
}
