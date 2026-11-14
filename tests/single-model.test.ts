// GPT OSS 120B is the DEFAULT model, and the only one used unless the
// provider's live catalog confirms another registered model is offered and the
// user has it enabled (multi-model behaviour: tests/multi-model.test.ts).
// This suite covers a deployment where only the default model is available.
//
// These tests drive the REAL gateway route, the REAL build pipeline and the
// REAL provider client against a local HTTP server, and intercept every
// outbound fetch, to prove:
//   • chat, Agent, website generation, project editing and every agent
//     prompt (coding / design / deployment / research …) request the one
//     configured model ID;
//   • tool calling and streaming work on it;
//   • voice transcripts reach it as text;
//   • nothing is ever sent to another model or provider, even when the model
//     fails and credentials for removed providers are still in the environment.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";
import { startProviderStub, type StubBehavior, type StubCall } from "./helpers/provider-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => {
  const user = { uid: "single-model-user", email: "one@example.com", emailVerified: true };
  return { verifySession: vi.fn(async () => user), getSessionUser: vi.fn(async () => user) };
});

import { POST } from "../src/app/api/ai/route";
import { GET as getModels } from "../src/app/api/models/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { MATRIX_MODEL_ID, MATRIX_MODEL_LABEL, MATRIX_MODEL_PROVIDER, MATRIX_MODEL_BASE_URL, dedicatedEndpointModelId, isMatrixModelId } from "../src/lib/ai/model";
import { createAIRoutes, matrixModelRoute, matrixModelStatus, resolveExecutionRoutes } from "../src/lib/ai/config";
import { completeWithModel, streamWithModel } from "../src/lib/ai/executor";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";
import { runBuildPipeline } from "../src/lib/server/build";
import { FirestoreDeploymentProvider } from "../src/lib/deploy/firestore-provider";
import { MATRIX_MODES } from "../src/lib/ai/modes";
import { classifyGatewayResponse } from "../src/lib/api-errors";
import type { Db } from "../src/lib/firebase/admin";

const stub: FirestoreStub = sharedFirestoreStub();
const holder: { current: StubBehavior } = { current: { kind: "ok", content: "OK" } };
let calls: StubCall[] = [];
let stubOrigin = "";
let outbound: string[] = [];
const realFetch = globalThis.fetch;

const LEGACY_ENV: Record<string, string> = {
  GLM_API_KEY: "glm-legacy-key", ZAI_API_KEY: "zai-legacy-key", GLM_MODEL: "glm-5-turbo", GLM_CODING_MODEL: "glm-5-turbo",
  GEMINI_API_KEY: "gemini-legacy-key", GEMINI_MODEL: "gemini-3-flash", OPENROUTER_API_KEY: "sk-or-legacy",
  OPENROUTER_CODING_MODEL: "nvidia/nemotron-3-ultra-550b-a55b:free", ANTHROPIC_API_KEY: "sk-ant-legacy", ANTHROPIC_MODEL: "claude-x",
  OPENAI_MODEL: "gpt-other", OLLAMA_BASE_URL: "http://127.0.0.1:1/v1", OLLAMA_MODEL: "llama",
  GROQ_CHAT_MODEL: "llama-3.3-70b-versatile", GROQ_CODING_MODEL: "qwen/qwen3-32b", GROQ_FAST_MODEL: "llama-3.1-8b-instant",
};

beforeAll(async () => {
  const started = await startProviderStub(holder);
  calls = started.calls;
  stubOrigin = `http://127.0.0.1:${started.port}`;
  return () => started.server.close();
});

