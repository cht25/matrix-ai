// Collaborative multi-model engine.
//
// Unit tests exercise the planner, context selection, scheduler and
// orchestrator directly. The end-to-end tests drive the REAL gateway route and
// REAL provider client; only `fetch` is replaced, by a fake provider that
// serves a model catalog and per-model chat completions.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => {
  const user = { uid: "multi-model-user", email: "multi@example.com", emailVerified: true };
  return { verifySession: vi.fn(async () => user), getSessionUser: vi.fn(async () => user) };
});

import { POST } from "../src/app/api/ai/route";
import { GET as getModels, PUT as putModels } from "../src/app/api/models/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { MATRIX_MODEL_ID } from "../src/lib/ai/model";
import { MODEL_REGISTRY, modelById, modelByKey, modelTpm, sanitizeModelKeys, isRegisteredModelId } from "../src/lib/ai/models/registry";
import { listModelStatus, resolvePool, setPoolPreference, MAX_ACTIVE_MODELS } from "../src/lib/ai/models/pool";
import { classifyTask, executionWaves, isSimpleRequest, planCollaboration, wantsSeparateAnswers } from "../src/lib/ai/orchestrator/plan";
import { digestTurns, estimateMessages, selectConversationContext, selectRelevantFiles } from "../src/lib/ai/orchestrator/context";
import { coolDown, cooldownRemainingMs, reserveTokens, resetScheduler, tokensUsedLastMinute } from "../src/lib/ai/orchestrator/scheduler";
import { compareOutputs, completeWithFallback, completeWithRole, runCollaboration, streamWithFallback, synthesisBrief, type TaskResult } from "../src/lib/ai/orchestrator/run";
import { AIProviderError } from "../src/lib/ai/provider-error";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";
import { GroqProvider, type AIMessage, type AIProvider } from "../src/lib/ai/groq";
import type { AIRouteTarget } from "../src/lib/ai/config";
import type { CompletedAIResponse } from "../src/lib/ai/executor";
import type { Db } from "../src/lib/firebase/admin";
import { runBuildPipeline } from "../src/lib/server/build";
import { FirestoreDeploymentProvider } from "../src/lib/deploy/firestore-provider";

const stub: FirestoreStub = sharedFirestoreStub();
const QWEN = modelByKey("qwen3-32b")!.id;
const LLAMA = modelByKey("llama-3.3-70b")!.id;
const SMALL = modelByKey("gpt-oss-20b")!.id;
const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

const noClient = {} as AIProvider;
const target = (model: string): AIRouteTarget => ({ provider: "Groq", providerId: "groq", model, client: noClient, tier: "high" });
const POOL3 = [target(MATRIX_MODEL_ID), target(QWEN), target(LLAMA)];
const QUESTION = "Explain step by step why quicksort is O(n log n) on average and when it degrades, in detail.";
const CODE = "Write a TypeScript function that debounces another function and explain the edge cases.";

type Call = { model: string; messages: AIMessage[]; at: number };
/** A fake `completeWithModel`: records calls, answers per model, can fail or delay. */
function fakeComplete(opts: { fail?: Record<string, AIProviderError | Error>; delayMs?: number; reply?: (model: string, messages: AIMessage[]) => string } = {}) {
  const calls: Call[] = [];
  const complete = async (targets: AIRouteTarget[], request: { messages: AIMessage[] }): Promise<CompletedAIResponse> => {
    const [route] = targets;
    calls.push({ model: route.model, messages: request.messages, at: Date.now() });
    if (opts.delayMs) await new Promise((resolve) => setTimeout(resolve, opts.delayMs));
    const failure = opts.fail?.[route.model];
    if (failure) throw failure;
    return { target: route, response: { content: opts.reply?.(route.model, request.messages) ?? `notes from ${route.model}`, model: route.model, usage, toolCalls: [] } };
  };
  return { calls, complete: complete as never };
}
const unavailable = (model: string) => new AIProviderError({ provider: "Groq", model, type: "provider_unavailable", detail: "503" });

beforeEach(() => { resetScheduler(); });

