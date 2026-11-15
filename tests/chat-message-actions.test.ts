// =============================================================================
// Message actions: Regenerate (replace + version), Edit & resend, Delete.
//
// Exercises the REAL /api/ai handler and the real message operations against
// the in-memory Firestore stand-in. The property under test is the one a user
// notices after a reload: one prompt keeps ONE answer however many times it is
// regenerated, the earlier answers stay readable as versions, the conversation
// id never changes and nobody can touch another owner's messages.
// =============================================================================
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";
import { startProviderStub, type StubBehavior } from "./helpers/provider-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => ({ verifySession: vi.fn(async () => ({ uid: "probe-user-1", email: "probe@example.com", emailVerified: true })) }));

import { POST } from "../src/app/api/ai/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import type { Db } from "../src/lib/firebase/admin";
import {
  MAX_REPLY_VERSIONS, deleteConversationMessage, editUserMessage, isReplaceableReply, nextReplyVersions,
} from "../src/lib/server/chat-messages";

const stub: FirestoreStub = sharedFirestoreStub();
const db = stub as unknown as Db;
const UID = "probe-user-1";
const headers = { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" };
const behavior: { current: StubBehavior } = { current: { kind: "ok", content: "FIRST ANSWER" } };

async function post(body: Record<string, unknown>) {
  const res = await POST(new NextRequest("http://localhost:3000/api/ai", { method: "POST", headers, body: JSON.stringify(body) }));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* SSE */ }
  return { status: res.status, text, json };
}

function messagesOf(conversationId: string) {
  return [...stub._state.docs.entries()]
    .filter(([key]) => key.startsWith(`conversations/${conversationId}/messages/`))
    .map(([key, value]) => ({ id: key.split("/").pop()!, ...(value as { role: string; content: string; metadata?: Record<string, unknown> }) }));
}

/** Parse the `data:` frames of an SSE body. */
function sseEvents(text: string): Array<Record<string, unknown>> {
  return text.split("\n\n").map((frame) => frame.trim()).filter((frame) => frame.startsWith("data:"))
    .map((frame) => { try { return JSON.parse(frame.slice(5).trim()) as Record<string, unknown>; } catch { return {}; } });
}

beforeAll(async () => {
  const started = await startProviderStub(behavior);
  process.env.GPT_OSS_API_KEY = "sk-stub-key-1234567890";
  process.env.GPT_OSS_BASE_URL = `http://127.0.0.1:${started.port}/v1`;
  return () => started.server.close();
});

beforeEach(() => {
  stub.clearFaults();
  behavior.current = { kind: "ok", content: "FIRST ANSWER" };
  delete process.env.GROQ_API_KEY;
});

