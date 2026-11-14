// Multi-model execution: runs a collaboration plan against the model pool.
//
//   • every model gets the same conversation (selected to fit its budget) and
//     its own responsibility
//   • independent tasks run in parallel, dependent tasks after their inputs
//   • a model that is rate-limited, over budget, or failing is replaced by the
//     next suitable model; if none can do the task it is recorded as failed —
//     an answer is never invented on a model's behalf
//   • the coordinator receives every finished output, labelled, with an
//     agreement check, and writes the single final answer

import type { AIMessage, AIProviderResponse } from "@/lib/ai/groq";
import type { AIRouteTarget } from "@/lib/ai/config";
import { completeWithModel, streamWithModel, type CompletedAIResponse } from "@/lib/ai/executor";
import { AIProviderError } from "@/lib/ai/provider-error";
import { modelById, modelLabel, type ModelStrength } from "@/lib/ai/models/registry";
import { estimateMessages, estimateTokens, selectConversationContext } from "@/lib/ai/orchestrator/context";
import { executionWaves, rankForNeeds, type CollaborationPlan, type PlannedTask } from "@/lib/ai/orchestrator/plan";
import { coolDown, reserveTokens } from "@/lib/ai/orchestrator/scheduler";

type Usage = AIProviderResponse["usage"];
type CompleteFn = typeof completeWithModel;
type CompleteRequest = Parameters<CompleteFn>[1];

export type ModelAttempt = { model: string; label: string; outcome: "ok" | "skipped" | "failed"; detail: string };

export type TaskResult = {
  task: PlannedTask;
  status: "done" | "failed";
  /** The model that actually produced the output (may differ from the assignee). */
  model: string;
  label: string;
  output: string;
  attempts: ModelAttempt[];
  usage: Usage;
  durationMs: number;
};

export type CollaborationEvent =
  | { type: "task_start"; task: PlannedTask; label: string }
  | { type: "task_done"; result: TaskResult }
  | { type: "compare"; agreement: Agreement; detail: string };

export type Agreement = "high" | "partial" | "low" | "n/a";

export type CollaborationResult = {
  plan: CollaborationPlan;
  results: TaskResult[];
  agreement: Agreement;
  /** Tokens per provider model ID, as reported by the provider. */
  usageByModel: Record<string, Usage>;
  /** System message for the coordinator, or null if no task produced output. */
  brief: AIMessage | null;
};

const ZERO: Usage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
const addUsage = (a: Usage, b: Usage | undefined): Usage => ({
  promptTokens: a.promptTokens + (b?.promptTokens ?? 0),
  completionTokens: a.completionTokens + (b?.completionTokens ?? 0),
  totalTokens: a.totalTokens + (b?.totalTokens ?? 0),
});
const keyOf = (target: AIRouteTarget) => modelById(target.model)?.key ?? target.model;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
});

/** How many context tokens a model may be sent for one task. */
export function contextBudget(target: AIRouteTarget, maxTokens: number): number {
  const spec = modelById(target.model);
  const window = target.contextTokens ?? spec?.contextTokens ?? 8_192;
  // Leave room for the reply, and never spend more than half a minute's TPM
  // budget on one request so parallel work can still be scheduled.
  return Math.max(600, Math.min(window - maxTokens - 512, Math.floor((spec?.tpm ?? 6_000) * 0.5) - maxTokens, 6_000));
}

/**
 * Run one request against the first candidate that can take it.
 * Candidates are tried in order; each attempt is recorded.
 */
