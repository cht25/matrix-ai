// =============================================================================
// Doing versus describing.
//
// The defect this suite pins down: a request to DO something ("update my
// project", "change the design", "deploy it") was answered with a sentence
// that sounded as if the work had happened. Now every such request either
//   • runs the real pipeline (Agent / Code mode), or
//   • waits for one tap (asked in a conversation mode), or
//   • is answered as text that is not allowed to claim the work was done —
//     and is labelled if it claims so anyway;
// and a run always ends in a named state: completed, failed, blocked,
// awaiting approval (or awaiting input / paused / stopped).
// =============================================================================
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";
import { startProviderStub, type StubBehavior, type StubCall } from "./helpers/provider-stub";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => {
  const user = { uid: "execution-user", email: "exec@example.com", emailVerified: true };
  return { verifySession: vi.fn(async () => user), getSessionUser: vi.fn(async () => user) };
});

import { POST } from "../src/app/api/ai/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { buildActionsFor, detectBuildIntent, shouldRunBuildPipeline, type BuildIntentContext } from "../src/lib/ai/build-intent";
import { agentHandoffReason, approvedIntent, handoffCopy, isConversationMode, mayExecuteAgent, unbackedActionClaim } from "../src/lib/ai/execution-policy";
import { SYSTEM_PROMPT, AGENT_SYSTEM_PROMPT } from "../src/lib/ai/prompts";
import {
  TASK_OUTCOME_LABELS, awaitingApprovalOutcome, isBlockerCode, outcomeOfRequestError, outcomeOfRun, outcomeOfSnapshot, resolveOutcome,
} from "../src/lib/ai/task-outcome";
import { createBuildRun, failRun, toRunSnapshot, type BuildRun } from "../src/lib/deploy/stages";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";
import { ChatClient } from "../src/components/chat-client";
import { ExecutionHandoff } from "../src/components/build/execution-handoff";
import { TaskOutcomeLine } from "../src/components/build/task-outcome";
import type { ChatMessage } from "../src/lib/chat-messages";

const AGENT: BuildIntentContext = { mode: "agent", agentMode: true };
const AGENT_WITH_PROJECT: BuildIntentContext = { ...AGENT, projectFileCount: 4 };
const CHAT: BuildIntentContext = { mode: "general" };
const CHAT_WITH_PROJECT: BuildIntentContext = { ...CHAT, projectFileCount: 4 };

const runs = (text: string, context: BuildIntentContext) => shouldRunBuildPipeline(detectBuildIntent(text, context));

// ---------------------------------------------------------------------------
describe("Agent mode: a change request runs the pipeline", () => {
  // The requests named in the defect report, word for word.
  for (const text of [
    "Update my project",
    "Change the design",
    "Add this feature",
    "Remove this component",
    "Modify the backend",
    "Improve the application",
    "Rebrand the platform",
  ]) {
    it(`"${text}" → a real revision run`, () => {
      const intent = detectBuildIntent(text, AGENT_WITH_PROJECT);
      expect(intent.modify).toBe(true);
      expect(intent.build).toBe(true);
      expect(intent.needsClarification).toBe(false);
      expect(shouldRunBuildPipeline(intent)).toBe(true);
      expect(mayExecuteAgent("agent", intent)).toBe(true);
      // Changing files is not publishing them.
      expect(buildActionsFor(intent)).toMatchObject({ build: true, publish: false });
      // …and the same request also runs with no project open yet: the pipeline
      // then resolves (or asks for) the project instead of chatting about it.
      expect(runs(text, AGENT)).toBe(true);
    });
  }

  it('"Deploy it" publishes the existing project without regenerating it', () => {
    const intent = detectBuildIntent("Deploy it", AGENT_WITH_PROJECT);
    expect(buildActionsFor(intent)).toEqual({ build: false, publish: true, preview: false });
  });

  for (const text of [
    "make the header blue",
    "please redesign the landing page",
    "can you add a contact form to the footer",
    "I want you to replace the hero image",
    "now translate the text to Bangla",
    "rename the app to Northwind",
    "update the header but don't touch the footer",
    "fix the broken menu on mobile",
    "change it to a dark theme",
  ]) {
    it(`"${text}" → runs`, () => expect(runs(text, AGENT_WITH_PROJECT)).toBe(true));
  }

  it("a change and a publish in one sentence do both", () => {
    const intent = detectBuildIntent("update the header and redeploy", AGENT_WITH_PROJECT);
    expect(buildActionsFor(intent)).toMatchObject({ build: true, publish: true });
  });

  it("a bare pronoun with nothing to point at asks one question instead of guessing", () => {
    const intent = detectBuildIntent("change it to blue", AGENT);
    expect(intent.needsClarification).toBe(true);
    expect(intent.clarification).toMatch(/Which project should I change/);
    expect(shouldRunBuildPipeline(intent)).toBe(false);
  });
});

