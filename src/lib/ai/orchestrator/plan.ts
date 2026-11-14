// Task decomposition for the model pool.
//
// Given a request and the models that may work on it, decide whether
// collaboration is worthwhile and, if so, give each model a DIFFERENT
// responsibility. Independent responsibilities run in parallel; one that
// builds on another's output is marked as dependent and runs after it.
//
// Planning is deterministic (no model call): it costs no tokens, cannot fail,
// and makes the same decision for the same request.

import type { AIRouteTarget } from "@/lib/ai/config";
import { modelById, type ModelSpec, type ModelStrength } from "@/lib/ai/models/registry";

export type TaskKind = "code" | "research" | "analysis" | "general";

export type PlannedTask = {
  id: string;
  /** Short role name used in steps ("Architect", "Reviewer"…). */
  role: string;
  /** What this model alone is responsible for. */
  responsibility: string;
  instructions: string;
  /** Strengths that suit the role, most important first. */
  needs: readonly ModelStrength[];
  dependsOn: string[];
  /** Index into `pool` of the model assigned to the task. */
  assignee: number;
  maxTokens: number;
};

export type CollaborationPlan = {
  mode: "single" | "collaborate" | "separate";
  kind: TaskKind;
  reason: string;
  /** Index into `pool` of the model that writes the final answer. */
  coordinator: number;
  tasks: PlannedTask[];
};

const CODE_RE = /```|\b(code|function|class|bug|error|exception|stack trace|refactor|implement|compile|typescript|javascript|python|java|rust|sql|regex|api|endpoint|component|unit tests?|debug|algorithm|script|query)\b/i;
const RESEARCH_RE = /\b(research|sources?|evidence|studies|study|literature|compare|comparison|pros and cons|trade-?offs?|versus|vs\.?|history of|overview of|survey)\b/i;
const ANALYSIS_RE = /\b(why|how|explain|analy[sz]e|evaluate|assess|design|plan|strategy|architecture|prove|derive|calculate|optimi[sz]e|decide|recommend|should i|step[- ]by[- ]step|in detail|thorough)\b/i;
const SEPARATE_RE = /\b(each model|every model|all (?:the )?models|models? separately|separate (?:answers?|responses?|replies)|answer separately|side[- ]by[- ]side)\b/i;

export function classifyTask(message: string): TaskKind {
  if (CODE_RE.test(message)) return "code";
  if (RESEARCH_RE.test(message)) return "research";
  if (ANALYSIS_RE.test(message)) return "analysis";
  return "general";
}

/** True when the user asked to see each model's own answer. */
export function wantsSeparateAnswers(message: string): boolean {
  return SEPARATE_RE.test(message);
}

/** Small talk and one-line lookups gain nothing from several models. */
export function isSimpleRequest(message: string, kind: TaskKind): boolean {
  const words = message.trim().split(/\s+/).filter(Boolean).length;
  if (kind === "code") return words < 6 && !message.includes("```");
  if (kind === "general") return words < 28;
  return words < 9;
}

type RoleTemplate = Omit<PlannedTask, "assignee">;

const NOTE_RULES = "Write working notes for a colleague who will produce the final answer — not a reply to the user. Be specific and concise. Do not add greetings or a conclusion.";

