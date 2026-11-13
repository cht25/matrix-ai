import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { classifyAgentOutput, requestsClarificationFirst, pendingTaskFromMessages, resumedTaskPrompt, cancelsPendingTask, isClarificationAnswer, isTaskInterruption, transitionAgentExecution, type PendingAgentTask } from "@/lib/ai/agent-execution";
import { detectBuildIntent, shouldRunBuildPipeline } from "@/lib/ai/build-intent";
import { createBuildRun, applyStaleness, buildRunCopy, toRunSnapshot, runFromSnapshot } from "@/lib/deploy/stages";
import { runFromFirestore, toFirestoreRun } from "@/lib/deploy/run-store";

const request = "Build a polished responsive website from my description. Start by asking only for the one most important missing requirement.";
const question = "What is the primary purpose or main message of the website?";
const task: PendingAgentTask = { originalRequest: request, clarifications: [], state: "CLARIFICATION_REQUIRED" };

describe("Agent clarification and actual-output classification", () => {
  it("routes the exact reproduction to Chat before any build run", () => {
    expect(requestsClarificationFirst(request)).toBe(true);
    expect(detectBuildIntent(request, { agentMode: true }).build).toBe(true); // intent alone is NOT execution authority
    expect(classifyAgentOutput(question)).toMatchObject({ state: "CLARIFICATION_REQUIRED", files: [], reply: question });
    expect(shouldRunBuildPipeline(detectBuildIntent("What is the main message?", { agentMode: true }))).toBe(false);
  });
  it("preserves multiple necessary clarification answers and the original request", () => {
    const first = { ...task, clarifications: [{ question, answer: "A photographer portfolio" }] };
    const second = { ...first, clarifications: [...first.clarifications, { question: "Who is it for?", answer: "Wedding clients" }] };
    const prompt = resumedTaskPrompt(second, "Wedding clients");
    expect(prompt).toContain("Build a polished responsive website");
    expect(prompt).toContain("A photographer portfolio");
    expect(prompt).toContain("Wedding clients");
    expect(prompt).not.toContain("Start by asking only");
    expect(pendingTaskFromMessages([{ role: "assistant", metadata: { agent_task: first } }, { role: "user" }, { role: "assistant", metadata: { agent_task: second } }])).toEqual(second);
  });
  it("does not carry a cancelled task into the next turn, or build on an uncertain answer", () => {
    expect(cancelsPendingTask("Cancel the task")).toBe(true);
    expect(isClarificationAnswer("I don't know")).toBe(false);
    expect(isClarificationAnswer("A photography portfolio")).toBe(true);
    expect(isClarificationAnswer("What is the weather?")).toBe(false);
    expect(isTaskInterruption("What is the weather?")).toBe(true);
    expect(pendingTaskFromMessages([{ role: "assistant", metadata: { agent_task: task } }, { role: "assistant", metadata: { agent_task: { ...task, state: "CONVERSATION" } } }])).toBeNull();
  });
  it("classifies ordinary conversational text and explanatory Markdown as not files", () => {
    expect(classifyAgentOutput("Here is an explanation of the design tradeoffs.").state).toBe("CONVERSATION");
    expect(classifyAgentOutput("## Plan\n\n1. Ask users for requirements.\n2. Design a homepage.").state).toBe("PLANNING");
    expect(classifyAgentOutput("Here is an example:\n```html\n<h1>Example</h1>\n```").files).toEqual([]);
  });
  it("recognizes explicit project files, JSON operations, and supported structured tool calls", () => {
    expect(classifyAgentOutput('<<<MATRIX_FILE path="index.html">>>\n<h1>Ready</h1>\n<<<END_MATRIX_FILE>>>').files[0].path).toBe("index.html");
    expect(classifyAgentOutput(JSON.stringify({ operations: [{ type: "write", path: "styles.css", content: "body{}" }] })).files).toMatchObject([{ path: "styles.css" }]);
    expect(classifyAgentOutput("", [{ function: { name: "write_file", arguments: JSON.stringify({ path: "index.html", content: "<main>Ready</main>" }) } }]).state).toBe("FILE_GENERATION");
    expect(classifyAgentOutput("", [{ function: { name: "shell", arguments: "{}" } }]).files).toEqual([]);
    expect(classifyAgentOutput(JSON.stringify({ files: [{ path: "../secret", content: "unsafe" }] })).files).toEqual([]);
  });
  it("detects genuinely empty or non-generating provider output without reporting success", () => {
    expect(classifyAgentOutput("").state).toBe("FAILED");
    expect(classifyAgentOutput("I cannot generate those files right now.").files).toEqual([]);
  });
  it("does not make rhetorical questions in plans into clarification requests", () => {
    expect(classifyAgentOutput("## Plan\nWhy choose this layout? It improves legibility and balance.").state).toBe("PLANNING");
  });
  it("enforces real execution transitions, not intent-driven success", () => {
    expect(transitionAgentExecution("CONVERSATION", "complete")).toBe("CONVERSATION");
    let state = transitionAgentExecution("CONVERSATION", "ask");
    expect(state).toBe("CLARIFICATION_REQUIRED");
    state = transitionAgentExecution(state, "plan");
    expect(state).toBe("PLANNING");
    expect(transitionAgentExecution(state, "build_started")).toBe("PLANNING");
    for (const event of ["files_saved", "build_started", "validation_started", "deployment_started", "complete"] as const) state = transitionAgentExecution(state, event);
    expect(state).toBe("COMPLETED");
    expect(transitionAgentExecution("FILE_GENERATION", "error")).toBe("FAILED");
  });
  it("keeps awaiting-input runs terminal, non-failed and non-deployed across storage round trips", () => {
    const run = { ...createBuildRun({ id: "r1", projectId: "existing-p1", actions: { build: true, preview: true, publish: false }, now: 100 }), status: "awaiting_input" as const, updatedAt: 101, finishedAt: 101 };
    expect(buildRunCopy(run).title).toBe("Waiting for your answer");
    expect(buildRunCopy(run).canOpenLive).toBe(false);
    expect(applyStaleness(run, 500_000).status).toBe("awaiting_input");
    expect(runFromSnapshot(toRunSnapshot(run), 500_000).status).toBe("awaiting_input");
    expect(runFromFirestore(toFirestoreRun(run), 500_000)?.status).toBe("awaiting_input");
  });
});