export async function completeWithFallback(
  candidates: readonly AIRouteTarget[],
  build: (target: AIRouteTarget) => CompleteRequest,
  opts: { signal?: AbortSignal; complete?: CompleteFn; maxWaitMs?: number } = {},
): Promise<{ completed: CompletedAIResponse | null; attempts: ModelAttempt[] }> {
  const complete = opts.complete ?? completeWithModel;
  const attempts: ModelAttempt[] = [];
  const deferred: AIRouteTarget[] = [];
  for (const target of candidates) {
    if (opts.signal?.aborted) break;
    const label = modelLabel(target.model);
    const request = build(target);
    const estimate = estimateMessages(request.messages) + Math.min(request.maxTokens ?? 1024, 4_096);
    let reservation = reserveTokens(keyOf(target), estimate);
    if (!reservation.ok && reservation.reason === "budget" && reservation.waitMs <= (opts.maxWaitMs ?? 2_000)) {
      await sleep(reservation.waitMs, opts.signal);
      reservation = reserveTokens(keyOf(target), estimate);
    }
    if (!reservation.ok) {
      attempts.push({
        model: target.model, label, outcome: "skipped",
        detail: reservation.reason === "cooldown" ? "rate-limited by the provider" : reservation.reason === "too_large" ? "request is larger than this model's per-minute token budget" : "per-minute token budget is in use",
      });
      deferred.push(target);
      continue;
    }
    try {
      const completed = await complete([target], request);
      reservation.release(completed.response.usage?.totalTokens);
      attempts.push({ model: target.model, label, outcome: "ok", detail: "" });
      return { completed, attempts };
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (error instanceof AIProviderError && error.type === "rate_limit") coolDown(keyOf(target), 30_000);
      attempts.push({ model: target.model, label, outcome: "failed", detail: error instanceof AIProviderError ? error.type : error instanceof Error ? error.message.slice(0, 120) : "unknown error" });
    }
  }
  // The scheduler steers work between models; it is not allowed to turn a
  // request away altogether. If every candidate was only *deferred* (never
  // tried), send the request to the first of them and let the provider decide.
  if (!opts.signal?.aborted && deferred.length && !attempts.some((attempt) => attempt.outcome === "failed")) {
    const target = deferred[0];
    const label = modelLabel(target.model);
    try {
      const completed = await complete([target], build(target));
      attempts.push({ model: target.model, label, outcome: "ok", detail: "" });
      return { completed, attempts };
    } catch (error) {
      if (opts.signal?.aborted) throw error;
      if (error instanceof AIProviderError && error.type === "rate_limit") coolDown(keyOf(target), 30_000);
      attempts.push({ model: target.model, label, outcome: "failed", detail: error instanceof AIProviderError ? error.type : error instanceof Error ? error.message.slice(0, 120) : "unknown error" });
    }
  }
  return { completed: null, attempts };
}

/** Like `completeWithFallback`, choosing candidates by what the job needs. */
export async function completeWithRole(
  pool: readonly AIRouteTarget[],
  needs: readonly ModelStrength[],
  request: CompleteRequest,
  opts: { signal?: AbortSignal; complete?: CompleteFn; prefer?: number; avoid?: number; maxWaitMs?: number } = {},
): Promise<{ completed: CompletedAIResponse | null; attempts: ModelAttempt[] }> {
  let order = rankForNeeds(pool, needs);
  if (opts.avoid !== undefined && order.length > 1) order = [...order.filter((index) => index !== opts.avoid), opts.avoid];
  if (opts.prefer !== undefined) order = [opts.prefer, ...order.filter((index) => index !== opts.prefer)];
  return completeWithFallback(order.map((index) => pool[index]), () => request, opts);
}

function terms(text: string): Set<string> {
  return new Set((text.toLowerCase().match(/[a-z][a-z0-9_]{3,}/g) ?? []).filter((word) => !STOP.has(word)));
}
const STOP = new Set("this that with from have will your they them their there which would should could about into than then when what where while been being does also must such only more most some each other these those very just like make made using used need needs note notes".split(" "));

/**
 * Compare the finished outputs. Term overlap shows whether the models covered
 * the same ground; explicit objections from a reviewing role show conflict.
 */
