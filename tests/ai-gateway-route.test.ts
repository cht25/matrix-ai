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
import { startProviderStub, type StubBehavior } from "./helpers/provider-stub";
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

beforeAll(async () => {
  const started = await startProviderStub(stubHolder);
  baseUrl = `http://127.0.0.1:${started.port}/v1`;
  // Register the local OpenAI-compatible provider as the admin runtime route —
  // the same code path production uses for system_settings/ai_provider.
  stub.collection("system_settings").doc("ai_provider").set({
    enabled: true,
    base_url: baseUrl,
    model: "stub-model-1",
    agent_model: "",
    label: "Stub",
    api_key: "sk-stub-key-1234567890",
  });
  return () => started.server.close();
});

beforeEach(() => {
  stub.clearFaults();
  stubHolder.current = { kind: "ok", content: "PROBE-OK" };
  for (const key of ["GROQ_API_KEY", "OPENROUTER_API_KEY", "OPENROUTER_CODING_MODEL"]) delete process.env[key];
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
    expect(res.json?.model).toBe("stub-model-1");
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
    const res = await POST(new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "chat", message: "hi" }) }));
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
    // The classic lying endpoint (OpenRouter & most proxies answer /models
    // without a valid key): the old healthCheck reported "online" here while
    // every real chat request failed with 401.
    resetHealthCacheForTests();
    stubHolder.current = { kind: "status", status: 401 };
    const bad = await post({ action: "health" });
    expect(bad.status).toBe(503);
    expect(bad.json?.status).toBe("unavailable");
  });
});