describe("Agent mode: questions and refusals never start a run", () => {
  for (const text of [
    "how do I change the header?",
    "what files do I have?",
    "explain the build errors",
    "explain how to deploy my site",
    "review the header code",
    "list my projects",
    "thanks, that looks complete",
    "any update?",
    "I like it, don't change anything",
    "don't change the header",
    "hi",
  ]) {
    it(`"${text}" → conversation`, () => {
      const intent = detectBuildIntent(text, AGENT_WITH_PROJECT);
      expect(shouldRunBuildPipeline(intent)).toBe(false);
      expect(intent.publish).toBe(false);
    });
  }

  it("an explanation that goes on to ask for the work still runs", () => {
    expect(runs("review and fix my website", AGENT_WITH_PROJECT)).toBe(true);
  });

  it('"launch a marketing campaign" is not a deployment', () => {
    // "host", "ship" and "launch" only publish when aimed at a project.
    expect(detectBuildIntent("launch a marketing campaign for my shop", AGENT_WITH_PROJECT).publish).toBe(false);
    expect(detectBuildIntent("launch my website", AGENT_WITH_PROJECT).publish).toBe(true);
    expect(detectBuildIntent("host this", AGENT_WITH_PROJECT).publish).toBe(true);
    expect(detectBuildIntent("ship it", AGENT_WITH_PROJECT).publish).toBe(true);
  });
});

describe("Bangla and Banglish requests are understood too", () => {
  const cases: Array<[string, BuildIntentContext, "run" | "publish" | "talk"]> = [
    ["আমার প্রজেক্ট আপডেট করো", AGENT, "run"],
    ["ডিজাইন পরিবর্তন করো", AGENT_WITH_PROJECT, "run"],
    ["হেডারের রং বদলাও", AGENT_WITH_PROJECT, "run"],
    ["একটা বেকারির ওয়েবসাইট বানাও", AGENT, "run"],
    ["এটা ডিপ্লয় করো", AGENT_WITH_PROJECT, "publish"],
    ["amar website ta update koro", AGENT, "run"],
    ["design ta change koro", AGENT_WITH_PROJECT, "run"],
    ["ekta portfolio website banao", AGENT, "run"],
    ["eta deploy koro", AGENT_WITH_PROJECT, "publish"],
    ["কিভাবে ওয়েবসাইট ডিপ্লয় করব?", AGENT_WITH_PROJECT, "talk"],
    ["ওয়েবসাইট ডিপ্লয় করো না", AGENT_WITH_PROJECT, "talk"],
    ["তুমি কেমন আছো", AGENT_WITH_PROJECT, "talk"],
    ["একটা কবিতা লিখে দাও", AGENT, "talk"],
  ];
  for (const [text, context, expected] of cases) {
    it(`"${text}" → ${expected}`, () => {
      const intent = detectBuildIntent(text, context);
      expect(shouldRunBuildPipeline(intent)).toBe(expected !== "talk");
      expect(intent.publish).toBe(expected === "publish");
    });
  }
});