const ROLES: Record<TaskKind, RoleTemplate[]> = {
  code: [
    {
      id: "approach", role: "Architect", responsibility: "Approach, structure and edge cases", needs: ["planning", "reasoning", "coding"], dependsOn: [], maxTokens: 900,
      instructions: `You are the Architect. Work out HOW to solve the request: the requirements you infer, the structure of the solution, the key functions or files, edge cases and pitfalls. Do not write the full implementation. ${NOTE_RULES}`,
    },
    {
      id: "review", role: "Reviewer", responsibility: "Finding bugs and gaps in the approach", needs: ["review", "coding", "reasoning"], dependsOn: ["approach"], maxTokens: 700,
      instructions: `You are the Reviewer. You are given the Architect's approach. Check it against the request: point out mistakes, missing cases, security or performance problems, and any simpler alternative. Say plainly which parts are sound. Do not rewrite the whole approach. ${NOTE_RULES}`,
    },
    {
      id: "tests", role: "Tester", responsibility: "Concrete test cases", needs: ["coding", "fast", "review"], dependsOn: [], maxTokens: 500,
      instructions: `You are the Tester. List the concrete cases a correct solution must handle: inputs, expected results, and boundary conditions. Do not write the solution. ${NOTE_RULES}`,
    },
  ],
  research: [
    {
      id: "findings", role: "Researcher", responsibility: "Key facts and how well established they are", needs: ["research", "writing", "reasoning"], dependsOn: [], maxTokens: 900,
      instructions: `You are the Researcher. Set out the facts and considerations that matter for the request. Mark each as well established, debated, or uncertain. Never invent sources, figures or quotations. ${NOTE_RULES}`,
    },
    {
      id: "check", role: "Skeptic", responsibility: "Caveats and counter-arguments", needs: ["reasoning", "review", "research"], dependsOn: [], maxTokens: 600,
      instructions: `You are the Skeptic. Independently list what an answer to this request is likely to get wrong: common misconceptions, counter-arguments, missing context, and claims that need checking. Do not answer the request in full. ${NOTE_RULES}`,
    },
    {
      id: "outline", role: "Editor", responsibility: "Structure of the final answer", needs: ["writing", "fast", "planning"], dependsOn: [], maxTokens: 350,
      instructions: `You are the Editor. Propose the clearest structure for the final answer: the sections or steps in order, and what the reader most needs first. Outline only. ${NOTE_RULES}`,
    },
  ],
  analysis: [
    {
      id: "analysis", role: "Analyst", responsibility: "Core reasoning", needs: ["reasoning", "planning", "coding"], dependsOn: [], maxTokens: 900,
      instructions: `You are the Analyst. Reason through the request step by step and state the conclusions with the reasons for each. ${NOTE_RULES}`,
    },
    {
      id: "check", role: "Checker", responsibility: "Risks, exceptions and alternatives", needs: ["review", "research", "writing"], dependsOn: [], maxTokens: 600,
      instructions: `You are the Checker. Independently identify the assumptions, exceptions, risks and alternative views an answer must account for. Do not answer the request in full. ${NOTE_RULES}`,
    },
    {
      id: "outline", role: "Editor", responsibility: "Structure of the final answer", needs: ["writing", "fast", "planning"], dependsOn: [], maxTokens: 350,
      instructions: `You are the Editor. Propose the clearest structure for the final answer: the sections or steps in order, and what the reader most needs first. Outline only. ${NOTE_RULES}`,
    },
  ],
  general: [],
};
ROLES.general = ROLES.analysis;

function suitability(spec: ModelSpec | null, needs: readonly ModelStrength[]): number {
  if (!spec) return 0;
  return needs.reduce((score, need, index) => score + (spec.strengths.includes(need) ? needs.length - index : 0), 0);
}

/** Pool indices ordered from most to least suitable for a set of needs. */
export function rankForNeeds(pool: readonly AIRouteTarget[], needs: readonly ModelStrength[], exclude: ReadonlySet<number> = new Set()): number[] {
  return pool
    .map((target, index) => ({ index, score: suitability(modelById(target.model), needs) }))
    .filter((item) => !exclude.has(item.index))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((item) => item.index);
}

/**
 * Decide how the pool handles a request. `pool` is ordered coordinator-first.
 * With N models there are N−1 specialist responsibilities plus the
 * coordinator's synthesis — every active model has a distinct job.
 */
export function planCollaboration(input: { message: string; pool: readonly AIRouteTarget[]; kind?: TaskKind; force?: boolean }): CollaborationPlan {
  const kind = input.kind ?? classifyTask(input.message);
  const base = { kind, coordinator: 0, tasks: [] as PlannedTask[] };
  if (input.pool.length <= 1) return { ...base, mode: "single", reason: input.pool.length ? "One model is active." : "No model is available." };

  if (wantsSeparateAnswers(input.message)) {
    return {
      ...base, mode: "separate", reason: "The user asked for each model's own answer.",
      tasks: input.pool.map((_, index) => ({
        id: `answer-${index}`, role: "Answer", responsibility: "Its own complete answer", needs: [], dependsOn: [], assignee: index, maxTokens: 1200,
        instructions: "Answer the user's request directly and completely, as you normally would.",
      })),
    };
  }
  if (!input.force && isSimpleRequest(input.message, kind)) return { ...base, mode: "single", reason: "A short request — one model answers directly." };

  const templates = ROLES[kind].slice(0, input.pool.length - 1);
  const taken = new Set<number>([0]); // the coordinator's job is the synthesis
  const kept = new Set(templates.map((template) => template.id));
  const tasks: PlannedTask[] = templates.map((template) => {
    const assignee = rankForNeeds(input.pool, template.needs, taken)[0];
    taken.add(assignee);
    // A dependency that is not part of this plan is simply dropped.
    return { ...template, dependsOn: template.dependsOn.filter((id) => kept.has(id)), assignee };
  });
  return { ...base, mode: "collaborate", reason: `${input.pool.length} models, each with its own responsibility.`, tasks };
}

/** Group tasks into waves: everything in a wave is independent and runs in parallel. */
export function executionWaves(tasks: readonly PlannedTask[]): PlannedTask[][] {
  const done = new Set<string>();
  const waves: PlannedTask[][] = [];
  let pending = [...tasks];
  while (pending.length) {
    const ready = pending.filter((task) => task.dependsOn.every((id) => done.has(id)));
    if (!ready.length) { waves.push(pending); break; } // defensive: never deadlock on a cycle
    waves.push(ready);
    ready.forEach((task) => done.add(task.id));
    pending = pending.filter((task) => !ready.includes(task));
  }
  return waves;
}