export function compareOutputs(results: readonly TaskResult[]): { agreement: Agreement; detail: string; objections: number } {
  const done = results.filter((result) => result.status === "done");
  const objections = done
    .filter((result) => /review|skeptic|checker/i.test(result.task.role))
    .reduce((count, result) => count + (result.output.match(/\b(incorrect|wrong|mistake|bug|missing|fails?|unsafe|insecure|contradict\w*|not true|inaccurate|overlook\w*)\b/gi)?.length ?? 0), 0);
  if (done.length < 2) return { agreement: "n/a", detail: done.length ? "Only one output to work from." : "No specialist output.", objections };
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < done.length; i += 1) {
    for (let j = i + 1; j < done.length; j += 1) {
      const a = terms(done[i].output);
      const b = terms(done[j].output);
      const shared = [...a].filter((word) => b.has(word)).length;
      total += shared / Math.max(1, Math.min(a.size, b.size));
      pairs += 1;
    }
  }
  const overlap = total / pairs;
  const agreement: Agreement = objections >= 4 || overlap < 0.12 ? "low" : objections >= 1 || overlap < 0.3 ? "partial" : "high";
  const detail = `${done.length} outputs compared · ${Math.round(overlap * 100)}% shared ground${objections ? ` · ${objections} objection${objections === 1 ? "" : "s"} raised` : ""}`;
  return { agreement, detail, objections };
}

/** The coordinator's instructions for turning specialist notes into one answer. */
export function synthesisBrief(plan: CollaborationPlan, results: readonly TaskResult[], agreement: Agreement, budgetTokens = 3_000): AIMessage | null {
  const done = results.filter((result) => result.status === "done" && result.output.trim());
  if (!done.length) return null;
  const each = Math.max(200, Math.floor(budgetTokens / done.length));
  const sections = done.map((result) => {
    const body = result.output.trim();
    const clipped = estimateTokens(body) > each ? `${body.slice(0, each * 4)}\n…[trimmed]` : body;
    return `### ${result.task.role} — ${result.task.responsibility}\n${clipped}`;
  });
  const failed = results.filter((result) => result.status === "failed").map((result) => result.task.role);
  const conflict = agreement === "low"
    ? "The notes disagree in places. For each disagreement decide which position is correct on the merits, and use only that."
    : agreement === "partial" ? "Where the notes differ or one raises an objection, check it and keep only what is correct." : "The notes largely agree; still verify anything that looks wrong.";
  return {
    role: "system",
    content: [
      plan.mode === "collaborate" ? "Working notes prepared for you on this request are below. You are responsible for the final answer." : "",
      "Use what is correct, fix what is wrong, and fill any gaps yourself. " + conflict,
      "Write ONE coherent answer to the user in your own voice. Do not mention these notes, the roles, other models, or this process.",
      failed.length ? `No notes were produced for: ${failed.join(", ")}. Cover that ground yourself.` : "",
      "",
      ...sections,
    ].filter((line, index) => line || index >= 4).join("\n"),
  };
}

/** Each model's own answer, labelled — used only when the user asks for that. */
export function separateAnswers(results: readonly TaskResult[]): string {
  return results
    .map((result) => result.status === "done"
      ? `### ${result.label}\n\n${result.output.trim()}`
      : `### ${result.label}\n\n_This model did not answer (${result.attempts.at(-1)?.detail || "unavailable"})._`)
    .join("\n\n---\n\n");
}