// ---------------------------------------------------------------------------
describe("conversation modes: real work waits for one tap, and is never faked", () => {
  const reason = (text: string, context: BuildIntentContext = CHAT, extra: { hasAttachments?: boolean } = {}) =>
    agentHandoffReason(text, detectBuildIntent(text, context), { hasProject: (context.projectFileCount ?? 0) > 0, ...extra });

  it("'Deploy it' with nothing in the conversation is parked for the Agent, not answered in prose", () => {
    for (const text of ["Deploy it", "deploy it", "Publish it", "please deploy this", "can you deploy it?", "ok, redeploy it", "Deploy it now"]) {
      const intent = detectBuildIntent(text, CHAT);
      // The detector alone would ask "which project?"…
      expect(intent.needsClarification, text).toBe(true);
      expect(intent.clarification, text).toMatch(/Which project should I publish/);
      // …and the conversation hands that question to the Agent run instead.
      const why = agentHandoffReason(text, intent, { hasProject: false });
      expect(why, text).toBe("publish");
      // Approving it is "yes, publish": the run resolves or asks for the project.
      const approved = approvedIntent(intent, why!);
      expect(approved.publish, text).toBe(true);
      expect(approved.needsClarification, text).toBe(false);
      expect(buildActionsFor(approved), text).toMatchObject({ publish: true });
    }
  });

  it("everyday phrases around publishing stay ordinary chat without a project", () => {
    for (const text of ["ship it", "make it public", "launch it", "host this", "how do I deploy it?", "what does deploy it mean", "should I publish it?", "explain how to deploy it"]) {
      expect(reason(text), text).toBeNull();
    }
    // Material supplied in the message is work on that material, here.
    expect(reason("deploy it", CHAT, { hasAttachments: true })).toBeNull();
  });

  it("an intent that needed no clarification is approved unchanged", () => {
    const intent = detectBuildIntent("Update my project", CHAT);
    expect(approvedIntent(intent, "project")).toBe(intent);
  });

  it("general chat still never executes on its own", () => {
    for (const text of ["Update my project", "Deploy it", "Build me a website for my bakery"]) {
      expect(mayExecuteAgent("general", detectBuildIntent(text, CHAT_WITH_PROJECT))).toBe(false);
    }
    for (const mode of ["general", "study", "health", "research", "creative"] as const) expect(isConversationMode(mode)).toBe(true);
    for (const mode of ["agent", "code", "image", "orchestrator"] as const) expect(isConversationMode(mode)).toBe(false);
  });

  for (const text of ["Update my project", "Change the design", "Add this feature", "Remove this component", "Modify the backend", "Improve the application", "Rebrand the platform", "fix my website's navbar", "amar website ta update koro"]) {
    it(`"${text}" → awaiting approval (change a project)`, () => expect(reason(text)).toBe("project"));
  }

  for (const text of ["Build me a website for my bakery", "make me a simple landing page for my bakery", "create a modern responsive portfolio website", "build a todo app", "একটা বেকারির ওয়েবসাইট বানাও", "ekta portfolio website banao"]) {
    it(`"${text}" → awaiting approval (build)`, () => expect(reason(text)).toBe("build"));
  }

  it("publishing always needs the tap, and is named as publishing", () => {
    expect(reason("publish my site")).toBe("publish");
    expect(reason("Deploy it", CHAT_WITH_PROJECT)).toBe("publish");
    expect(reason("eta deploy koro", CHAT_WITH_PROJECT)).toBe("publish");
    // A change that also redeploys is announced as a publish, not as an edit.
    expect(reason("update the header and redeploy", CHAT_WITH_PROJECT)).toBe("publish");
  });

  it("in a conversation that owns a project, part-level changes are about that project", () => {
    expect(reason("add a paragraph about pricing", CHAT_WITH_PROJECT)).toBe("project");
    expect(reason("make the header blue", CHAT_WITH_PROJECT)).toBe("project");
    // …while the same words in a plain chat are an ordinary writing request.
    expect(reason("add a paragraph about pricing")).toBeNull();
  });

  for (const text of [
    "Write a blog post about my website",
    "design a logo for my website",
    "create a marketing plan for my online store",
    "generate website copy",
    "make a resume",
    "update my resume",
    "improve this essay",
    "translate this paragraph to Bangla",
    "add a feature comparison table to my essay",
    "launch a marketing campaign for my shop",
    "write a function to sort numbers",
    "how do I build a website?",
    "write me a poem about the sea",
    "thanks!",
  ]) {
    it(`"${text}" → ordinary chat`, () => {
      expect(reason(text)).toBeNull();
      // …and no stray "which project?" prompt either.
      expect(detectBuildIntent(text, CHAT).needsClarification).toBe(false);
    });
  }

  it("material supplied in the message is worked on in the conversation", () => {
    expect(reason("fix my website's navbar:\n```html\n<nav></nav>\n```")).toBeNull();
    expect(reason("Update my project", CHAT, { hasAttachments: true })).toBeNull();
    expect(reason("fix my app <div class=\"nav\">broken</div>")).toBeNull();
  });

  it("the approval prompt promises nothing", () => {
    for (const kind of ["publish", "project", "build"] as const) {
      const copy = handoffCopy(kind);
      expect(copy.detail).toMatch(/Nothing has been (?:published|changed|built) yet\./);
      expect(copy.action).toMatch(/Agent$/);
    }
  });
});