// ---------------------------------------------------------------------------
describe("model registry", () => {
  it("has unique keys and IDs, a default, and resolves both spellings of the default ID", () => {
    expect(new Set(MODEL_REGISTRY.map((model) => model.key)).size).toBe(MODEL_REGISTRY.length);
    expect(new Set(MODEL_REGISTRY.map((model) => model.id)).size).toBe(MODEL_REGISTRY.length);
    expect(modelById(MATRIX_MODEL_ID)?.key).toBe("gpt-oss-120b");
    expect(modelById("gpt-oss-120b")?.key).toBe("gpt-oss-120b");
    expect(isRegisteredModelId("made-up-model")).toBe(false);
    expect(sanitizeModelKeys(["qwen3-32b", "nope", "qwen3-32b", 3])).toEqual(["qwen3-32b"]);
  });
  it("allows a per-deployment TPM override and ignores nonsense", () => {
    const spec = modelByKey("qwen3-32b")!;
    expect(modelTpm(spec, {})).toBe(spec.tpm);
    expect(modelTpm(spec, { MATRIX_MODEL_TPM_QWEN3_32B: "50000" })).toBe(50000);
    expect(modelTpm(spec, { MATRIX_MODEL_TPM_QWEN3_32B: "abc" })).toBe(spec.tpm);
  });
  it("the provider client requests hidden reasoning and JSON only from models that support them", () => {
    const build = (model: string, extra: Record<string, unknown> = {}) =>
      (new GroqProvider("k") as unknown as { buildBody: (req: unknown, stream: boolean) => Record<string, unknown> }).buildBody({ model, messages: [{ role: "user", content: "hi" }], ...extra }, false);
    expect(build(MATRIX_MODEL_ID)).toMatchObject({ reasoning_format: "hidden", reasoning_effort: "low" });
    expect(build(QWEN).reasoning_format).toBe("hidden");
    expect(build(QWEN).reasoning_effort).toBeUndefined();
    expect(build(LLAMA).reasoning_format).toBeUndefined();
    expect(build(LLAMA, { jsonMode: true }).response_format).toEqual({ type: "json_object" });
    expect(build(LLAMA).response_format).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
describe("task decomposition", () => {
  it("classifies requests and recognises a request for separate answers", () => {
    expect(classifyTask(CODE)).toBe("code");
    expect(classifyTask("Compare the pros and cons of solar and wind power")).toBe("research");
    expect(classifyTask(QUESTION)).toBe("analysis");
    expect(classifyTask("hello there")).toBe("general");
    expect(wantsSeparateAnswers("Which model is best for writing code?")).toBe(false);
    expect(wantsSeparateAnswers("Show separate answers from each model")).toBe(true);
    expect(isSimpleRequest("hi, how are you?", "general")).toBe(true);
  });

  it("one model: answers directly, no collaboration", () => {
    const plan = planCollaboration({ message: QUESTION, pool: POOL3.slice(0, 1) });
    expect(plan.mode).toBe("single");
    expect(plan.tasks).toEqual([]);
  });

  it("two models: one specialist responsibility plus the coordinator's synthesis", () => {
    const plan = planCollaboration({ message: QUESTION, pool: POOL3.slice(0, 2) });
    expect(plan.mode).toBe("collaborate");
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0].assignee).toBe(1);
    expect(plan.coordinator).toBe(0);
  });

  it("three models: every model has a different job and none duplicates the coordinator", () => {
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    expect(plan.tasks).toHaveLength(2);
    expect(new Set(plan.tasks.map((task) => task.assignee)).size).toBe(2);
    expect(plan.tasks.every((task) => task.assignee !== plan.coordinator)).toBe(true);
    expect(new Set(plan.tasks.map((task) => task.responsibility)).size).toBe(2);
    expect(new Set(plan.tasks.map((task) => task.instructions)).size).toBe(2);
  });

  it("assigns by strength: the reasoning specialist analyses, the research/writing model checks", () => {
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    const by = Object.fromEntries(plan.tasks.map((task) => [task.id, POOL3[task.assignee].model]));
    expect(by.analysis).toBe(QWEN);
    expect(by.check).toBe(LLAMA);
  });

  it("independent work runs in one parallel wave; dependent work waits for its input", () => {
    const analysis = planCollaboration({ message: QUESTION, pool: POOL3 });
    expect(executionWaves(analysis.tasks).map((wave) => wave.map((task) => task.id))).toEqual([["analysis", "check"]]);
    const code = planCollaboration({ message: CODE, pool: POOL3 });
    expect(code.kind).toBe("code");
    expect(executionWaves(code.tasks).map((wave) => wave.map((task) => task.id))).toEqual([["approach"], ["review"]]);
    const four = planCollaboration({ message: CODE, pool: [...POOL3, target(SMALL)] });
    expect(executionWaves(four.tasks).map((wave) => wave.map((task) => task.id))).toEqual([["approach", "tests"], ["review"]]);
  });

  it("a short question is not worth several models", () => {
    expect(planCollaboration({ message: "What's the capital of France?", pool: POOL3 }).mode).toBe("single");
  });

  it("separate answers: every model answers itself and nothing is synthesised", () => {
    const plan = planCollaboration({ message: "Show separate answers from each model: what is recursion?", pool: POOL3 });
    expect(plan.mode).toBe("separate");
    expect(plan.tasks.map((task) => task.assignee)).toEqual([0, 1, 2]);
  });
});

// ---------------------------------------------------------------------------
describe("context selection", () => {
  const history: AIMessage[] = [
    { role: "system", content: "You are MATRIX." },
    ...Array.from({ length: 40 }, (_, i): AIMessage => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "detail ".repeat(120) })),
    { role: "user", content: "FINAL QUESTION about turn 3" },
  ];

  it("never sends the whole history: fits the budget, keeps instructions and the latest message, digests the rest", () => {
    const selected = selectConversationContext(history, 1500);
    expect(selected.tokens).toBeLessThanOrEqual(1500);
    expect(estimateMessages(history)).toBeGreaterThan(5000);
    expect(selected.messages[0]).toEqual(history[0]);
    expect(selected.messages.at(-1)?.content).toBe("FINAL QUESTION about turn 3");
    expect(selected.omittedTurns).toBeGreaterThan(0);
    expect(selected.messages.some((message) => message.role === "system" && message.content.startsWith("Earlier in this conversation"))).toBe(true);
    // The newest turns are kept verbatim, in order.
    const kept = selected.messages.filter((message) => message.role !== "system").map((message) => message.content.slice(0, 8));
    expect(kept.at(-2)).toBe("turn 39 ");
  });

  it("a short conversation is passed through unchanged", () => {
    const short = history.slice(0, 3).concat(history.at(-1)!);
    expect(selectConversationContext(short, 6000).messages).toEqual(short);
  });

  it("digest is one clipped line per turn", () => {
    const digest = digestTurns(history.slice(1, 4), 200);
    expect(digest.split("\n")).toHaveLength(3);
    expect(digest).toContain("- User: turn 0");
  });

  it("selects only the relevant files within budget and reports what was left out", () => {
    const files = [
      { path: "index.html", content: "<html>home</html>" },
      { path: "src/cart.ts", content: "export function addToCart(item) { /* cart total */ }".repeat(20) },
      { path: "src/unrelated-big.ts", content: "x".repeat(40_000) },
      { path: "README.md", content: "docs" },
    ];
    const picked = selectRelevantFiles(files, "Fix the total in cart.ts", 800);
    expect(picked.files[0].path).toBe("src/cart.ts");
    expect(picked.files.map((file) => file.path)).toContain("index.html");
    expect(picked.omitted).toContain("src/unrelated-big.ts");
  });
});