export async function runCollaboration(input: {
  plan: CollaborationPlan;
  pool: readonly AIRouteTarget[];
  /** The full conversation: system instructions, history, latest user message. */
  messages: readonly AIMessage[];
  signal?: AbortSignal;
  requestId?: string;
  deadlineAt?: number;
  onEvent?: (event: CollaborationEvent) => void;
  complete?: CompleteFn;
}): Promise<CollaborationResult> {
  const { plan, pool } = input;
  const results = new Map<string, TaskResult>();
  let usageByModel: Record<string, Usage> = {};
  const separate = plan.mode === "separate";

  const runTask = async (task: PlannedTask): Promise<TaskResult> => {
    const started = Date.now();
    const assigned = pool[task.assignee];
    input.onEvent?.({ type: "task_start", task, label: modelLabel(assigned.model) });
    // Fallback order: the assignee, then other specialists by suitability, and
    // the coordinator last. In "separate" mode an answer must come from its
    // own model, so there is no substitute.
    const order = separate ? [task.assignee] : [task.assignee, ...rankForNeeds(pool, task.needs, new Set([task.assignee, plan.coordinator])), ...(task.assignee === plan.coordinator ? [] : [plan.coordinator])];
    const inputs = task.dependsOn.map((id) => results.get(id)).filter((result): result is TaskResult => result?.status === "done");
    const { completed, attempts } = await completeWithFallback(
      order.map((index) => pool[index]),
      (target) => {
        const context = selectConversationContext(input.messages, contextBudget(target, task.maxTokens));
        const system = context.messages.filter((message) => message.role === "system");
        const turns = context.messages.filter((message) => message.role !== "system");
        const messages: AIMessage[] = separate
          ? context.messages
          : [
            { role: "system", content: task.instructions },
            ...system,
            ...inputs.map((dep): AIMessage => ({ role: "system", content: `Notes from the ${dep.task.role} (${dep.task.responsibility}):\n${dep.output.slice(0, 6_000)}` })),
            ...turns,
          ];
        return { messages, temperature: 0.3, maxTokens: task.maxTokens, requestId: input.requestId, signal: input.signal, deadlineAt: input.deadlineAt };
      },
      { signal: input.signal, complete: input.complete },
    );
    const producer = completed?.target ?? assigned;
    const result: TaskResult = {
      task,
      status: completed ? "done" : "failed",
      model: producer.model,
      label: modelLabel(producer.model),
      output: completed?.response.content?.trim() ?? "",
      attempts,
      usage: completed?.response.usage ?? ZERO,
      durationMs: Date.now() - started,
    };
    if (completed) usageByModel = { ...usageByModel, [producer.model]: addUsage(usageByModel[producer.model] ?? ZERO, completed.response.usage) };
    results.set(task.id, result);
    input.onEvent?.({ type: "task_done", result });
    return result;
  };

  for (const wave of executionWaves(plan.tasks)) {
    if (input.signal?.aborted) break;
    await Promise.all(wave.map((task) => runTask(task)));
  }
  const ordered = plan.tasks.map((task) => results.get(task.id)).filter((result): result is TaskResult => Boolean(result));
  const comparison = compareOutputs(ordered);
  if (!separate && ordered.length) input.onEvent?.({ type: "compare", agreement: comparison.agreement, detail: comparison.detail });
  return {
    plan,
    results: ordered,
    agreement: comparison.agreement,
    usageByModel,
    brief: separate ? null : synthesisBrief(plan, ordered, comparison.agreement),
  };
}

type StreamRequest = Parameters<typeof streamWithModel>[1];

/**
 * Stream the final answer from the first model in `order` that can produce
 * it. A model that fails BEFORE any text is shown is replaced by the next one;
 * once text has been shown the stream is never restarted on another model.
 */
export async function* streamWithFallback(
  order: readonly AIRouteTarget[],
  request: StreamRequest,
  hooks: { onStart?: (target: AIRouteTarget) => void; onFallback?: (from: AIRouteTarget, to: AIRouteTarget, error: unknown) => void; stream?: typeof streamWithModel } = {},
): AsyncGenerator<{ delta: string; target: AIRouteTarget }> {
  const stream = hooks.stream ?? streamWithModel;
  let lastError: unknown = null;
  for (let index = 0; index < order.length; index += 1) {
    const target = order[index];
    if (index > 0 && reserveTokens(keyOf(target), 0).ok === false) continue; // skip models in cool-down
    let yielded = false;
    try {
      for await (const item of stream([target], request, hooks.onStart)) {
        yielded = true;
        yield item;
      }
      return;
    } catch (error) {
      if (request.signal?.aborted || yielded) throw error;
      if (error instanceof AIProviderError && error.type === "rate_limit") coolDown(keyOf(target), 30_000);
      lastError = error;
      const next = order[index + 1];
      if (next) hooks.onFallback?.(target, next, error);
    }
  }
  throw lastError ?? new Error("No model is available");
}