// ---------------------------------------------------------------------------
describe("a reply that claims work it could not have done", () => {
  for (const reply of [
    "I've updated your project with the new colours.",
    "I have deployed the site to production.",
    "Your website has been successfully published.",
    "The site is now live at https://example.com",
    "I've added the dark mode toggle to your app.",
    "Done! I just pushed the changes to the repository.",
    "The changes have been deployed to your server.",
    "I’ve rebranded the platform to QORVYNA.",
  ]) {
    it(`flags: ${reply}`, () => expect(unbackedActionClaim(reply)).toBeTruthy());
  }

  for (const reply of [
    "Here is the updated code for your header:",
    "I haven't changed your project — here is what to do.",
    "I can't deploy your site from chat. Nothing was changed.",
    "You should update the file and redeploy.",
    "I updated the function to handle null values.",
    "I will update your project once you confirm.",
    "I've fixed the bug in the code above.",
    "I've explained the steps above.",
    "```js\n// I've updated the project\n```\nUse this snippet.",
    "",
  ]) {
    it(`leaves alone: ${reply.replace(/\n/g, " ") || "(empty)"}`, () => expect(unbackedActionClaim(reply)).toBeNull());
  }

  it("the prompts tell the model that a chat reply is text, not work", () => {
    expect(SYSTEM_PROMPT).toContain("## Doing versus describing");
    expect(SYSTEM_PROMPT).toMatch(/Never write that you updated, changed, built, deployed, published, saved, sent or fixed something/);
    expect(SYSTEM_PROMPT).toMatch(/nothing has been changed yet/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/The files you return ARE the change\. If you return no file, nothing changed/);
    expect(AGENT_SYSTEM_PROMPT).toMatch(/Never claim that you ran commands, tests, a build, a preview, a commit, a push or a deployment/);
  });
});