// ---------------------------------------------------------------------------
describe("TPM-aware scheduling", () => {
  it("admits requests within the per-minute budget and defers what would exceed it", () => {
    const spec = modelByKey("qwen3-32b")!;
    const now = 1_000_000;
    expect(reserveTokens(spec.key, spec.tpm - 1000, now).ok).toBe(true);
    const blocked = reserveTokens(spec.key, 2000, now + 1000);
    expect(blocked).toMatchObject({ ok: false, reason: "budget" });
    expect(!blocked.ok && blocked.waitMs).toBeGreaterThan(50_000);
    // The window slides: a minute later the budget is free again.
    expect(reserveTokens(spec.key, 2000, now + 61_000).ok).toBe(true);
  });
  it("replaces the estimate with the provider-reported total", () => {
    const first = reserveTokens("llama-3.3-70b", 5000, 5);
    if (first.ok) first.release(1200);
    expect(tokensUsedLastMinute("llama-3.3-70b", 6)).toBe(1200);
  });
  it("refuses a request larger than a whole minute's budget, and honours cool-down", () => {
    expect(reserveTokens("llama-3.1-8b", 999_999, 1)).toMatchObject({ ok: false, reason: "too_large" });
    coolDown("gpt-oss-20b", 30_000, 100);
    expect(cooldownRemainingMs("gpt-oss-20b", 100)).toBe(30_000);
    expect(reserveTokens("gpt-oss-20b", 10, 200)).toMatchObject({ ok: false, reason: "cooldown" });
    expect(reserveTokens("gpt-oss-20b", 10, 31_000).ok).toBe(true);
  });
});

