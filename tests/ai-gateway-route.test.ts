// =============================================================================
// AI gateway route integration tests.
//
// Exercises the REAL POST handler of src/app/api/ai/route.ts — auth, request
// de-duplication, rate limiting, conversation persistence, automatic model
// routing (admin-configured OpenAI-compatible provider), the real provider
// client over real HTTP (local stub), streaming, output safety and the error
// taxonomy the browser maps to user-visible copy.
//
// Only the Firebase Admin boundary is stubbed (Firestore/Auth are unreachable
// from CI by design); every layer above it is production code.
//
// IMPORTANT: `classifyGatewayResponse(status, code)` in these tests is the
// SAME function the browser uses — so the asserted `failure.title/detail`
// values are literally what a MATRIX user sees on screen.
// =============================================================================
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";
import { startProviderStub, type StubBehavior, type StubCall } from "./helpers/provider-stub";
import { classifyGatewayResponse, failureCopy } from "../src/lib/api-errors";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => ({ verifySession: vi.fn(async () => ({ uid: "probe-user-1", email: "probe@example.com", emailVerified: true })) }));

import { POST } from "../src/app/api/ai/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";

const stub: FirestoreStub = sharedFirestoreStub();

const bearer = { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" };

function req(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: bearer, body: JSON.stringify(body) });
}

async function post(body: unknown) {
  const res = await POST(req(body));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    /* SSE or non-JSON */
  }
  return { status: res.status, text, json, requestId: res.headers.get("X-MATRIX-Request-ID") };
}

const stubHolder: { current: StubBehavior } = { current: { kind: "ok", content: "PROBE-OK" } };
let baseUrl = "";
let providerCalls: StubCall[] = [];

beforeAll(async () => {
  const started = await startProviderStub(stubHolder);
  providerCalls = started.calls;
  baseUrl = `http://127.0.0.1:${started.port}/v1`;
  // Point the single GPT OSS 120B route at the local stub through the
  // dedicated-endpoint variables — the same code path production uses.
  process.env.GPT_OSS_API_KEY = "sk-stub-key-1234567890";
  process.env.GPT_OSS_BASE_URL = baseUrl;
  return () => started.server.close();
});