beforeEach(() => {
  stub.clearFaults();
  resetHealthCacheForTests();
  holder.current = { kind: "ok", content: "OK" };
  calls.length = 0;
  outbound = [];
  // Credentials and model IDs of every removed integration stay in the
  // environment for the whole suite: none of them may ever be used.
  for (const [key, value] of Object.entries(LEGACY_ENV)) vi.stubEnv(key, value);
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("GPT_OSS_API_KEY", "sk-stub-key-1234567890");
  vi.stubEnv("GPT_OSS_BASE_URL", `${stubOrigin}/v1`);
  vi.stubEnv("GPT_OSS_MODEL", "");
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    outbound.push(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    return realFetch(input, init);
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

async function post(body: unknown) {
  const res = await POST(new NextRequest("http://localhost:3000/api/ai", {
    method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" }, body: JSON.stringify(body),
  }));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* SSE */ }
  return { status: res.status, text, json };
}

const completions = () => calls.filter((call) => call.url.endsWith("/chat/completions"));

/** Every model request made so far named the one model and went to the one host. */
function expectOnlyTheOneModel(minimumCalls = 1) {
  const made = completions();
  expect(made.length).toBeGreaterThanOrEqual(minimumCalls);
  for (const call of made) expect(call.body?.model).toBe(MATRIX_MODEL_ID);
  for (const url of outbound) expect(url.startsWith(stubOrigin), `unexpected outbound request to ${url}`).toBe(true);
}

describe("one authoritative model configuration", () => {
  it("defines GPT OSS 120B on Groq, once", () => {
    expect(MATRIX_MODEL_ID).toBe("openai/gpt-oss-120b");
    expect(MATRIX_MODEL_LABEL).toBe("GPT OSS 120B");
    expect(MATRIX_MODEL_PROVIDER).toBe("Groq");
    expect(MATRIX_MODEL_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(isMatrixModelId("openai/gpt-oss-120b")).toBe(true);
    expect(isMatrixModelId("glm-5-turbo")).toBe(false);
    expect(isMatrixModelId("gemini-3-flash")).toBe(false);
  });

  it("uses Groq with the fixed ID when GROQ_API_KEY is set, ignoring model overrides", () => {
    vi.stubEnv("GPT_OSS_API_KEY", "");
    vi.stubEnv("GPT_OSS_BASE_URL", "");
    vi.stubEnv("GROQ_API_KEY", "gsk_test");
    const route = matrixModelRoute();
    expect(route).toMatchObject({ provider: "Groq", providerId: "groq", model: "openai/gpt-oss-120b" });
    expect(matrixModelStatus()).toMatchObject({ configured: true, model: "openai/gpt-oss-120b", credential: "GROQ_API_KEY" });
  });

  it("returns exactly one route for chat and for Agent — the same one — and none without a key", async () => {
    const chat = createAIRoutes(false);
    const agent = createAIRoutes(true);
    expect(chat).toHaveLength(1);
    expect(agent).toHaveLength(1);
    expect(chat[0].model).toBe(MATRIX_MODEL_ID);
    expect(agent[0].model).toBe(MATRIX_MODEL_ID);
    expect((await resolveExecutionRoutes()).routes).toHaveLength(1);

    vi.stubEnv("GPT_OSS_API_KEY", "");
    vi.stubEnv("GPT_OSS_BASE_URL", "");
    // Only removed providers' keys remain: MATRIX is "not configured", it does not use them.
    expect(matrixModelRoute()).toBeNull();
    expect(createAIRoutes(true)).toEqual([]);
    expect(matrixModelStatus().configured).toBe(false);
  });

  it("a dedicated endpoint can only name the same model", () => {
    expect(dedicatedEndpointModelId("gpt-oss-120b")).toBe("gpt-oss-120b");
    expect(dedicatedEndpointModelId("openai/gpt-oss-120b")).toBe("openai/gpt-oss-120b");
    for (const other of ["glm-5-turbo", "gemini-3-flash", "llama-3.3-70b-versatile", "openai/gpt-oss-20b", "gpt-4o"]) {
      expect(dedicatedEndpointModelId(other)).toBe(MATRIX_MODEL_ID);
    }
  });

  it("the Models API reports only the default model as available on this deployment", async () => {
    const res = await getModels();
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.model).toMatchObject({ id: MATRIX_MODEL_ID, label: "GPT OSS 120B", configured: true, tool_calling: true, streaming: true, vision: false });
    const models = body.models as { model_id: string; availability: string; is_default: boolean }[];
    expect(models.filter((model) => model.availability === "available").map((model) => model.model_id)).toEqual([MATRIX_MODEL_ID]);
    // No hosted credential here, so every additional model is reported as not configured — never as working.
    expect(models.filter((model) => !model.is_default).every((model) => model.availability === "not_configured")).toBe(true);
    expect(body.pool).toEqual({ auto: true, enabled: [] });
    expect(JSON.stringify(body)).not.toContain("sk-stub-key");
    expect(JSON.stringify(body)).not.toMatch(/glm|gemini|openrouter|anthropic|claude|nemotron/i);
  });
});

describe("every surface runs on GPT OSS 120B", () => {
  it("1. normal chat", async () => {
    holder.current = { kind: "ok", content: "CHAT-OK" };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "one-chat-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("CHAT-OK");
    expect(res.json?.model).toBe(MATRIX_MODEL_ID);
    expectOnlyTheOneModel();
  });

  it("2. Agent mode", async () => {
    holder.current = { kind: "ok", content: "AGENT-OK" };
    const res = await post({ action: "chat", mode: "agent", stream: false, message: "Explain how my deployment works.", is_temporary: true, request_id: "one-agent-1" });
    expect(res.status).toBe(200);
    expect(res.json?.model).toBe(MATRIX_MODEL_ID);
    expectOnlyTheOneModel();
  });

  it("5–7. coding, design, deployment, debugging, research and planning requests in every mode", async () => {
    const prompts: Array<[string, string]> = [
      ["code", "Write a TypeScript function that debounces a callback and explain it."],
      ["code", "Debug this stack trace: TypeError: cannot read properties of undefined (reading 'map')."],
      ["agent", "Design a visual direction for a bakery brand: palette, typography and layout."],
      ["agent", "How do I deploy this project and attach a custom domain?"],
      ["agent", "Plan the tasks for adding a contact form to my project."],
      ["research", "Research the trade-offs between server-side rendering and static generation."],
      ["general", "আমাকে বাংলায় বলো, ওয়েবসাইট কীভাবে কাজ করে?"],
    ];
    for (const [mode, message] of prompts) {
      const res = await post({ action: "chat", mode, stream: false, message, is_temporary: true, request_id: `one-mode-${Math.random().toString(36).slice(2, 10)}` });
      expect(res.status, `${mode}: ${message}`).toBe(200);
      expect(res.json?.model, `${mode}: ${message}`).toBe(MATRIX_MODEL_ID);
    }
    // Every selectable lane and strategy is a prompt style on the same model.
    for (const lane of ["auto", "fast", "balanced", "reasoning", "coding"]) {
      const res = await post({ action: "chat", lane, strategy: "quality", stream: false, message: "Summarise what HTTP is.", is_temporary: true, request_id: `one-lane-${lane}-1` });
      expect(res.status, lane).toBe(200);
      expect(res.json?.model, lane).toBe(MATRIX_MODEL_ID);
    }
    expect(MATRIX_MODES.map((mode) => mode.id)).toEqual(expect.arrayContaining(["general", "code", "research", "agent"]));
    expectOnlyTheOneModel(prompts.length + 5);
  });

  it("a client cannot choose a model: provider_id / model_id in the request are ignored", async () => {
    const res = await post({ action: "chat", message: "hello", is_temporary: true, provider_id: "glm", model_id: "glm-5-turbo", prefer_fallback: true, request_id: "one-select-1" });
    expect(res.status).toBe(200);
    expect(res.json?.model).toBe(MATRIX_MODEL_ID);
    expectOnlyTheOneModel();
  });

  it("8. tool calling", async () => {
    stub._state.docs.set("projects/one-model-project", {
      owner_id: "single-model-user", title: "Tool project", stack: "static-web", revision: 1,
      file_count: 1, archived_at: null, updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    holder.current = { kind: "tool_call_then_ok", toolName: "projects.list", arguments: "{}", finalContent: "You have one project: Tool project." };
    const res = await post({ action: "chat", mode: "agent", stream: false, message: "Look at my projects and summarize them.", request_id: "one-tool-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("You have one project: Tool project.");
    expect(res.json?.analytics).toMatchObject({ toolsExecuted: 1 });
    const made = completions();
    expect(made).toHaveLength(2);
    expect(Array.isArray(made[0].body?.tools)).toBe(true);
    expect(made[1].body?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call-1" })]));
    expectOnlyTheOneModel(2);
  });

  it("9. streaming", async () => {
    holder.current = { kind: "stream", deltas: ["Str", "eam", "ing ", "works"] };
    const res = await post({ action: "chat", message: "stream please", is_temporary: true, stream: true, request_id: "one-stream-1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Str");
    expect(res.text).toContain('"done":true');
    expect(res.text).toContain(MATRIX_MODEL_ID);
    expect(completions().at(-1)?.body?.stream).toBe(true);
    expectOnlyTheOneModel();
  });

  it("10. a voice transcript is sent to the model as text", async () => {
    const transcript = "আমার জন্য একটি রেস্তোরাঁর ওয়েবসাইট সম্পর্কে ধারণা দাও, with a modern look";
    holder.current = { kind: "ok", content: "VOICE-OK" };
    const res = await post({ action: "chat", message: transcript, is_temporary: true, input_source: "voice", request_id: "one-voice-1" });
    expect(res.status).toBe(200);
    expect(res.json?.model).toBe(MATRIX_MODEL_ID);
    const sent = JSON.stringify(completions().at(-1)?.body?.messages);
    expect(sent).toContain("রেস্তোরাঁর");
    expect(sent).toContain("with a modern look");
    expectOnlyTheOneModel();

    // Speech-to-text is a separate Whisper service: it never calls a chat model.
    const transcribe = readFileSync("src/app/api/voice/transcribe/route.ts", "utf8");
    expect(transcribe).toContain("/audio/transcriptions");
    expect(transcribe).not.toMatch(/chat\/completions|generateContent|gemini|glm/i);
  });
});

describe("3–4. website generation and project editing", () => {
  const user = { uid: "single-model-user", email: "one@example.com", emailVerified: true };
  const noDeploy = new Proxy({}, { get: () => () => { throw new Error("deployment must not run in this test"); } }) as never;

  it("website generation asks GPT OSS 120B, and a provider failure writes no files and claims nothing", async () => {
    holder.current = { kind: "status", status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) };
    const filesBefore = [...stub._state.docs.keys()].filter((key) => key.includes("/files/")).length;
    const result = await runBuildPipeline({
      d: stub as unknown as Db, user, provider: noDeploy, runId: "one-build-1", requestId: "one-build-req-1",
      prompt: "Build a one-page website for a neighbourhood bakery called Rise with a menu and contact section.",
      actions: { build: true, publish: false, preview: false }, chatMode: "agent", isTemporary: true,
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.error?.code).toBe("AI_PROVIDER_FAILED");
    expect(result.run.error?.message).toContain("GPT OSS 120B");
    expect(result.run.error?.message).toMatch(/No files were written/i);
    expect([...stub._state.docs.keys()].filter((key) => key.includes("/files/")).length).toBe(filesBefore);
    expectOnlyTheOneModel();
  });

  /** The in-memory Firestore stub plus the transaction/batch calls the project store uses. */
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
    return Object.assign(Object.create(stub as object), {
      runTransaction: async <T,>(fn: (tx: typeof ops) => Promise<T>) => fn(ops),
      batch: () => ops,
    }) as Db;
  }

  it("website generation writes the files GPT OSS 120B returned — and only reports files that exist", async () => {
    const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rise Bakery</title>
<style>:root{--ink:#2b1d14;--cream:#fbf5ea;--crust:#b8642a}body{margin:0;font-family:Georgia,serif;background:var(--cream);color:var(--ink)}header{padding:4rem 1.5rem;text-align:center}h1{font-size:3rem;margin:0}nav a{margin:0 .75rem;color:var(--crust)}section{max-width:60rem;margin:0 auto;padding:3rem 1.5rem}.menu{display:grid;grid-template-columns:repeat(auto-fit,minmax(14rem,1fr));gap:1.5rem}.card{background:#fff;border-radius:1rem;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}footer{padding:2rem;text-align:center;background:var(--ink);color:var(--cream)}@media(max-width:600px){h1{font-size:2.2rem}}</style></head>
<body><header><h1>Rise Bakery</h1><p>Slow-fermented bread, baked every morning on Mill Lane.</p><nav><a href="#menu">Menu</a><a href="#contact">Contact</a></nav></header>
<main><section id="menu"><h2>Today's menu</h2><div class="menu"><article class="card"><h3>Country sourdough</h3><p>48-hour ferment, crackling crust.</p></article><article class="card"><h3>Cardamom buns</h3><p>Soft, fragrant and glazed.</p></article><article class="card"><h3>Seeded rye</h3><p>Dense, nutty and good for a week.</p></article></div></section>
<section id="contact"><h2>Find us</h2><p>12 Mill Lane. Open Tuesday to Sunday, 7am to 3pm.</p><p><a href="mailto:hello@rise.example">hello@rise.example</a></p></section></main>
<footer><p>Rise Bakery</p></footer></body></html>`;
    holder.current = { kind: "stream", deltas: ["I built the bakery site.\n\n", '<<<MATRIX_FILE path="index.html">>>\n', page, "\n<<<END_MATRIX_FILE>>>"] };
    const db = dbWithWrites();
    const result = await runBuildPipeline({
      d: db, user, provider: new FirestoreDeploymentProvider(db, user), runId: "one-build-ok-1", requestId: "one-build-ok-req-1",
      prompt: "Build a one-page website for a neighbourhood bakery called Rise with a menu and contact section.",
      actions: { build: true, publish: false, preview: false }, chatMode: "agent", isTemporary: true,
    });
    expectOnlyTheOneModel();
    const written = [...stub._state.docs.entries()].filter(([key, value]) => /\/files\//.test(key) && String((value as { content?: string }).content ?? "").includes("Rise Bakery") && key.includes(String(result.projectId)));
    expect(result.run.error, JSON.stringify(result.run.error)).toBeFalsy();
    expect(result.run.status).toBe("succeeded");
    expect(result.projectId).toBeTruthy();
    expect(written.length).toBeGreaterThanOrEqual(1);
    expect(result.run.model).toMatchObject({ model: MATRIX_MODEL_ID });
  });

  it("editing an existing project asks GPT OSS 120B and leaves the project untouched when it fails", async () => {
    const now = new Date().toISOString();
    const projectId = "one-edit-project";
    stub._state.docs.set(`projects/${projectId}`, { owner_id: user.uid, title: "Rise Bakery", stack: "static-web", revision: 1, file_count: 1, archived_at: null, updated_at: now, created_at: now });
    const original = "<!doctype html><html><head><title>Rise</title></head><body><h1>Rise Bakery</h1></body></html>";
    stub._state.docs.set(`projects/${projectId}/files/index.html`, { path: "index.html", content: original, language: "html", size: original.length, updated_at: now });
    holder.current = { kind: "status", status: 500, body: "upstream exploded", contentType: "text/plain" };
    const snapshot = JSON.stringify([...stub._state.docs.entries()].filter(([key]) => key.startsWith(`projects/${projectId}`)));
    const result = await runBuildPipeline({
      d: stub as unknown as Db, user, provider: noDeploy, runId: "one-edit-1", requestId: "one-edit-req-1", projectId,
      prompt: "Change the heading colour to dark green and add an opening-hours section.",
      actions: { build: true, publish: false, preview: false }, chatMode: "agent", isTemporary: true,
    });
    expect(result.run.status).toBe("failed");
    expect(result.run.error?.code).toBe("AI_PROVIDER_FAILED");
    expect(completions().length).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify([...stub._state.docs.entries()].filter(([key]) => key.startsWith(`projects/${projectId}`)))).toBe(snapshot);
    for (const call of completions()) expect(call.body?.model).toBe(MATRIX_MODEL_ID);
    for (const url of outbound) expect(url.startsWith(stubOrigin)).toBe(true);
  });
});

describe("11–12. no other model, no hidden fallback", () => {
  it("a failing model returns the real provider error — one retry on the same model, then stop", async () => {
    holder.current = { kind: "status", status: 503, body: JSON.stringify({ error: { message: "overloaded" } }) };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "one-fail-1" });
    expect(res.status).toBe(503);
    expect(res.json?.error).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(res.json?.reply).toBeUndefined();
    const made = completions();
    expect(made.length).toBeGreaterThanOrEqual(1);
    expect(made.length).toBeLessThanOrEqual(2);
    expectOnlyTheOneModel();
    const copy = classifyGatewayResponse(res.status, String(res.json?.error));
    expect(copy.retryable).toBe(true);
    expect(copy.detail).toMatch(/temporarily unavailable/i);
    expect(copy.detail).toMatch(/kept/i);
  });

  it("a hosted key whose model list cannot be read enables no additional model", async () => {
    // The hosted catalog is unreachable: nothing beyond the default model may be assumed available.
    vi.stubEnv("GROQ_API_KEY", "gsk_present_but_catalog_unreachable_000000");
    const hosted: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (url.startsWith("https://api.groq.com/")) { hosted.push(url); throw new TypeError("fetch failed"); }
      outbound.push(url);
      return realFetch(input, init);
    }) as typeof fetch;
    const { listModelStatus, resolvePool } = await import("../src/lib/ai/models/pool");
    const statuses = await listModelStatus({ refresh: true });
    expect(statuses.filter((model) => model.availability === "available").map((model) => model.model_id)).toEqual([MATRIX_MODEL_ID]);
    expect(statuses.filter((model) => !model.is_default).every((model) => model.availability === "unverified")).toBe(true);
    const pool = await resolvePool(null, null);
    expect(pool.targets.map((target) => target.model)).toEqual([MATRIX_MODEL_ID]);
    holder.current = { kind: "ok", content: "fine" };
    const res = await post({ action: "chat", message: "Explain in detail how binary search works and why it is logarithmic, step by step please.", is_temporary: true, request_id: "one-unverified-1" });
    expect(res.status).toBe(200);
    expect(hosted.every((url) => url.endsWith("/models"))).toBe(true); // only the catalog was ever asked
    expectOnlyTheOneModel();
  });

  it("authentication, rate-limit and timeout-class failures never reach a second provider", async () => {
    for (const status of [401, 403, 404, 429, 500, 502]) {
      calls.length = 0;
      holder.current = { kind: "status", status, body: JSON.stringify({ error: { message: `stub ${status}` } }) };
      const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: `one-fail-${status}` });
      expect(res.status, String(status)).toBeGreaterThanOrEqual(400);
      expect(res.json?.reply, String(status)).toBeUndefined();
      expect(completions().length, String(status)).toBeLessThanOrEqual(2);
      expectOnlyTheOneModel();
    }
  });

  it("a stream that dies is reported as an error, not continued on another model", async () => {
    holder.current = { kind: "stream_then_die", deltas: ["PAR", "TIAL"] };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, stream: true, request_id: "one-fail-sse-1" });
    expect(res.text).toContain("PAR");
    expect(res.text).toContain("AI_PROVIDER_UNAVAILABLE");
    expect(res.text).not.toContain('"done":true');
    expect(completions()).toHaveLength(1);
    expectOnlyTheOneModel();
  });

  it("the executor sends one request to one registered model only", async () => {
    const route = matrixModelRoute()!;
    holder.current = { kind: "ok", content: "fine" };
    const ok = await completeWithModel([route], { messages: [{ role: "user", content: "hi" }] });
    expect(ok.target.model).toBe(MATRIX_MODEL_ID);
    const impostor = { ...route, model: "glm-5-turbo" };
    await expect(completeWithModel([impostor], { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/Refusing to send a request/);
    await expect(completeWithModel([route, route], { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/Refusing to send a request/);
    await expect((async () => { for await (const _ of streamWithModel([impostor], { messages: [{ role: "user", content: "hi" }] })) void _; })()).rejects.toThrow(/Refusing to send a request/);
    expect(completions()).toHaveLength(1);
    expectOnlyTheOneModel();
  });

  it("images are refused honestly instead of being routed to a vision model", async () => {
    const chat = await post({ action: "chat", message: "what is in this picture?", is_temporary: true, image_storage_path: "security-screenshots/single-model-user/a.png", request_id: "one-vision-1" });
    expect(chat.status).toBe(422);
    expect(chat.json?.error).toBe("VISION_NOT_SUPPORTED");
    const scan = await post({ action: "scan", storage_path: "security-screenshots/single-model-user/a.png" });
    expect(scan.status).toBe(422);
    expect(scan.json?.error).toBe("VISION_NOT_SUPPORTED");
    expect(completions()).toHaveLength(0);
    expect(outbound).toEqual([]);
    expect(classifyGatewayResponse(422, "VISION_NOT_SUPPORTED").title).toBe("Images are not supported");
  });
});

describe("the removed integrations are gone from the codebase", () => {
  function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(name) ? [full] : [];
    });
  }
  const sources = walk("src").map((path) => ({ path, text: readFileSync(path, "utf8") }));

  it("has no provider modules for other models", () => {
    for (const gone of ["glm", "gemini", "anthropic", "openrouter", "managed-providers", "runtime-config", "provider-registry", "model-routing", "model-preferences"]) {
      expect(sources.some((file) => file.path.endsWith(`src/lib/ai/${gone}.ts`)), gone).toBe(false);
    }
    expect(sources.some((file) => /glm-provider|managed-ai-providers|ai-provider-settings/.test(file.path))).toBe(false);
  });

  it("names no other model family, provider endpoint or credential anywhere in src", () => {
    const banned = /\bglm[-_ ]?\d|GLM_|ZAI_|z\.ai|bigmodel\.cn|cogview|gemini|GEMINI_|generativelanguage\.googleapis|openrouter|OPENROUTER_|anthropic|ANTHROPIC_|\bclaude\b|nemotron|OLLAMA_|deepseek-|\bgpt-4|\bgpt-5|GROQ_VISION_MODEL/i;
    const offenders = sources
      // reasoning.ts documents which model families emit <think> blocks; image/config.ts
      // explains that a legacy saved image record is ignored.
      .filter((file) => !/src\/lib\/ai\/(reasoning|image\/config)\.ts$/.test(file.path))
      .filter((file) => banned.test(file.text))
      .map((file) => `${file.path}: ${file.text.match(banned)?.[0]}`);
    expect(offenders).toEqual([]);
  });

  it("writes the additional models' provider IDs only in the registry", () => {
    const families = /llama-\d|qwen\/|gpt-oss-20b/i;
    const offenders = sources
      .filter((file) => !/src\/lib\/ai\/(reasoning|models\/registry)\.ts$/.test(file.path.replace(/\\/g, "/")))
      .filter((file) => families.test(file.text))
      .map((file) => file.path);
    expect(offenders).toEqual([]);
  });

  it("spells the default model ID only in model.ts (and its key in the registry)", () => {
    const withLiteral = sources.filter((file) => /["'`](?:openai\/)?gpt-oss-120b["'`]/.test(file.text)).map((file) => file.path.replace(/\\/g, "/"));
    expect(withLiteral.sort()).toEqual(["src/lib/ai/model.ts", "src/lib/ai/models/registry.ts"]);
    expect(readFileSync("src/lib/ai/models/registry.ts", "utf8")).not.toMatch(/["'`]openai\/gpt-oss-120b["'`]/);
  });

  it("has none of the removed legacy selection APIs", () => {
    const all = sources.map((file) => file.text).join("\n");
    for (const removed of ["model_preference_set", "prefer_fallback", "preferFallback", "fallbackEligible", "admin_ai_provider_save", "admin_ai_managed_provider", "resolveSelectedAIRoute", "onTryAnotherModel", "Try another model"]) {
      expect(all.includes(removed), removed).toBe(false);
    }
  });

  it("deployment configs carry no credentials or model IDs for other models", () => {
    for (const file of [".env.example", "render.yaml", "apphosting.yaml"]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/GLM_|ZAI_|GEMINI_|OPENROUTER_|ANTHROPIC_|OLLAMA_|GROQ_CHAT_MODEL|GROQ_CODING_MODEL|GROQ_VISION_MODEL|glm-\d|cogview/);
      expect(text, file).toContain("GROQ_API_KEY");
    }
  });
});