// ---------------------------------------------------------------------------
describe("orchestrated execution", () => {
  const conversation: AIMessage[] = [
    { role: "system", content: "You are MATRIX." },
    { role: "user", content: "My project is called Orchard." },
    { role: "assistant", content: "Noted: Orchard." },
    { role: "user", content: QUESTION },
  ];

  it("three models: specialists run in parallel on the same conversation with different instructions", async () => {
    const fake = fakeComplete({ delayMs: 60 });
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    const events: string[] = [];
    const started = Date.now();
    const result = await runCollaboration({ plan, pool: POOL3, messages: conversation, complete: fake.complete, onEvent: (event) => events.push(event.type) });
    const elapsed = Date.now() - started;
    expect(fake.calls.map((call) => call.model).sort()).toEqual([LLAMA, QWEN].sort());
    expect(Math.abs(fake.calls[0].at - fake.calls[1].at)).toBeLessThan(40); // started together
    expect(elapsed).toBeLessThan(115); // ≈ one delay, not two
    for (const call of fake.calls) {
      // Shared history: every model sees the earlier turns and the question…
      expect(call.messages.some((message) => message.content.includes("Orchard"))).toBe(true);
      expect(call.messages.at(-1)?.content).toBe(QUESTION);
    }
    // …but each has its own responsibility.
    expect(fake.calls[0].messages[0].content).not.toBe(fake.calls[1].messages[0].content);
    expect(result.results.every((item) => item.status === "done")).toBe(true);
    expect(events).toEqual(["task_start", "task_start", "task_done", "task_done", "compare"]);
    expect(result.usageByModel[QWEN]).toEqual(usage);
    expect(result.brief?.content).toContain("### Analyst");
    expect(result.brief?.content).toContain("### Checker");
    expect(result.brief?.content).toMatch(/ONE coherent answer/);
  });

  it("dependent work is sequential and receives the earlier model's output", async () => {
    const fake = fakeComplete({ reply: (model) => (model === QWEN ? "APPROACH: use a timer and clear it" : "REVIEW: fine") });
    const plan = planCollaboration({ message: CODE, pool: POOL3 });
    await runCollaboration({ plan, pool: POOL3, messages: [{ role: "user", content: CODE }], complete: fake.complete });
    expect(fake.calls).toHaveLength(2);
    const review = fake.calls[1];
    expect(review.messages[0].content).toMatch(/You are the Reviewer/);
    expect(review.messages.some((message) => message.content.includes("APPROACH: use a timer and clear it"))).toBe(true);
    expect(fake.calls[0].messages.some((message) => message.content.includes("REVIEW"))).toBe(false);
  });

  it("an unavailable model is replaced by the next suitable one, and the swap is recorded", async () => {
    const fake = fakeComplete({ fail: { [QWEN]: unavailable(QWEN) } });
    const plan = planCollaboration({ message: QUESTION, pool: [...POOL3, target(SMALL)] });
    const result = await runCollaboration({ plan, pool: [...POOL3, target(SMALL)], messages: conversation, complete: fake.complete });
    const analysis = result.results.find((item) => item.task.id === "analysis")!;
    expect(analysis.status).toBe("done");
    expect(analysis.model).not.toBe(QWEN);
    expect(analysis.attempts[0]).toMatchObject({ model: QWEN, outcome: "failed", detail: "provider_unavailable" });
    expect(analysis.attempts.at(-1)?.outcome).toBe("ok");
  });

  it("the coordinator is the last resort for a specialist task", async () => {
    const fake = fakeComplete({ fail: { [QWEN]: unavailable(QWEN), [LLAMA]: unavailable(LLAMA) } });
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    const result = await runCollaboration({ plan, pool: POOL3, messages: conversation, complete: fake.complete });
    expect(result.results.every((item) => item.status === "done" && item.model === MATRIX_MODEL_ID)).toBe(true);
  });

  it("when no model can do a task it is reported as failed — no output is invented", async () => {
    const fail = Object.fromEntries(POOL3.map((route) => [route.model, unavailable(route.model)]));
    const fake = fakeComplete({ fail });
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    const result = await runCollaboration({ plan, pool: POOL3, messages: conversation, complete: fake.complete });
    expect(result.results.map((item) => item.status)).toEqual(["failed", "failed"]);
    expect(result.results.every((item) => item.output === "")).toBe(true);
    expect(result.brief).toBeNull();
    expect(result.usageByModel).toEqual({});
  });

  it("a rate-limited model is cooled down and skipped for the next task", async () => {
    const limited = new AIProviderError({ provider: "Groq", model: QWEN, type: "rate_limit", detail: "429" });
    const fake = fakeComplete({ fail: { [QWEN]: limited } });
    const first = await completeWithFallback([target(QWEN), target(LLAMA)], () => ({ messages: [{ role: "user", content: "a" }] }), { complete: fake.complete });
    expect(first.completed?.target.model).toBe(LLAMA);
    expect(cooldownRemainingMs("qwen3-32b")).toBeGreaterThan(0);
    const second = await completeWithFallback([target(QWEN), target(LLAMA)], () => ({ messages: [{ role: "user", content: "b" }] }), { complete: fake.complete });
    expect(second.attempts[0]).toMatchObject({ model: QWEN, outcome: "skipped", detail: "rate-limited by the provider" });
    expect(fake.calls.filter((call) => call.model === QWEN)).toHaveLength(1);
  });

  it("token limits: a task too large for one model's budget goes to a model that can take it", async () => {
    const fake = fakeComplete();
    const big: AIMessage[] = [{ role: "user", content: "x".repeat(4 * 40_000) }]; // ≈40k tokens
    const { completed, attempts } = await completeWithFallback([target(QWEN), target(MATRIX_MODEL_ID)], () => ({ messages: big, maxTokens: 500 }), { complete: fake.complete });
    expect(attempts[0]).toMatchObject({ model: QWEN, outcome: "skipped" });
    // The default model's budget is also smaller than 40k, so it too is deferred —
    // and then the request is sent anyway rather than being refused outright.
    expect(completed).not.toBeNull();
    expect(fake.calls).toHaveLength(1);
  });

  it("specialist context is cut to each model's budget", async () => {
    const fake = fakeComplete();
    const long: AIMessage[] = [
      { role: "system", content: "You are MATRIX." },
      ...Array.from({ length: 60 }, (_, i): AIMessage => ({ role: i % 2 ? "assistant" : "user", content: `turn ${i} ` + "word ".repeat(400) })),
      { role: "user", content: QUESTION },
    ];
    const plan = planCollaboration({ message: QUESTION, pool: POOL3 });
    await runCollaboration({ plan, pool: POOL3, messages: long, complete: fake.complete });
    for (const call of fake.calls) {
      expect(estimateMessages(call.messages)).toBeLessThan(estimateMessages(long) / 3);
      expect(estimateMessages(call.messages)).toBeLessThanOrEqual(6_400);
      expect(call.messages.at(-1)?.content).toBe(QUESTION);
    }
  });

  it("completeWithRole gives review work to a different model than the author when one exists", async () => {
    const fake = fakeComplete();
    const reviewed = await completeWithRole(POOL3, ["review", "coding"], { messages: [{ role: "user", content: "review this" }] }, { complete: fake.complete, avoid: 0 });
    expect(reviewed.completed?.target.model).not.toBe(MATRIX_MODEL_ID);
    const alone = await completeWithRole(POOL3.slice(0, 1), ["review"], { messages: [{ role: "user", content: "review this" }] }, { complete: fake.complete, avoid: 0 });
    expect(alone.completed?.target.model).toBe(MATRIX_MODEL_ID);
  });
});