// ---------------------------------------------------------------------------
describe("every task ends in a named state", () => {
  const run = (patch: Partial<BuildRun> = {}): BuildRun => ({
    ...createBuildRun({ id: "run1", projectId: "p1", conversationId: "c1", actions: { build: true, publish: false, preview: true }, now: Date.now() }),
    ...patch,
  });

  it("uses the four required words", () => {
    expect(TASK_OUTCOME_LABELS).toMatchObject({ completed: "Completed", failed: "Failed", blocked: "Blocked", awaiting_approval: "Awaiting approval" });
  });

  it("completed — only from a succeeded run, with the evidence that backs it", () => {
    const outcome = outcomeOfRun(run({
      status: "succeeded", fileCount: 5, previewUrl: "/preview/p1",
      changes: [{ path: "index.html", kind: "modified" }, { path: "styles.css", kind: "modified" }],
      stages: run().stages.map((stage) => (stage.id === "build" || stage.id === "validate" ? { ...stage, state: "completed" as const } : stage)),
    }));
    expect(outcome.state).toBe("completed");
    expect(outcome.evidence).toEqual(["2 files changed", "Build step passed", "Validation passed", "Preview ready"]);
    expect(outcome.nextStep).toBeNull();
  });

  it("completed + published — only when the record carries a live address", () => {
    const live = outcomeOfRun(run({
      status: "succeeded", actions: { build: true, publish: true, preview: false },
      deployment: { id: "d1", status: "live", url: "https://example.test/s/site", slug: "site", environment: "production", rollbackAvailable: false, overridden: false, error: null },
    }));
    expect(live.summary).toBe("The work was built, validated and published.");
    expect(live.evidence).toContain("Published at https://example.test/s/site");
    const notLive = outcomeOfRun(run({ status: "succeeded" }));
    expect(notLive.summary).not.toMatch(/published/);
    expect(notLive.evidence.join(" ")).not.toMatch(/Published/);
  });

  it("a workspace-only run says plainly that checks and publishing were not run", () => {
    const outcome = outcomeOfRun(run({ status: "succeeded", workspaceOnly: true, fileCount: 2 }));
    expect(outcome.state).toBe("completed");
    expect(outcome.summary).toMatch(/Build checks and publishing were not requested/);
  });

  it("failed — an attempt that did not succeed keeps its real error", () => {
    const outcome = outcomeOfRun(failRun(run({ status: "running" }), { code: "BUILD_FAILED", message: "styles.css: unexpected token at line 14." }, Date.now()));
    expect(outcome.state).toBe("failed");
    expect(outcome.summary).toBe("styles.css: unexpected token at line 14.");
    expect(outcome.code).toBe("BUILD_FAILED");
    expect(outcome.nextStep).toMatch(/Retry/);
  });

  it("blocked — the wall is named, with what removes it", () => {
    for (const code of ["AI_NOT_CONFIGURED", "HOSTING_NOT_CONFIGURED", "PROJECT_CONTEXT_MISSING", "PROJECT_AMBIGUOUS", "PUBLISH_RATE_LIMITED", "SLUG_TAKEN", "UNAUTHENTICATED"]) {
      expect(isBlockerCode(code), code).toBe(true);
      const outcome = resolveOutcome({ status: "failed", errorCode: code });
      expect(outcome.state, code).toBe("blocked");
      expect(outcome.summary.length, code).toBeGreaterThan(10);
      expect(outcome.nextStep, code).toBeTruthy();
    }
    expect(isBlockerCode("BUILD_FAILED")).toBe(false);
  });

  it("blocked keeps the pipeline's own, more specific explanation when there is one", () => {
    const outcome = outcomeOfRun(failRun(run({ status: "running" }), { code: "PROJECT_CONTEXT_MISSING", message: "No project is associated with this chat. Open the project in Workspace or choose it by name before editing." }, Date.now()));
    expect(outcome.state).toBe("blocked");
    expect(outcome.summary).toMatch(/No project is associated with this chat/);
    expect(outcome.nextStep).toMatch(/Choose the project/);
  });

  it("a request the browser could not start is classified the same way", () => {
    expect(outcomeOfRequestError("PROJECT_STORAGE_UNAVAILABLE", "Chat storage is unavailable; no Agent build was started.").state).toBe("blocked");
    expect(outcomeOfRequestError("BUILD_UNREACHABLE", "QORVYNA could not reach the build service.").state).toBe("failed");
  });

  it("awaiting approval, awaiting input, paused and stopped are states of their own", () => {
    expect(awaitingApprovalOutcome("Nothing has been changed yet.")).toMatchObject({ state: "awaiting_approval", label: "Awaiting approval", evidence: [] });
    expect(resolveOutcome({ status: "awaiting_input" }).state).toBe("awaiting_input");
    expect(resolveOutcome({ status: "paused", continuationMessage: "The files are saved. Continue resumes the repair." })).toMatchObject({ state: "paused", summary: "The files are saved. Continue resumes the repair." });
    expect(resolveOutcome({ status: "cancelled" }).state).toBe("cancelled");
    expect(resolveOutcome({ status: "running" }).state).toBe("running");
    // An unknown or missing status is never reported as success.
    expect(resolveOutcome({ status: null }).state).toBe("failed");
  });

  it("a run restored from chat history reaches the same state as the live one", () => {
    const failed = failRun(run({ status: "running" }), { code: "HOSTING_NOT_CONFIGURED", message: "Hosting is not configured." }, Date.now());
    expect(outcomeOfSnapshot(toRunSnapshot(failed)).state).toBe(outcomeOfRun(failed).state);
    const done = run({ status: "succeeded", fileCount: 3 });
    expect(outcomeOfSnapshot(toRunSnapshot(done)).state).toBe("completed");
  });
});