describe("regenerate replaces the previous answer and keeps it as a version", () => {
  it("returns the stored message ids so a fresh turn is immediately actionable", async () => {
    const first = await post({ action: "chat", message: "Explain tides briefly.", request_id: "act-ids-1" });
    expect(first.status).toBe(200);
    const conversationId = String(first.json?.conversation_id);
    const stored = messagesOf(conversationId);
    expect(stored.map((m) => m.role).sort()).toEqual(["assistant", "user"]);
    expect(first.json?.message_id).toBe(stored.find((m) => m.role === "assistant")!.id);
    expect(first.json?.user_message_id).toBe(stored.find((m) => m.role === "user")!.id);
    expect(first.json?.versions).toBeUndefined();
  });

  it("keeps exactly one assistant message for one prompt across repeated regenerations", async () => {
    const first = await post({ action: "chat", message: "Explain tides briefly.", request_id: "act-regen-1" });
    const conversationId = String(first.json?.conversation_id);
    const answerId = String(first.json?.message_id);

    behavior.current = { kind: "ok", content: "SECOND ANSWER" };
    const second = await post({ action: "chat", message: "Explain tides briefly.", conversation_id: conversationId, regenerate: true, request_id: "act-regen-2" });
    expect(second.status).toBe(200);
    expect(second.json?.reply).toBe("SECOND ANSWER");
    // Same conversation, same document: nothing was duplicated.
    expect(second.json?.conversation_id).toBe(conversationId);
    expect(second.json?.message_id).toBe(answerId);
    let stored = messagesOf(conversationId);
    expect(stored.filter((m) => m.role === "user")).toHaveLength(1);
    expect(stored.filter((m) => m.role === "assistant")).toHaveLength(1);
    const assistant = stored.find((m) => m.role === "assistant")!;
    expect(assistant.content).toBe("SECOND ANSWER");
    expect(assistant.metadata?.versions).toMatchObject([{ content: "FIRST ANSWER", model: "openai/gpt-oss-120b" }]);
    expect(second.json?.versions).toMatchObject([{ content: "FIRST ANSWER" }]);

    behavior.current = { kind: "ok", content: "THIRD ANSWER" };
    const third = await post({ action: "chat", message: "Explain tides briefly.", conversation_id: conversationId, regenerate: true, request_id: "act-regen-3" });
    expect(third.json?.message_id).toBe(answerId);
    stored = messagesOf(conversationId);
    expect(stored.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect((stored.find((m) => m.role === "assistant")!.metadata?.versions as Array<{ content: string }>).map((v) => v.content)).toEqual(["FIRST ANSWER", "SECOND ANSWER"]);
  });

  it("does not send the replaced answer back to the model as context", async () => {
    const first = await post({ action: "chat", message: "Name one planet.", request_id: "act-ctx-1" });
    const conversationId = String(first.json?.conversation_id);
    behavior.current = { kind: "ok", content: "Mars" };
    const regen = await post({ action: "chat", message: "Name one planet.", conversation_id: conversationId, regenerate: true, request_id: "act-ctx-2" });
    expect(regen.status).toBe(200);
    // One prompt, one answer — and the user turn was not stored a second time.
    expect(messagesOf(conversationId).filter((m) => m.role === "user")).toHaveLength(1);
  });

  it("versions a regenerated STREAMED answer and reports the ids in the done event", async () => {
    behavior.current = { kind: "stream", deltas: ["Stream", "ed one"] };
    const first = await post({ action: "chat", message: "Say something short.", stream: true, request_id: "act-stream-1" });
    const done = sseEvents(first.text).find((event) => event.done === true)!;
    const conversationId = String(done.conversation_id);
    const answerId = String(done.message_id);
    expect(typeof done.user_message_id).toBe("string");
    // The very first frame already confirms the user turn is stored.
    expect(sseEvents(first.text)[0].user_message_id).toBe(done.user_message_id);

    behavior.current = { kind: "stream", deltas: ["Stream", "ed two"] };
    const second = await post({ action: "chat", message: "Say something short.", conversation_id: conversationId, stream: true, regenerate: true, request_id: "act-stream-2" });
    const doneAgain = sseEvents(second.text).find((event) => event.done === true)!;
    expect(doneAgain.message_id).toBe(answerId);
    expect(doneAgain.versions).toMatchObject([{ content: "Streamed one" }]);
    const assistants = messagesOf(conversationId).filter((m) => m.role === "assistant");
    expect(assistants).toHaveLength(1);
    expect(assistants[0].content).toBe("Streamed two");
  });

  it("adds a normal answer when there is no previous reply to replace (retry after a failure)", async () => {
    const conversation = await stub.collection("conversations").add({ user_id: UID, title: "Retry", mode: "general", is_temporary: false, created_at: Date.now(), updated_at: Date.now() });
    await conversation.collection("messages").add({ role: "user", content: "Are you there?", metadata: {}, created_at: Date.now() });
    behavior.current = { kind: "ok", content: "Yes." };
    const res = await post({ action: "chat", message: "Are you there?", conversation_id: conversation.id, regenerate: true, request_id: "act-retry-1" });
    expect(res.status).toBe(200);
    const stored = messagesOf(conversation.id);
    expect(stored.filter((m) => m.role === "user")).toHaveLength(1);
    expect(stored.filter((m) => m.role === "assistant")).toHaveLength(1);
    expect(stored.find((m) => m.role === "assistant")!.metadata?.versions).toBeUndefined();
    expect(res.json?.user_message_id).toBe(stored.find((m) => m.role === "user")!.id);
  });

  it("never overwrites a reply that records real execution", () => {
    expect(isReplaceableReply({ role: "assistant", content: "Plain answer", metadata: { mode: "general" } })).toBe(true);
    expect(isReplaceableReply({ role: "assistant", content: "Built.", metadata: { build: { run_id: "r1" } } })).toBe(false);
    expect(isReplaceableReply({ role: "assistant", content: "Live.", metadata: { deployment: { id: "d1" } } })).toBe(false);
    expect(isReplaceableReply({ role: "assistant", content: "Which audience?", metadata: { agent_task: { state: "CLARIFICATION_REQUIRED" } } })).toBe(false);
    expect(isReplaceableReply({ role: "user", content: "hi" })).toBe(false);
    expect(isReplaceableReply(undefined)).toBe(false);
  });

  it("caps stored versions so a message never outgrows a Firestore document", () => {
    let data: Record<string, unknown> = { role: "assistant", content: "v0", created_at: 1_700_000_000_000, metadata: { model: "m" } };
    for (let i = 1; i <= 12; i++) {
      const versions = nextReplyVersions(data);
      data = { ...data, content: `v${i}`, metadata: { model: "m", versions } };
    }
    const versions = (data.metadata as { versions: Array<{ content: string; created_at: string }> }).versions;
    expect(versions).toHaveLength(MAX_REPLY_VERSIONS - 1);
    expect(versions.at(-1)?.content).toBe("v11");
    expect(versions[0].content).toBe("v8");
    expect(Number.isNaN(Date.parse(versions[0].created_at))).toBe(false);
    const huge = nextReplyVersions({ role: "assistant", content: "x".repeat(200_000), metadata: {} });
    expect(huge[0].content.length).toBeLessThanOrEqual(40_000);
    expect(nextReplyVersions({ role: "assistant", content: "   ", metadata: {} })).toEqual([]);
  });
});

describe("edit & resend and delete are owner-scoped", () => {
  async function seed(owner = UID) {
    const conversation = await stub.collection("conversations").add({ user_id: owner, title: "Edit me", mode: "general", is_temporary: false, created_at: Date.now(), updated_at: Date.now() });
    const user = await conversation.collection("messages").add({ role: "user", content: "Orignal typo", metadata: { mode: "general" }, created_at: Date.now() });
    const assistant = await conversation.collection("messages").add({ role: "assistant", content: "An answer", metadata: { mode: "general" }, created_at: Date.now() + 5 });
    return { conversationId: conversation.id, userId: user.id, assistantId: assistant.id };
  }

  it("rewrites a user message and preserves the first original", async () => {
    const { conversationId, userId } = await seed();
    const edited = await editUserMessage(db, UID, conversationId, userId, "  Original, fixed  ");
    expect(edited).toMatchObject({ id: userId, content: "Original, fixed", changed: true });
    const again = await editUserMessage(db, UID, conversationId, userId, "Original, fixed twice");
    expect(again.changed).toBe(true);
    const stored = messagesOf(conversationId).find((m) => m.id === userId)!;
    expect(stored.content).toBe("Original, fixed twice");
    expect(stored.metadata).toMatchObject({ mode: "general", original_content: "Orignal typo", edit_count: 2 });
    // Saving identical text is a no-op, not a new edit.
    expect((await editUserMessage(db, UID, conversationId, userId, "Original, fixed twice")).changed).toBe(false);
  });

  it("rejects empty or oversized text, assistant messages and other owners", async () => {
    const { conversationId, userId, assistantId } = await seed();
    await expect(editUserMessage(db, UID, conversationId, userId, "   ")).rejects.toMatchObject({ code: "MESSAGE_REQUIRED" });
    await expect(editUserMessage(db, UID, conversationId, userId, "x".repeat(12_001))).rejects.toMatchObject({ code: "MESSAGE_TOO_LONG" });
    await expect(editUserMessage(db, UID, conversationId, assistantId, "nope")).rejects.toMatchObject({ code: "MESSAGE_NOT_EDITABLE" });
    await expect(editUserMessage(db, "intruder", conversationId, userId, "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(editUserMessage(db, UID, conversationId, "missing", "nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messagesOf(conversationId).find((m) => m.id === userId)!.content).toBe("Orignal typo");
  });

  it("deletes exactly the chosen message and leaves the rest of the conversation intact", async () => {
    const { conversationId, userId, assistantId } = await seed();
    await expect(deleteConversationMessage(db, "intruder", conversationId, assistantId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(messagesOf(conversationId)).toHaveLength(2);
    const result = await deleteConversationMessage(db, UID, conversationId, assistantId);
    expect(result).toMatchObject({ deleted: true, id: assistantId, role: "assistant" });
    const remaining = messagesOf(conversationId);
    expect(remaining.map((m) => m.id)).toEqual([userId]);
    expect(stub._state.docs.has(`conversations/${conversationId}`)).toBe(true);
    await expect(deleteConversationMessage(db, UID, conversationId, assistantId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("refuses to act on a deleted conversation", async () => {
    const { conversationId, userId } = await seed();
    await stub.collection("conversations").doc(conversationId).set({ deleted_at: Date.now() }, { merge: true });
    await expect(deleteConversationMessage(db, UID, conversationId, userId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(editUserMessage(db, UID, conversationId, userId, "x")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("releases only the owner's own recording when a voice message is deleted", async () => {
    const { conversationId } = await seed();
    const assetId = "11111111-2222-3333-4444-555555555555";
    stub._state.docs.set(`chat_audio_assets/${assetId}`, { user_id: "someone-else", storage_public_id: "chat-audio/someone-else/clip" });
    const voice = await stub.collection("conversations").doc(conversationId).collection("messages").add({ role: "user", content: "spoken words", metadata: { audio_asset_id: assetId }, created_at: Date.now() });
    const result = await deleteConversationMessage(db, UID, conversationId, voice.id);
    expect(result).toMatchObject({ deleted: true, audio_deleted: false });
    // Another account's recording is never touched.
    expect(stub._state.docs.has(`chat_audio_assets/${assetId}`)).toBe(true);
  });
});

describe("the rpc layer exposes the message actions", () => {
  it("wires delete, edit and the remembered mode behind zod validation", async () => {
    const { readFileSync } = await import("node:fs");
    const route = readFileSync("src/app/api/rpc/route.ts", "utf8");
    expect(route).toContain("conversation_message_delete");
    expect(route).toContain("conversation_message_edit");
    expect(route).toContain("z.enum(CONVERSATION_MODES).parse(b.mode)");
    const build = readFileSync("src/app/api/build/route.ts", "utf8");
    expect(build).toContain("body.reuse_user === true");
    expect(build).toContain("sendableVoiceAsset(");
  });
});