// ---------------------------------------------------------------------------
describe("comparison, conflicts and synthesis", () => {
  const result = (role: string, output: string, status: "done" | "failed" = "done"): TaskResult => ({
    task: { id: role, role, responsibility: `${role} work`, instructions: "", needs: [], dependsOn: [], assignee: 1, maxTokens: 100 },
    status, model: QWEN, label: "Qwen 3 32B", output, attempts: [], usage, durationMs: 1,
  });
  const plan = planCollaboration({ message: QUESTION, pool: POOL3 });

  it("recognises agreement", () => {
    const text = "Quicksort partitions the array around a pivot and recurses on both halves giving logarithmic depth";
    expect(compareOutputs([result("Analyst", text), result("Checker", `${text} on average`)]).agreement).toBe("high");
  });
  it("flags conflict when a reviewing role objects, and tells the coordinator to resolve it", () => {
    const outputs = [
      result("Architect", "Use a global mutable cache keyed by user id and never expire entries"),
      result("Reviewer", "This is wrong: the cache is unsafe across requests, a bug leaks data, expiry is missing, and it fails under load. The key choice is incorrect."),
    ];
    const comparison = compareOutputs(outputs);
    expect(comparison.agreement).toBe("low");
    expect(comparison.objections).toBeGreaterThanOrEqual(4);
    const brief = synthesisBrief(plan, outputs, comparison.agreement)!;
    expect(brief.content).toMatch(/decide which position is correct/);
    expect(brief.content).toMatch(/Do not mention these notes/);
  });
  it("tells the coordinator which ground was not covered when a specialist failed", () => {
    const outputs = [result("Analyst", "Some analysis of the question"), result("Checker", "", "failed")];
    const brief = synthesisBrief(plan, outputs, compareOutputs(outputs).agreement)!;
    expect(brief.content).toContain("No notes were produced for: Checker");
    expect(brief.content).not.toContain("### Checker");
  });
});

// ---------------------------------------------------------------------------
describe("final answer fallback", () => {
  const streamOf = (behaviour: Record<string, "ok" | "fail" | "die">) =>
    (async function* (targets: AIRouteTarget[]) {
      const model = targets[0].model;
      if (behaviour[model] === "fail") throw unavailable(model);
      yield { delta: `hello from ${model}`, target: targets[0] };
      if (behaviour[model] === "die") throw unavailable(model);
    }) as never;

  it("moves to the next model when the lead fails before any text", async () => {
    const swaps: string[] = [];
    let text = "";
    for await (const item of streamWithFallback(POOL3, { messages: [] }, { stream: streamOf({ [MATRIX_MODEL_ID]: "fail" }), onFallback: (from, to) => swaps.push(`${from.model}->${to.model}`) })) text += item.delta;
    expect(text).toBe(`hello from ${QWEN}`);
    expect(swaps).toEqual([`${MATRIX_MODEL_ID}->${QWEN}`]);
  });
  it("never restarts on another model once text has been shown", async () => {
    let text = "";
    await expect((async () => {
      for await (const item of streamWithFallback(POOL3, { messages: [] }, { stream: streamOf({ [MATRIX_MODEL_ID]: "die" }) })) text += item.delta;
    })()).rejects.toBeInstanceOf(AIProviderError);
    expect(text).toBe(`hello from ${MATRIX_MODEL_ID}`);
  });
  it("reports the real error when every model fails", async () => {
    const all = Object.fromEntries(POOL3.map((route) => [route.model, "fail" as const]));
    await expect((async () => { for await (const _ of streamWithFallback(POOL3, { messages: [] }, { stream: streamOf(all) })) void _; })()).rejects.toBeInstanceOf(AIProviderError);
  });
});