// ---------------------------------------------------------------------------
describe("what the user sees", () => {
  const at = () => new Date().toISOString();
  const render = (messages: ChatMessage[], mode: "general" | "agent" = "general") =>
    renderToStaticMarkup(createElement(ChatClient, { initialMessages: messages, conversationId: "c1", isTemporary: false, initialMode: mode }));

  it("the approval prompt shows the request, its state and both choices", () => {
    const html = renderToStaticMarkup(createElement(ExecutionHandoff, {
      reason: "project", request: "Update my project", onApprove: () => {}, onAnswerInChat: () => {}, onDismiss: () => {},
    }));
    expect(html).toContain("Awaiting approval");
    expect(html).toContain("Apply this change with the Agent?");
    expect(html).toContain("Update my project");
    expect(html).toContain("Run with Agent");
    expect(html).toContain("Answer in chat instead");
    expect(html).toContain("Nothing has been changed yet.");
  });

  it("a finished run shows its state word and the evidence", () => {
    const completed = renderToStaticMarkup(createElement(TaskOutcomeLine, { outcome: resolveOutcome({ status: "succeeded", changed: 3, previewUrl: "/p" }) }));
    expect(completed).toContain("Completed");
    expect(completed).toContain("3 files changed");
    const blocked = renderToStaticMarkup(createElement(TaskOutcomeLine, { outcome: resolveOutcome({ status: "failed", errorCode: "AI_NOT_CONFIGURED" }) }));
    expect(blocked).toContain("Blocked");
    expect(blocked).toContain("GROQ_API_KEY");
    expect(blocked).toContain("AI_NOT_CONFIGURED"); // the code support needs
    const failed = renderToStaticMarkup(createElement(TaskOutcomeLine, { outcome: resolveOutcome({ status: "failed", errorCode: "BUILD_FAILED", errorMessage: "index.html is missing." }) }));
    expect(failed).toContain("Failed");
    expect(failed).toContain("index.html is missing.");
  });

  it("under its own reply the line keeps to the state word and the facts", () => {
    // The reply is the sentence; the line must not say it a second time.
    const outcome = resolveOutcome({ status: "failed", errorCode: "HOSTING_NOT_CONFIGURED", errorMessage: "Publishing is not configured on this deployment.", changed: 3, stageStates: [["build", "completed"], ["validate", "completed"]] });
    const line = renderToStaticMarkup(createElement(TaskOutcomeLine, { outcome, detail: false }));
    expect(line).toContain("Blocked");
    expect(line).toContain("3 files changed");
    expect(line).toContain("Build step passed");
    expect(line).toContain("HOSTING_NOT_CONFIGURED");
    expect(line).not.toContain("Publishing is not configured on this deployment.");
    expect(line).not.toContain("An administrator must configure hosting");
  });

  it("a chat reply that says it changed the project is labelled as text only", () => {
    const html = render([
      { role: "user", content: "Update my project", created_at: at() },
      { role: "assistant", content: "I've updated your project with the new colours.", created_at: at(), metadata: { mode: "general" } },
    ]);
    expect(html).toContain("Text only.");
    expect(html).toContain("This reply did not change, build or publish anything");
    expect(html).toContain("Run with Agent");
  });

  it("a reply backed by a real run or real files is never labelled", () => {
    const backed = render([
      { role: "user", content: "Update my project", created_at: at() },
      {
        role: "assistant", content: "I've updated your project with the new colours.", created_at: at(),
        metadata: { mode: "agent", project_id: "p1", artifacts: [{ path: "index.html", content: "<!doctype html>", language: "html" }] },
      },
    ], "agent");
    expect(backed).not.toContain("Text only.");
  });

  it("an honest reply is left alone", () => {
    const html = render([
      { role: "user", content: "How do I change my header colour?", created_at: at() },
      { role: "assistant", content: "Here is the CSS to change it. Nothing has been changed yet — run it in Agent mode to apply it.", created_at: at(), metadata: { mode: "general" } },
    ]);
    expect(html).not.toContain("Text only.");
  });
});