beforeEach(() => {
  stub.clearFaults();
  stubHolder.current = { kind: "ok", content: "PROBE-OK" };
  delete process.env.GROQ_API_KEY;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("AI gateway — happy paths (real route, real HTTP provider)", () => {
  it("non-streaming chat returns a real assistant reply", async () => {
    const res = await post({ action: "chat", message: "Reply with exactly: PROBE-OK", is_temporary: true, request_id: "itest-chat-ok-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("PROBE-OK");
    expect(res.json?.provider).toBe("OpenAI");
    expect(res.json?.model).toBe("openai/gpt-oss-120b");
    expect(typeof res.json?.conversation_id).toBe("string");
  });

  it("streaming chat emits SSE deltas and a done event (normal Chat mode)", async () => {
    stubHolder.current = { kind: "stream", deltas: ["HE", "LLO", "-STREAM"] };
    const res = await post({ action: "chat", message: "Say hello", is_temporary: true, stream: true, request_id: "itest-chat-ok-2" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("HE");
    expect(res.text).toContain("LLO");
    expect(res.text).toContain("done");
    // Assistant reply persisted exactly once for this conversation.
    const docs = [...stub._state.docs.entries()].filter(([k]) => k.includes("/messages/"));
    const assistant = docs.filter(([, v]) => (v as { role?: string }).role === "assistant" && (v as { content?: string }).content === "HELLO-STREAM");
    expect(assistant.length).toBe(1);
  });

  it("agent mode returns a structured response", async () => {
    stubHolder.current = { kind: "ok", content: "AGENT-OK" };
    // NOTE: agent mode is ignored when is_temporary is true (server enforces general).
    const res = await post({ action: "chat", mode: "agent", message: "Reply with exactly: AGENT-OK", request_id: "itest-agent-ok-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("AGENT-OK");
    expect(res.json?.mode).toBe("agent");
    expect(res.json?.provider).toBe("OpenAI");
  });

  it("persists a real provider clarification without invoking a website build, then accepts a second question and cancellation", async () => {
    const original = "Build a polished responsive website from my description. Start by asking only for the one most important missing requirement.";
    const question = "What is the primary purpose or main message of the website?";
    stubHolder.current = { kind: "ok", content: question };
    const before = [...stub._state.docs.keys()].filter((key) => key.startsWith("build_runs/")).length;
    const first = await post({ action: "chat", mode: "agent", stream: false, message: original, task_context: { originalRequest: original, state: "CLARIFICATION_REQUIRED", clarifications: [] }, request_id: "itest-clarify-1" });
    expect(first.status).toBe(200);
    expect(first.json?.reply).toBe(question);
    const conversationId = String(first.json?.conversation_id);
    const assistant = [...stub._state.docs.entries()].filter(([key, value]) => key.startsWith(`conversations/${conversationId}/messages/`) && (value as { role?: string }).role === "assistant");
    expect(assistant.at(-1)?.[1]).toMatchObject({ metadata: { agent_task: { originalRequest: original, state: "CLARIFICATION_REQUIRED" } } });
    expect([...stub._state.docs.keys()].filter((key) => key.startsWith("build_runs/")).length).toBe(before);

    stubHolder.current = { kind: "ok", content: "Who is the intended audience?" };
    const second = await post({ action: "chat", mode: "agent", conversation_id: conversationId, message: "I don't know yet", task_context: { originalRequest: original, state: "CLARIFICATION_REQUIRED", clarifications: [{ question, answer: "I don't know yet" }] }, request_id: "itest-clarify-2" });
    expect(second.status).toBe(200);
    expect(second.json?.reply).toBe("Who is the intended audience?");
    expect([...stub._state.docs.keys()].filter((key) => key.startsWith("build_runs/")).length).toBe(before);

    const cancelled = await post({ action: "cancel_pending_task", conversation_id: conversationId, original_request: original });
    expect(cancelled.status).toBe(200);
    expect(cancelled.json?.reply).toContain("won't start the build");
    const messages = [...stub._state.docs.entries()].filter(([key]) => key.startsWith(`conversations/${conversationId}/messages/`));
    expect(messages.some(([, value]) => (value as { metadata?: { agent_task?: { state?: string } } }).metadata?.agent_task?.state === "CONVERSATION")).toBe(true);
  });

  it("executes a model-requested read-only Agent tool through the audited gateway", async () => {
    stub._state.docs.set("projects/project-owned-by-probe", {
      owner_id: "probe-user-1", title: "My real project", stack: "static-web", revision: 2,
      file_count: 1, archived_at: null, updated_at: new Date().toISOString(), created_at: new Date().toISOString(),
    });
    stubHolder.current = {
      kind: "tool_call_then_ok", toolName: "projects.list", arguments: "{}",
      finalContent: "Your project is My real project.",
    };
    const start = providerCalls.length;
    const res = await post({ action: "chat", mode: "agent", stream: false, message: "Look at my projects and summarize them.", request_id: "itest-agent-tool-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("Your project is My real project.");
    expect(res.json?.analytics).toMatchObject({ toolsExecuted: 1 });
    const calls = providerCalls.slice(start).filter((call) => call.url.endsWith("/chat/completions"));
    expect(calls).toHaveLength(2);
    expect(calls[0].body?.tools).toEqual(expect.arrayContaining([expect.objectContaining({ function: expect.objectContaining({ name: "projects.list" }) })]));
    expect(calls[1].body?.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "tool", tool_call_id: "call-1" })]));
    const audit = [...stub._state.docs.values()];
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ action: "agent.tool_selected", target_id: "projects.list" }),
      expect.objectContaining({ action: "tool.ok", target_id: "projects.list" }),
    ]));
  });
});

describe("AI gateway — failure handling (regression: the old generic 500s are gone)", () => {
  it("storage failure returns an honest CHAT_STORAGE_UNAVAILABLE, never the fake 'AI service' 500", async () => {
    // Previously: unhandled exception → 500 INTERNAL → browser showed
    // "Server problem. MATRIX could not connect to the AI service right now."
    // even though the AI service was never reached.
    stub.fault({ collection: "conversations", method: "add", error: new Error("Quota exceeded. RESOURCE_EXHAUSTED") });
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "itest-fail-store-1" });
    expect(res.status).toBe(503);
    expect(res.json?.error).toBe("CHAT_STORAGE_UNAVAILABLE");
    const failure = classifyGatewayResponse(res.status, String(res.json?.error));
    expect(failure).toEqual(failureCopy("storage"));
    expect(failure.title).toBe("Chat storage unavailable");
    expect(failure.detail).not.toBe(failureCopy("server").detail);
  });

  it("a failed best-effort context read no longer fails the chat", async () => {
    // loadSafeMemories used to be an unguarded Firestore read inside the chat path.
    stub.fault({ collection: "user_memories", method: "get", error: new Error("FAILED_PRECONDITION") });
    const res = await post({ action: "chat", message: "Reply with exactly: PROBE-OK", is_temporary: true, request_id: "itest-fail-read-1" });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("PROBE-OK");
  });

  it("unmapped provider 4xx are invalid_request (specific copy), not the generic gateway error", async () => {
    stubHolder.current = { kind: "status", status: 451, body: JSON.stringify({ error: { message: "Unavailable For Legal Reasons" } }) };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "itest-fail-451-1" });
    expect(res.status).toBe(400);
    expect(res.json?.error).toBe("AI_INVALID_REQUEST");
    expect(classifyGatewayResponse(res.status, String(res.json?.error))).toEqual(failureCopy("provider-invalid-request"));
  });

  it("shows a SPECIFIC (non-generic) message for a provider authentication failure", async () => {
    stubHolder.current = { kind: "status", status: 401, body: JSON.stringify({ error: { message: "Invalid API key" } }) };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "itest-fail-401-1" });
    expect(res.status).toBe(502);
    expect(res.json?.error).toBe("AI_PROVIDER_AUTH_FAILED");
    expect(classifyGatewayResponse(res.status, String(res.json?.error))).toEqual(failureCopy("provider-auth"));
    expect(classifyGatewayResponse(res.status, String(res.json?.error)).detail).not.toBe(failureCopy("server").detail);
  });

  it("shows a SPECIFIC message for a provider 5xx, never a fake reply", async () => {
    stubHolder.current = { kind: "status", status: 500, body: "<html>upstream exploded</html>", contentType: "text/html" };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, request_id: "itest-fail-500-1" });
    expect(res.status).toBe(503);
    expect(res.json?.error).toBe("AI_PROVIDER_UNAVAILABLE");
    expect(res.json?.reply).toBeUndefined();
  });

  it("streaming: a provider stream that dies mid-flight is reported, not silently swallowed", async () => {
    stubHolder.current = { kind: "stream_then_die", deltas: ["PAR", "TIAL"] };
    const res = await post({ action: "chat", message: "hello", is_temporary: true, stream: true, request_id: "itest-fail-sse-1" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("PAR");
    // The partial content is preserved AND the error event is emitted.
    expect(res.text).toContain("AI_PROVIDER_UNAVAILABLE");
    expect(res.text).not.toContain('"done":true');
  });

  it("unauthenticated requests are rejected before any provider call", async () => {
    const res = await POST(new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" }, body: JSON.stringify({ action: "chat", message: "hi" }) }));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "UNAUTHENTICATED" });
  });
});

describe("AI gateway — the health probe must not lie", () => {
  it("gateway health action: online only after a real provider response", async () => {
    stubHolder.current = { kind: "ok", content: "pong" };
    resetHealthCacheForTests();
    const ok = await post({ action: "health" });
    expect(ok.status).toBe(200);
    expect(ok.json?.status).toBe("online");
  });

  it("gateway health action: a working GET /models with a failing chat endpoint is NOT online", async () => {
    // The classic lying endpoint (many proxies answer /models
    // without a valid key): the old healthCheck reported "online" here while
    // every real chat request failed with 401.
    resetHealthCacheForTests();
    stubHolder.current = { kind: "status", status: 401 };
    const bad = await post({ action: "health" });
    expect(bad.status).toBe(503);
    expect(bad.json?.status).toBe("unavailable");
  });
});