// ---------------------------------------------------------------------------
// End to end: real gateway route + real provider client, fake provider HTTP.
describe("gateway end to end", () => {
  const realFetch = globalThis.fetch;
  let catalog: string[] = [];
  let failing = new Set<string>();
  let requests: { model: string; stream: boolean; messages: AIMessage[]; auth: string }[] = [];
  let streamText: ((model: string) => string) | null = null;

  beforeEach(() => {
    stub.clearFaults();
    resetHealthCacheForTests();
    catalog = [MATRIX_MODEL_ID, QWEN, LLAMA];
    failing = new Set();
    requests = [];
    streamText = null;
    vi.stubEnv("GROQ_API_KEY", `gsk_multi_000000000000_${Math.random().toString(36).slice(2, 12)}`); // fresh key ⇒ fresh catalog cache
    vi.stubEnv("GPT_OSS_API_KEY", "");
    vi.stubEnv("GPT_OSS_BASE_URL", "");
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.startsWith("https://api.groq.com/openai/v1")) throw new Error(`unexpected outbound request: ${url}`);
      if (url.endsWith("/models")) return new Response(JSON.stringify({ data: catalog.map((id) => ({ id, context_window: 131072 })) }), { status: 200, headers: { "Content-Type": "application/json" } });
      const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean; messages: AIMessage[] };
      requests.push({ model: body.model, stream: body.stream === true, messages: body.messages, auth: String(new Headers(init?.headers).get("authorization")) });
      if (failing.has(body.model)) return new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "Content-Type": "application/json" } });
      if (body.stream) {
        const text = streamText?.(body.model) ?? `FINAL ANSWER by ${body.model}`;
        const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`;
        return new Response(sse, { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: `SPECIALIST NOTES by ${body.model}` }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.unstubAllEnvs();
    stub._state.docs.delete("model_pools/multi-model-user");
  });

  async function chat(message: string, extra: Record<string, unknown> = {}) {
    const res = await POST(new NextRequest("http://localhost:3000/api/ai", {
      method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "chat", message, is_temporary: true, stream: true, request_id: `mm-${Math.random().toString(36).slice(2)}`, ...extra }),
    }));
    const text = await res.text();
    const events = text.split("\n\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
    const reply = events.map((event) => (typeof event.delta === "string" ? event.delta : "")).join("");
    const steps = (events.find((event) => event.done)?.steps ?? []) as { id: string; label: string; detail?: string; status: string }[];
    return { status: res.status, events, reply, steps, done: events.some((event) => event.done === true), error: events.find((event) => event.error)?.error };
  }
  const put = (body: unknown) => putModels(new Request("http://localhost:3000/api/models", { method: "PUT", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", Host: "localhost:3000" }, body: JSON.stringify(body) }));

  it("availability comes from the live catalog: unlisted models are not offered and cannot be enabled", async () => {
    catalog = [MATRIX_MODEL_ID, QWEN];
    const statuses = await listModelStatus({ refresh: true });
    const by = Object.fromEntries(statuses.map((model) => [model.key, model.availability]));
    expect(by).toMatchObject({ "gpt-oss-120b": "available", "qwen3-32b": "available", "llama-3.3-70b": "not_offered", "gpt-oss-20b": "not_offered" });
    const saved = await setPoolPreference(stub as unknown as Db, "multi-model-user", { auto: false, enabled: ["qwen3-32b", "llama-3.3-70b"] });
    expect(saved).toEqual({ auto: false, enabled: ["qwen3-32b"] });
    await expect(setPoolPreference(stub as unknown as Db, "multi-model-user", { auto: false, enabled: ["llama-3.3-70b"] })).rejects.toThrow("MODEL_UNAVAILABLE");
    expect(MAX_ACTIVE_MODELS).toBe(4);
  });

  it("the Models API lists every model with real config, saves the pool, and leaks no credential", async () => {
    const before = await (await getModels(new Request("http://localhost:3000/api/models"))).json() as { models: { key: string; model_id: string; availability: string }[]; pool: unknown };
    expect(before.models).toHaveLength(MODEL_REGISTRY.length);
    expect(before.pool).toEqual({ auto: true, enabled: [] });
    expect(JSON.stringify(before)).not.toContain("gsk_");
    const saved = await put({ auto: false, enabled: ["gpt-oss-120b", "qwen3-32b"] });
    expect(saved.status).toBe(200);
    const after = await (await getModels(new Request("http://localhost:3000/api/models"))).json() as { pool: unknown };
    expect(after.pool).toEqual({ auto: false, enabled: ["gpt-oss-120b", "qwen3-32b"] });
    expect((await put({ auto: false, enabled: [] })).status).toBe(400);
    expect((await put({ auto: "yes" })).status).toBe(400);
    // The saved selection is what the gateway uses.
    const pool = await resolvePool(stub as unknown as Db, "multi-model-user");
    expect(pool.targets.map((item) => item.model)).toEqual([MATRIX_MODEL_ID, QWEN]);
  });

  it("three models produce ONE answer: two specialists in parallel, then the coordinator's synthesis", async () => {
    const res = await chat(QUESTION);
    expect(res.status).toBe(200);
    expect(res.done).toBe(true);
    expect(res.reply).toBe(`FINAL ANSWER by ${MATRIX_MODEL_ID}`);
    expect(res.reply).not.toContain("SPECIALIST NOTES");
    const specialists = requests.filter((request) => !request.stream);
    expect(specialists.map((request) => request.model).sort()).toEqual([LLAMA, QWEN].sort());
    const final = requests.filter((request) => request.stream);
    expect(final).toHaveLength(1);
    expect(final[0].model).toBe(MATRIX_MODEL_ID);
    // The coordinator inspects both outputs.
    const brief = final[0].messages.find((message) => message.role === "system" && message.content.includes("### Analyst"))!;
    expect(brief.content).toContain(`SPECIALIST NOTES by ${QWEN}`);
    expect(brief.content).toContain(`SPECIALIST NOTES by ${LLAMA}`);
    expect(final[0].messages.at(-1)).toMatchObject({ role: "user", content: QUESTION });
    // Steps use friendly names, not provider IDs.
    expect(res.steps.find((step) => step.id === "route")?.label).toBe("3 models working together");
    expect(res.steps.some((step) => step.id === "task-analysis" && step.status === "done" && step.detail === "Qwen 3 32B")).toBe(true);
    expect(res.steps.some((step) => step.id === "compare")).toBe(true);
    expect(JSON.stringify(res.steps)).not.toContain("qwen/");
    expect(requests.every((request) => request.auth.startsWith("Bearer gsk_multi_"))).toBe(true);
  });

  it("one enabled model: a single request, no collaboration", async () => {
    const res = await chat(QUESTION, { models: { auto: false, enabled: ["gpt-oss-120b"] } });
    expect(res.reply).toBe(`FINAL ANSWER by ${MATRIX_MODEL_ID}`);
    expect(requests).toHaveLength(1);
    expect(res.steps.find((step) => step.id === "route")?.label).toBe("Using GPT OSS 120B");
  });

  it("two enabled models: one specialist plus the synthesis", async () => {
    const res = await chat(QUESTION, { models: { auto: false, enabled: ["gpt-oss-120b", "llama-3.3-70b"] } });
    expect(res.done).toBe(true);
    expect(requests.map((request) => `${request.model}:${request.stream}`)).toEqual([`${LLAMA}:false`, `${MATRIX_MODEL_ID}:true`]);
  });

  it("a short question uses one model even with three enabled", async () => {
    await chat("What is the capital of France?");
    expect(requests).toHaveLength(1);
  });

  it("an unavailable specialist is replaced and the answer still completes", async () => {
    failing = new Set([QWEN]);
    const res = await chat(QUESTION);
    expect(res.done).toBe(true);
    expect(res.reply).toBe(`FINAL ANSWER by ${MATRIX_MODEL_ID}`);
    const step = res.steps.find((item) => item.id === "task-analysis")!;
    expect(step.status).toBe("done");
    expect(step.detail).toMatch(/Qwen 3 32B failed/);
  });

  it("when the lead model is down, the next model writes the answer and the swap is shown", async () => {
    failing = new Set([MATRIX_MODEL_ID]);
    const res = await chat(QUESTION);
    expect(res.done).toBe(true);
    expect(res.reply).toBe(`FINAL ANSWER by ${LLAMA}`); // next coordinator by rank
    expect(res.steps.some((step) => step.label === "GPT OSS 120B did not respond" && step.detail === "Continuing with Llama 3.3 70B")).toBe(true);
  });

  it("when every model is down the user gets a real error and no invented reply", async () => {
    failing = new Set([MATRIX_MODEL_ID, QWEN, LLAMA]);
    const res = await chat(QUESTION);
    expect(res.done).toBe(false);
    expect(res.reply).toBe("");
    expect(res.error).toBe("AI_PROVIDER_UNAVAILABLE");
  });

  it("a client cannot force a model that is not available", async () => {
    catalog = [MATRIX_MODEL_ID];
    const res = await chat(QUESTION, { models: { auto: false, enabled: ["qwen3-32b"] }, model: "made-up", provider: "elsewhere" });
    expect(res.done).toBe(true);
    expect(requests.map((request) => request.model)).toEqual([MATRIX_MODEL_ID]);
    expect(res.steps.some((step) => step.label === "Qwen 3 32B is not available")).toBe(true);
  });

  it("separate answers on request: each model's own reply, labelled, with no synthesis call", async () => {
    const res = await chat("Show separate answers from each model: explain recursion in programming with an example please.");
    expect(res.done).toBe(true);
    expect(requests.every((request) => !request.stream)).toBe(true);
    expect(requests.map((request) => request.model).sort()).toEqual([MATRIX_MODEL_ID, QWEN, LLAMA].sort());
    for (const label of ["GPT OSS 120B", "Qwen 3 32B", "Llama 3.3 70B"]) expect(res.reply).toContain(`### ${label}`);
    expect(res.reply).toContain(`SPECIALIST NOTES by ${QWEN}`);
  });

  // --- Agent / build pipeline: the model team on one project --------------
  function dbWithWrites(): Db {
    type Ref = { get: () => Promise<unknown>; set: (data: unknown, opts?: unknown) => Promise<unknown>; update?: (data: unknown) => Promise<unknown>; create?: (data: unknown) => Promise<unknown>; delete?: () => Promise<unknown> };
    const ops = {
      get: (ref: Ref) => ref.get(),
      set: (ref: Ref, data: unknown, opts?: unknown) => { void ref.set(data, opts); return ops; },
      update: (ref: Ref, data: unknown) => { void (ref.update ? ref.update(data) : ref.set(data, { merge: true })); return ops; },
      create: (ref: Ref, data: unknown) => { void (ref.create ? ref.create(data) : ref.set(data)); return ops; },
      delete: (ref: Ref) => { void ref.delete?.(); return ops; },
      commit: async () => undefined,
    };
    return Object.assign(Object.create(stub as object), { runTransaction: async <T,>(fn: (tx: typeof ops) => Promise<T>) => fn(ops), batch: () => ops }) as Db;
  }
  const buildUser = { uid: "multi-model-user", email: "multi@example.com", emailVerified: true };
  async function build(runId: string, name: string) {
    const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rise Bakery</title>
<style>:root{--ink:#2b1d14;--cream:#fbf5ea;--crust:#b8642a}body{margin:0;font-family:Georgia,serif;background:var(--cream);color:var(--ink)}header{padding:4rem 1.5rem;text-align:center}h1{font-size:3rem;margin:0}nav a{margin:0 .75rem;color:var(--crust)}section{max-width:60rem;margin:0 auto;padding:3rem 1.5rem}.menu{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1.5rem}.card{background:#fff;border-radius:1rem;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}footer{padding:2rem;text-align:center;background:var(--ink);color:var(--cream)}@media(max-width:600px){h1{font-size:2.2rem}}</style></head>
<body><header><h1>Rise Bakery</h1><p>Slow-fermented bread, baked every morning on Mill Lane.</p><nav><a href="#menu">Menu</a><a href="#contact">Contact</a></nav></header>
<main><section id="menu"><h2>Today's menu</h2><div class="menu"><article class="card"><h3>Country sourdough</h3><p>48-hour ferment, crackling crust.</p></article><article class="card"><h3>Cardamom buns</h3><p>Soft, fragrant and glazed.</p></article><article class="card"><h3>Seeded rye</h3><p>Dense, nutty and good for a week.</p></article></div></section>
<section id="contact"><h2>Find us</h2><p>12 Mill Lane. Open Tuesday to Sunday, 7am to 3pm.</p><p><a href="mailto:hello@rise.example">hello@rise.example</a></p></section></main>
<footer><p>Rise Bakery</p></footer></body></html>`;
    streamText = () => `I built the bakery site.\n\n<<<MATRIX_FILE path="index.html">>>\n${page.replaceAll("Rise", name)}\n<<<END_MATRIX_FILE>>>`;
    const db = dbWithWrites();
    return runBuildPipeline({
      d: db, user: buildUser, provider: new FirestoreDeploymentProvider(db, buildUser), runId, requestId: `${runId}-req`,
      prompt: `Build a one-page website for a neighbourhood bakery called ${name} with a menu and contact section.`,
      actions: { build: true, publish: false, preview: false }, chatMode: "agent", isTemporary: true,
    });
  }

  it("Agent build: the team works on one project; the lead writes the files", async () => {
    const result = await build("mm-build-1", "Rise");
    expect(result.run.error, JSON.stringify(result.run.error)).toBeFalsy();
    expect(result.run.status).toBe("succeeded");
    expect(result.run.model).toMatchObject({ model: MATRIX_MODEL_ID });
    const log = JSON.stringify(result.run);
    expect(log).toContain("Model team: GPT OSS 120B, Llama 3.3 70B, Qwen 3 32B");
    // Only code-capable registered models were asked, and all for the same project.
    expect(requests.every((request) => [MATRIX_MODEL_ID, QWEN, LLAMA].includes(request.model))).toBe(true);
  });

  it("Agent build: when the lead model is down another model writes the files and the run still succeeds", async () => {
    failing = new Set([MATRIX_MODEL_ID]);
    const result = await build("mm-build-2", "Hearth");
    expect(result.run.error, JSON.stringify(result.run.error)).toBeFalsy();
    expect(result.run.status).toBe("succeeded");
    expect(result.run.model?.model).not.toBe(MATRIX_MODEL_ID);
    expect(JSON.stringify(result.run)).toMatch(/GPT OSS 120B could not take the implement stage \(provider_unavailable\); continuing with the next model/);
    const written = [...stub._state.docs.entries()].filter(([key, value]) => /\/files\//.test(key) && key.includes(String(result.projectId)) && String((value as { content?: string }).content ?? "").includes("Hearth Bakery"));
    expect(written.length).toBeGreaterThanOrEqual(1);
  });

  it("Agent build: when every model is down nothing is written and the failure is reported", async () => {
    failing = new Set([MATRIX_MODEL_ID, QWEN, LLAMA]);
    const filesBefore = [...stub._state.docs.keys()].filter((key) => key.includes("/files/")).length;
    const result = await build("mm-build-3", "Crumb");
    expect(result.run.status).toBe("failed");
    expect(result.run.error?.code).toBe("AI_PROVIDER_FAILED");
    expect(result.run.error?.message).toMatch(/None of the enabled models could produce the files/);
    expect(result.run.error?.message).toMatch(/No files were written/i);
    expect([...stub._state.docs.keys()].filter((key) => key.includes("/files/")).length).toBe(filesBefore);
  });
});