// ---------------------------------------------------------------------------
describe("the wiring that makes it real", () => {
  const client = readFileSync("src/components/chat-client.tsx", "utf8");
  const gateway = readFileSync("src/app/api/ai/route.ts", "utf8");

  it("the browser runs the pipeline when the gateway says the work is executable", () => {
    // AGENT_RUNTIME_REQUIRED used to end as a generic error card.
    expect(client).toMatch(/gatewayError\.code === "AGENT_RUNTIME_REQUIRED"[\s\S]{0,160}executeInstead = true/);
    expect(client).toMatch(/if \(executeInstead\) \{\s*void runBuildTurn\(/);
  });

  it("a conversation-mode request for real work is parked for approval, not sent to the model", () => {
    const handoff = client.indexOf("if (handoffReason) {");
    const stream = client.indexOf("await streamMessage(message, { attachments: pending, imageStoragePath: attachedImage?.storagePath ?? null, intent, turnId, audioAssetId, ...flow });", handoff);
    expect(handoff).toBeGreaterThan(0);
    expect(stream).toBeGreaterThan(handoff);
    expect(client.slice(handoff, stream)).toMatch(/setHandoff\(\{[^}]*reason: handoffReason[^}]*\}\);\s*return;/);
    expect(client).toContain("<ExecutionHandoff");
    expect(client).toContain("onApprove={approveHandoff}");
    expect(client).toContain("onAnswerInChat={answerHandoffInChat}");
  });

  it("approving switches the conversation to Agent and runs the same turn", () => {
    const approve = client.slice(client.indexOf("function approveHandoff()"), client.indexOf("function runLatestRequestWithAgent()"));
    expect(approve).toContain('switchMode("agent")');
    expect(approve).toMatch(/void runBuildTurn\(pending\.message, intent, pending\.turnId/);
  });

  it("a blocked run is shown as blocked, and choosing the project runs the waiting request", () => {
    expect(client).toMatch(/const blocked = outcome\?\.state === "blocked";/);
    // The reply names the wall and what removes it; the code stays out of the prose.
    expect(client).toContain('`${outcome.label}: ${outcome.summary}${outcome.nextStep ? ` ${outcome.nextStep}` : ""}`');
    // The separate notice is only for a request that never became a run and can
    // be sent again: never for a blocked one, never on top of a run card.
    expect(client).toMatch(/if \(!run && !blocked\) setFailure\(/);
    expect(client).toMatch(/void runBuildTurn\(prompt, waiting, crypto\.randomUUID\(\), lastAttachmentsRef\.current, lastBuildWorkspaceOnlyRef\.current/);
  });

  it("the build card states the outcome of every finished run and offers no retry for a blocked one", () => {
    const card = readFileSync("src/components/build/build-run-card.tsx", "utf8");
    expect(card).toContain("const outcome = outcomeOfRun(run);");
    expect(card).toContain("{finished ? <TaskOutcomeLine outcome={outcome} detail={false} /> : null}");
    expect(card).toContain("onRetry={canContinue || blocked ? undefined : onRetry}");
    // Retry re-sends the latest request, so an older run never offers it.
    expect(readFileSync("src/components/assistant-message.tsx", "utf8")).toContain("onRetry={isLatest ? onRetryBuild : undefined}");
  });

  it("the gateway uses the shared detector, with the conversation's project as context", () => {
    expect(gateway).toMatch(/const requestIntent = detectBuildIntent\(message, \{ mode, agentMode: mode === "agent", hasAttachments: attachments\.length > 0, projectFileCount: activeProjectId \? 1 : 0 \}\);/);
    expect(gateway).toContain("agentHandoffReason(message, requestIntent,");
    // /api/ai still never writes project files itself.
    expect(gateway).not.toContain("applyProjectFiles(");
  });

  it("the build service's own explanation reaches the user", () => {
    const runner = readFileSync("src/lib/client/build-runner.ts", "utf8");
    expect(runner).toMatch(/new BuildRunError\(data\.error \?\? `BUILD_HTTP_\$\{res\.status\}`, typeof data\.detail === "string"/);
    expect(client).toContain("message: err.detail ??");
  });
});

// ---------------------------------------------------------------------------
// End to end through the real gateway.
// ---------------------------------------------------------------------------
const stub: FirestoreStub = sharedFirestoreStub();
const holder: { current: StubBehavior } = { current: { kind: "ok", content: "OK" } };
let calls: StubCall[] = [];
let stubOrigin = "";

beforeAll(async () => {
  const started = await startProviderStub(holder);
  calls = started.calls;
  stubOrigin = `http://127.0.0.1:${started.port}`;
  return () => started.server.close();
});
beforeEach(() => {
  stub.clearFaults();
  resetHealthCacheForTests();
  holder.current = { kind: "ok", content: "MODEL-REPLY" };
  calls.length = 0;
  vi.stubEnv("GROQ_API_KEY", "");
  vi.stubEnv("GPT_OSS_API_KEY", "sk-stub-key-1234567890");
  vi.stubEnv("GPT_OSS_BASE_URL", `${stubOrigin}/v1`);
  vi.stubEnv("GPT_OSS_MODEL", "");
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

let counter = 0;
async function post(body: Record<string, unknown>) {
  const res = await POST(new NextRequest("http://localhost:3000/api/ai", {
    method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", stream: false, request_id: `exec-${++counter}`, ...body }),
  }));
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}
const completions = () => calls.filter((call) => call.url.endsWith("/chat/completions"));
const systemText = (call: StubCall) => ((call.body?.messages ?? []) as Array<{ role: string; content: string }>).filter((message) => message.role === "system").map((message) => message.content).join("\n\n");

describe("/api/ai never answers executable Agent work with words", () => {
  for (const message of ["Update my project", "Change the design", "Add this feature", "Remove this component", "Modify the backend", "Improve the application", "Rebrand the platform"]) {
    it(`Agent mode, "${message}" → 409 with everything the browser needs to run it`, async () => {
      const res = await post({ mode: "agent", message });
      expect(res.status).toBe(409);
      expect(res.json.error).toBe("AGENT_RUNTIME_REQUIRED");
      // The turn is not lost: the conversation and the stored prompt are
      // returned so /api/build continues the same thread without a duplicate.
      expect(res.json.conversation_id).toBeTruthy();
      expect(res.json.user_message_id).toBeTruthy();
      expect(completions()).toHaveLength(0);
    });
  }

  it("Agent mode still answers a question as a question", async () => {
    const res = await post({ mode: "agent", message: "How does publishing work here?" });
    expect(res.status).toBe(200);
    expect(res.json.reply).toBe("MODEL-REPLY");
  });

  it("a chat answer about project work tells the model that nothing is being changed", async () => {
    const res = await post({ mode: "general", message: "Update my project" });
    expect(res.status).toBe(200);
    const system = systemText(completions()[0]);
    expect(system).toMatch(/this turn is a chat answer only: this reply does not change, build or publish anything/);
    expect(system).toMatch(/Do not write that you made, applied, built, deployed or published anything/);
    expect(system).toContain("## Doing versus describing");
  });

  it("an ordinary chat message gets no such note", async () => {
    await post({ mode: "general", message: "Give me three tips for learning TypeScript." });
    expect(systemText(completions()[0])).not.toMatch(/this turn is a chat answer only/);
  });
});
