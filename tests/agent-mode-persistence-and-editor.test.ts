import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { history, undo, redo, undoDepth, redoDepth } from "@codemirror/commands";
import { getConversation } from "@/lib/server/queries";

function makeFakeDb(convData: Record<string, unknown>, messages: Array<{ id: string; data: Record<string, unknown> }> = []) {
  return {
    collection: () => ({
      doc: (id: string) => ({
        get: async () => ({
          exists: true,
          id,
          data: () => convData,
        }),
        collection: () => ({
          orderBy: () => ({
            limit: () => ({
              get: async () => ({
                size: messages.length,
                docs: messages.map((m) => ({
                  id: m.id,
                  data: () => m.data,
                })),
              }),
            }),
          }),
        }),
      }),
    }),
  } as unknown as Parameters<typeof getConversation>[0];
}

describe("Phase 1: Agent Mode Session Persistence", () => {
  it("restores mode='agent', active_project_id, agent_session_id, and execution_state when reopening a conversation", async () => {
    const fakeDb = makeFakeDb({
      user_id: "user-1",
      title: "Build Robotics Dashboard",
      mode: "agent",
      is_temporary: false,
      active_project_id: "proj-42",
      agent_session_id: "sess-abc-123",
      execution_state: "COMPLETED",
      selected_model: "openai/gpt-oss-120b",
      selected_provider: "Groq",
    });

    const result = await getConversation(fakeDb, "user-1", "conv-1");
    expect(result).not.toBeNull();
    expect(result!.conversation.mode).toBe("agent");
    expect(result!.conversation.active_project_id).toBe("proj-42");
    expect(result!.conversation.agent_session_id).toBe("sess-abc-123");
    expect(result!.conversation.execution_state).toBe("COMPLETED");
    expect(result!.conversation.selected_model).toBe("openai/gpt-oss-120b");
    expect(result!.conversation.selected_provider).toBe("Groq");
  });

  it("returns null when the conversation belongs to a different user", async () => {
    const fakeDb = makeFakeDb({
      user_id: "user-2",
      mode: "agent",
    });
    const result = await getConversation(fakeDb, "user-1", "conv-1");
    expect(result).toBeNull();
  });
});

describe("Phase 3: Per-file Editor Undo/Redo History", () => {
  it("preserves independent undo/redo history per file when switching files", () => {
    let stateA = EditorState.create({ doc: "const a = 1;", extensions: [history()] });
    let stateB = EditorState.create({ doc: "const b = 2;", extensions: [history()] });

    // Edit file A
    stateA = stateA.update({ changes: { from: 12, insert: "\nconst a2 = 3;" } }).state;
    expect(stateA.doc.toString()).toBe("const a = 1;\nconst a2 = 3;");
    expect(undoDepth(stateA)).toBeGreaterThan(0);

    // Edit file B
    stateB = stateB.update({ changes: { from: 12, insert: "\nconst b2 = 4;" } }).state;
    expect(stateB.doc.toString()).toBe("const b = 2;\nconst b2 = 4;");
    expect(undoDepth(stateB)).toBeGreaterThan(0);

    // Switch back to file A and undo
    const undoneA = undo({ state: stateA, dispatch: (tr) => { stateA = tr.state; } });
    expect(undoneA).toBe(true);
    expect(stateA.doc.toString()).toBe("const a = 1;");
    expect(redoDepth(stateA)).toBeGreaterThan(0);

    // File B is untouched
    expect(stateB.doc.toString()).toBe("const b = 2;\nconst b2 = 4;");

    // Redo file A
    const redoneA = redo({ state: stateA, dispatch: (tr) => { stateA = tr.state; } });
    expect(redoneA).toBe(true);
    expect(stateA.doc.toString()).toBe("const a = 1;\nconst a2 = 3;");
  });
});