// Guard the boundary where the regression occurred, not just the classifier.
describe("clarification/build orchestration boundaries", () => {
  const client = readFileSync(new URL("../src/components/chat-client.tsx", import.meta.url), "utf8");
  const route = readFileSync(new URL("../src/app/api/build/route.ts", import.meta.url), "utf8");
  const aiRoute = readFileSync(new URL("../src/app/api/ai/route.ts", import.meta.url), "utf8");
  const pipeline = readFileSync(new URL("../src/lib/server/build.ts", import.meta.url), "utf8");
  it("does not start a build for a first-question request and stores a scoped cancellation", () => {
    expect(client.indexOf("requestsClarificationFirst(rawMessage)")).toBeLessThan(client.indexOf("const buildIntent = detectBuildIntent(rawMessage"));
    expect(route).toContain("!taskContext && requestsClarificationFirst(prompt)");
    expect(aiRoute).toContain("agentExecutionRequired && !clarificationFirst && !clarificationFollowup");
    expect(aiRoute).toContain("latestTask.originalRequest === taskContext.originalRequest");
    expect(client).toContain('action: "cancel_pending_task"');
    expect(route).toContain('taskContext && typeof body.visible_message === "string"');
  });
  it("only persists a build snapshot for actual build work; provider questions await input", () => {
    expect(pipeline).toContain('status: "awaiting_input"');
    expect(pipeline).toContain('classifyAgentOutput(raw, calls)');
    expect(pipeline).toContain('"AI_NO_FILES"');
    expect(client).toContain('run && run.status !== "awaiting_input" ? toRunSnapshot(run) : undefined');
    expect(client).toContain('run?.status === "failed" || buildError');
  });
});
