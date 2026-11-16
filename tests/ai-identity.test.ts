// =============================================================================
// QORVYNA AI identity.
//
//   "Who are you?"            → QORVYNA AI, in every mode and language.
//   "Which model / provider?" → the model and provider this request is REALLY
//                               routed to — never a hard-coded or invented one.
//
// The unit tests cover the identity module and every system prompt. The
// end-to-end tests drive the REAL /api/ai route with the REAL provider client
// against a local HTTP server, so "the model was not asked" and "the model was
// told who it is" are both observed on the wire.
// =============================================================================
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";
import { startProviderStub, type StubBehavior, type StubCall } from "./helpers/provider-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => {
  const user = { uid: "identity-user", email: "identity@example.com", emailVerified: true };
  return { verifySession: vi.fn(async () => user), getSessionUser: vi.fn(async () => user) };
});

import { POST } from "../src/app/api/ai/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { BRAND, BRAND_PILLARS } from "../src/lib/brand";
import { QORVYNA_MODEL_ID, QORVYNA_MODEL_LABEL, QORVYNA_MODEL_PROVIDER, QORVYNA_MODEL_PUBLISHER } from "../src/lib/ai/model";
import { MODEL_REGISTRY, modelByKey } from "../src/lib/ai/models/registry";
import { QORVYNA_MODES, type ChatMode } from "../src/lib/ai/modes";
import { AGENT_SYSTEM_PROMPT, SYSTEM_PROMPT, agentSystemPrompt, buildAgentSystemMessages, buildModeSystemMessages, buildSystemMessages } from "../src/lib/ai/prompts";
import {
  IDENTITY_STATEMENT, IDENTITY_STATEMENT_BN, PLANNED_AREAS, defaultRouting, describeModel, identityAnswer, identityLanguage,
  identityPrompt, identityQuestion, modelFacts, personaInPlay, routingFromTargets, withIdentity,
} from "../src/lib/ai/identity";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";

const stub: FirestoreStub = sharedFirestoreStub();
const holder: { current: StubBehavior } = { current: { kind: "ok", content: "OK" } };
let calls: StubCall[] = [];
let stubOrigin = "";

const LLAMA = modelByKey("llama-3.3-70b")!;
const QWEN = modelByKey("qwen3-32b")!;
const HOSTED = [{ model: QORVYNA_MODEL_ID, provider: "Groq", providerId: "groq" }];
const POOL = [...HOSTED, { model: LLAMA.id, provider: "Groq", providerId: "groq" }, { model: QWEN.id, provider: "Groq", providerId: "groq" }];
const DEDICATED = [{ model: "gpt-oss-120b", provider: "OpenAI", providerId: "gpt-oss" }];

// ---------------------------------------------------------------------------
describe("the identity statement", () => {
  it("is the brand's own sentence, word for word", () => {
    expect(IDENTITY_STATEMENT).toBe(
      "I'm QORVYNA AI, the intelligent assistant of the QORVYNA technology ecosystem. " +
      "I help users build, develop, automate, connect, and manage technology through AI, IoT, robotics, cloud services, and software tools.",
    );
    // The names come from the brand config, not from a second copy typed here.
    expect(IDENTITY_STATEMENT).toContain(`I'm ${BRAND.aiName}`);
    expect(IDENTITY_STATEMENT).toContain(`the intelligent assistant of the ${BRAND.name} technology ecosystem`);
    expect(IDENTITY_STATEMENT_BN).toContain(BRAND.aiName);
    expect(IDENTITY_STATEMENT_BN).toMatch(/[\u0980-\u09ff]/);
    expect(IDENTITY_STATEMENT_BN).toContain("রোবোটিক্স");
  });

  it("separates what the ecosystem is about from what works today", () => {
    const planned = BRAND_PILLARS.filter((pillar) => pillar.status === "planned");
    expect(planned.length).toBeGreaterThan(0); // robotics, today
    for (const pillar of planned) {
      expect(PLANNED_AREAS.map((area) => area.toLowerCase())).toContain(pillar.label.toLowerCase());
    }
    const prompt = identityPrompt();
    // The list of working areas never contains a planned one…
    const working = prompt.split("\n").find((line) => line.startsWith("- Working in this product today:"));
    expect(working).toBeTruthy();
    for (const pillar of planned) expect(working!.toLowerCase()).not.toContain(pillar.label.toLowerCase());
    for (const pillar of BRAND_PILLARS.filter((item) => item.status === "live")) expect(working, pillar.id).toBeTruthy();
    // …and the model is told the planned area is not available yet.
    expect(prompt).toMatch(/Planned, not available yet: robotics/);
    expect(prompt).toMatch(/never describe a planned area as a working feature/);
  });

  it("does not use the former product name as its own", () => {
    expect(IDENTITY_STATEMENT).not.toMatch(/MATRIX/i);
    expect(SYSTEM_PROMPT).not.toMatch(/MATRIX/);
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/MATRIX/);
  });
});

// ---------------------------------------------------------------------------
describe("model facts come from the real routing", () => {
  it("describes the configured default from model.ts — nothing typed by hand", () => {
    const routing = defaultRouting();
    expect(routing.primary).toEqual({ id: QORVYNA_MODEL_ID, label: QORVYNA_MODEL_LABEL, publisher: QORVYNA_MODEL_PUBLISHER, provider: QORVYNA_MODEL_PROVIDER });
    const facts = modelFacts(routing).join(" ");
    expect(facts).toContain(QORVYNA_MODEL_LABEL);
    expect(facts).toContain(QORVYNA_MODEL_ID);
    expect(facts).toContain(`published by ${QORVYNA_MODEL_PUBLISHER}`);
    expect(facts).toContain(`served by ${QORVYNA_MODEL_PROVIDER}`);
    expect(facts).toContain(`${BRAND.name} is the product you are using; it did not create the underlying model.`);
  });

  it("every registered model has a publisher, so no model is described vaguely", () => {
    for (const spec of MODEL_REGISTRY) {
      expect(spec.publisher, spec.key).toBeTruthy();
      expect(describeModel(spec.id).publisher).toBe(spec.publisher);
    }
  });

  it("lists every model in the user's pool, lead model first", () => {
    const routing = routingFromTargets(POOL);
    expect(routing.primary.id).toBe(QORVYNA_MODEL_ID);
    expect(routing.others.map((model) => model.id)).toEqual([LLAMA.id, QWEN.id]);
    const facts = modelFacts(routing).join(" ");
    expect(facts).toContain(`The lead model for ${BRAND.aiName}`);
    expect(facts).toContain(`${LLAMA.label} (published by ${LLAMA.publisher})`);
    expect(facts).toContain(`${QWEN.label} (published by ${QWEN.publisher})`);
    expect(facts).toContain("it did not create these models");
  });

  it("a deployment on a dedicated endpoint is never described as the hosted provider", () => {
    const routing = routingFromTargets(DEDICATED);
    expect(routing.primary.label).toBe(QORVYNA_MODEL_LABEL);
    expect(routing.primary.provider).toMatch(/dedicated OpenAI-compatible endpoint/);
    const facts = modelFacts(routing).join(" ");
    expect(facts).not.toContain("Groq");
    expect(facts).toContain("gpt-oss-120b");
  });

  it("de-duplicates targets and falls back to the default when none are known", () => {
    expect(routingFromTargets([...HOSTED, ...HOSTED]).others).toEqual([]);
    expect(routingFromTargets([])).toEqual(defaultRouting());
  });

  it("an unregistered model ID is reported as it is, without an invented publisher", () => {
    const model = describeModel("some-future-model", "Groq");
    expect(model).toEqual({ id: "some-future-model", label: "some-future-model", publisher: null, provider: "Groq" });
  });
});

// ---------------------------------------------------------------------------
describe("every system prompt carries the identity", () => {
  const TEXT_MODES = QORVYNA_MODES.map((mode) => mode.id).filter((id) => id !== "image") as ChatMode[];

  for (const mode of TEXT_MODES) {
    it(`${mode} mode: the assistant is ${BRAND.aiName}, with the real model facts`, () => {
      const system = buildModeSystemMessages(mode, "", "en", { routing: routingFromTargets(POOL) }).map((message) => message.content).join("\n\n");
      expect(system.match(/## Identity/g)?.length, "exactly one identity block").toBe(1);
      expect(system).toContain(`You are ${BRAND.aiName}`);
      expect(system).toContain(IDENTITY_STATEMENT);
      expect(system).toContain("## Model transparency");
      expect(system).toContain(QORVYNA_MODEL_ID);
      expect(system).toContain(LLAMA.label);
      // The mode changes the working style, never the name.
      expect(system).not.toMatch(/You are QORVYNA (?:Study|Health|Research|Code|Creative|Orchestrator)\b/);
      expect(system).not.toMatch(/You are MATRIX/);
    });
  }

  it("the base prompt and the Agent prompt both end with the identity block", () => {
    expect(buildSystemMessages("", false)[0].content).toContain("## Identity");
    expect(buildAgentSystemMessages()[0].content).toContain("## Identity");
    expect(agentSystemPrompt()).toContain(AGENT_SYSTEM_PROMPT);
    expect(agentSystemPrompt(routingFromTargets(DEDICATED))).toMatch(/dedicated OpenAI-compatible endpoint/);
  });

  it("the Agent is no longer told to hide how it is routed", () => {
    expect(AGENT_SYSTEM_PROMPT).not.toMatch(/never discuss provider routing/i);
    expect(AGENT_SYSTEM_PROMPT).toContain("QORVYNA AI working as a careful software-engineering agent");
    expect(agentSystemPrompt()).toMatch(/answer truthfully and specifically/);
  });

  it("tells the model not to adopt the underlying model's or a vendor's name", () => {
    const prompt = identityPrompt(routingFromTargets(POOL));
    expect(prompt).toMatch(/Never introduce yourself as ChatGPT/);
    for (const vendor of ["OpenAI", "Groq", "Meta", "Alibaba Cloud"]) expect(prompt).toContain(vendor);
    expect(prompt).toMatch(/formerly named MATRIX\. Never call yourself MATRIX/);
    expect(prompt).toMatch(/never say quantum computing is involved/);
    expect(prompt).toMatch(/say you do not know rather than guessing/);
  });

  it("the build pipeline uses the identity-carrying Agent prompt for every model call", () => {
    const pipeline = readFileSync("src/lib/server/build.ts", "utf8");
    expect(pipeline).not.toMatch(/content: AGENT_SYSTEM_PROMPT\b/);
    expect(pipeline.match(/content: agentPrompt\(\)/g)?.length).toBe(3);
    expect(pipeline).toContain("agentSystemPrompt(team?.length ? routingFromTargets(team) : undefined)");
  });

  it("withIdentity appends to the first system message only", () => {
    const out = withIdentity([{ role: "system", content: "A" }, { role: "system", content: "B" }, { role: "user", content: "hi" }]);
    expect(out[0].content.startsWith("A\n\n## Identity")).toBe(true);
    expect(out[1].content).toBe("B");
    expect(out[2].content).toBe("hi");
    expect(withIdentity([{ role: "user", content: "hi" }])).toEqual([{ role: "user", content: "hi" }]);
  });
});

// ---------------------------------------------------------------------------
describe("recognising an identity question", () => {
  const cases: Array<[string, ReturnType<typeof identityQuestion>]> = [
    ["Who are you?", "who"],
    ["hi, who are you", "who"],
    ["What is your name?", "who"],
    ["introduce yourself", "who"],
    ["What is QORVYNA AI?", "who"],
    ["তুমি কে?", "who"],
    ["tumi ke", "who"],
    ["Which model are you using?", "model"],
    ["what model are you", "model"],
    ["What LLM powers you?", "model"],
    ["Which AI provider do you use?", "model"],
    ["what are you powered by?", "model"],
    ["তুমি কোন মডেল ব্যবহার করো?", "model"],
    ["Who made you?", "maker"],
    ["who created you", "maker"],
    ["Are you ChatGPT?", "other-assistant"],
    ["are you gpt", "other-assistant"],
    ["Are you MATRIX?", "former"],
    // Not identity questions: they go to the model.
    ["who are you to judge me", null],
    ["Who are you, and can you fix my code?", null],
    ["what model should I use for sentiment analysis?", null],
    ["which model is best for coding", null],
    ["who made the first computer?", null],
    ["what is your name origin story, please explain it in detail with every reference you can think of", null],
    ["hello", null],
    ["", null],
  ];
  for (const [message, expected] of cases) {
    it(`${JSON.stringify(message)} → ${expected ?? "not an identity question"}`, () => {
      expect(identityQuestion(message)).toBe(expected);
    });
  }

  it("a role-play the user set up is left to the model", () => {
    expect(personaInPlay([{ role: "user", content: "Let's role-play: you are Captain Jack, a pirate." }, { role: "assistant", content: "Arr!" }])).toBe(true);
    expect(personaInPlay([{ role: "user", content: "Pretend you are a medieval innkeeper." }])).toBe(true);
    expect(personaInPlay([{ role: "user", content: "What is the capital of France?" }, { role: "assistant", content: "Paris." }])).toBe(false);
    // Only what the USER said sets up a persona.
    expect(personaInPlay([{ role: "assistant", content: "I can role-play if you like." }])).toBe(false);
  });

  it("answers in the language of the question", () => {
    expect(identityLanguage("তুমি কে?")).toBe("bn");
    expect(identityLanguage("tumi ke")).toBe("bn");
    expect(identityLanguage("Who are you?", "bn")).toBe("en");
    expect(identityLanguage("Who are you?")).toBe("en");
  });
});

// ---------------------------------------------------------------------------
describe("the direct answers", () => {
  it("who → the identity statement, word for word", () => {
    expect(identityAnswer("who")).toBe(IDENTITY_STATEMENT);
    expect(identityAnswer("who", defaultRouting(), "bn")).toBe(IDENTITY_STATEMENT_BN);
  });

  it("model → the product name first, then the real model, publisher and provider", () => {
    const answer = identityAnswer("model", routingFromTargets(HOSTED));
    expect(answer.startsWith(`I'm ${BRAND.aiName}.`)).toBe(true);
    expect(answer).toContain(`${QORVYNA_MODEL_LABEL} (${QORVYNA_MODEL_ID})`);
    expect(answer).toContain(`published by ${QORVYNA_MODEL_PUBLISHER}`);
    expect(answer).toContain("served by Groq");
    expect(answer).not.toMatch(/I(?:'m| am) (?:ChatGPT|GPT|an OpenAI)/);
  });

  it("model → names every model when the account routes between several", () => {
    const answer = identityAnswer("model", routingFromTargets(POOL));
    for (const label of [QORVYNA_MODEL_LABEL, LLAMA.label, QWEN.label]) expect(answer).toContain(label);
  });

  it("maker → the operator and the model's real origin; never 'QORVYNA trained me'", () => {
    const answer = identityAnswer("maker");
    expect(answer).toContain(BRAND.operator);
    expect(answer).toContain(`published by ${QORVYNA_MODEL_PUBLISHER}`);
    expect(answer).toContain("it did not create the underlying model");
  });

  it("'are you ChatGPT?' → no, with the truth about what it runs on", () => {
    const answer = identityAnswer("other-assistant");
    expect(answer.startsWith(`No — I'm ${BRAND.aiName}.`)).toBe(true);
    expect(answer).toContain(QORVYNA_MODEL_LABEL);
  });

  it("'are you MATRIX?' → explains the rename without claiming data changed", () => {
    const answer = identityAnswer("former");
    expect(answer).toContain(`${BRAND.name} is the new name of the platform that used to be called ${BRAND.formerName}`);
    expect(answer).toContain(`I'm ${BRAND.aiName}`);
  });

  it("Bangla answers carry the same facts", () => {
    const answer = identityAnswer("model", routingFromTargets(POOL), "bn");
    expect(answer).toMatch(/[\u0980-\u09ff]/);
    for (const text of [BRAND.aiName, QORVYNA_MODEL_LABEL, QORVYNA_MODEL_ID, QORVYNA_MODEL_PUBLISHER, "Groq", LLAMA.label]) expect(answer).toContain(text);
    expect(identityAnswer("model", routingFromTargets(DEDICATED), "bn")).not.toContain("Groq");
  });
});

// ---------------------------------------------------------------------------
// End to end: the real gateway, the real provider client, a local model server.
// The deployment under test uses the dedicated endpoint, so a correct answer
// can only come from the live routing — a hard-coded "Groq" would be wrong.
// ---------------------------------------------------------------------------
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

let requestCounter = 0;
async function post(body: Record<string, unknown>) {
  const res = await POST(new NextRequest("http://localhost:3000/api/ai", {
    method: "POST", headers: { Authorization: "Bearer aaa.bbb.ccc", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "chat", request_id: `identity-${++requestCounter}`, ...body }),
  }));
  const text = await res.text();
  let json: Record<string, unknown> | null = null;
  try { json = JSON.parse(text) as Record<string, unknown>; } catch { /* SSE */ }
  return { status: res.status, type: res.headers.get("content-type") ?? "", text, json };
}
const completions = () => calls.filter((call) => call.url.endsWith("/chat/completions"));
const systemText = (call: StubCall) => ((call.body?.messages ?? []) as Array<{ role: string; content: string }>).filter((message) => message.role === "system").map((message) => message.content).join("\n\n");
const storedMessages = (conversationId: string) => [...stub._state.docs.entries()]
  .filter(([key]) => key.startsWith(`conversations/${conversationId}/messages/`))
  .map(([, value]) => value as { role: string; content: string; metadata?: Record<string, unknown> });

describe("the gateway answers identity questions itself", () => {
  it("'Who are you?' → the identity statement, without asking the model", async () => {
    const res = await post({ message: "Who are you?", stream: false });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe(IDENTITY_STATEMENT);
    expect(res.json?.identity).toBe("who");
    expect(completions()).toHaveLength(0);
    // No model produced this text, so none is attributed.
    expect(res.json?.model).toBeUndefined();
  });

  it("the question and the answer are both saved in the conversation", async () => {
    const res = await post({ message: "What is your name?", stream: false });
    const saved = storedMessages(String(res.json?.conversation_id));
    expect(saved.map((message) => message.role).sort()).toEqual(["assistant", "user"]);
    const reply = saved.find((message) => message.role === "assistant")!;
    expect(reply.content).toBe(IDENTITY_STATEMENT);
    expect(reply.metadata?.source).toBe("identity");
    expect(reply.metadata?.model).toBeUndefined();
    expect(res.json?.message_id).toBeTruthy();
    expect(res.json?.user_message_id).toBeTruthy();
  });

  it("'Which model are you using?' → the model and endpoint this deployment REALLY routes to", async () => {
    const res = await post({ message: "Which model are you using?", stream: false });
    expect(res.status).toBe(200);
    const reply = String(res.json?.reply);
    expect(reply.startsWith(`I'm ${BRAND.aiName}.`)).toBe(true);
    expect(reply).toContain(QORVYNA_MODEL_LABEL);
    expect(reply).toContain(`published by ${QORVYNA_MODEL_PUBLISHER}`);
    // This deployment is on the dedicated endpoint, and the answer says so.
    expect(reply).toMatch(/dedicated OpenAI-compatible endpoint/);
    expect(reply).not.toContain("Groq");
    expect(completions()).toHaveLength(0);
  });

  it("a streaming client gets the same answer as plain JSON", async () => {
    const res = await post({ message: "who made you?", stream: true });
    expect(res.status).toBe(200);
    expect(res.type).toContain("application/json");
    expect(String(res.json?.reply)).toContain(BRAND.operator);
    expect(completions()).toHaveLength(0);
  });

  it("answers in Bangla when asked in Bangla", async () => {
    const res = await post({ message: "তুমি কে?", stream: false });
    expect(res.json?.reply).toBe(IDENTITY_STATEMENT_BN);
  });

  it("is the same assistant in every mode — including Agent", async () => {
    for (const mode of ["general", "study", "code", "research", "creative", "health", "agent"]) {
      const res = await post({ message: "Who are you?", mode, stream: false });
      expect(res.status, mode).toBe(200);
      expect(res.json?.reply, mode).toBe(IDENTITY_STATEMENT);
    }
    expect(completions()).toHaveLength(0);
  });

  it("'Are you ChatGPT?' is answered with the product name and the real model", async () => {
    const res = await post({ message: "Are you ChatGPT?", stream: false });
    expect(String(res.json?.reply).startsWith(`No — I'm ${BRAND.aiName}.`)).toBe(true);
    expect(String(res.json?.reply)).toContain(QORVYNA_MODEL_LABEL);
  });
});

describe("everything else goes to the model — which is told who it is", () => {
  it("an ordinary message reaches the model with the identity block and the live routing", async () => {
    const res = await post({ message: "Give me three tips for learning TypeScript.", stream: false });
    expect(res.status).toBe(200);
    expect(res.json?.reply).toBe("MODEL-REPLY");
    const [call] = completions();
    const system = systemText(call);
    expect(system).toContain("## Identity");
    expect(system).toContain(`You are ${BRAND.aiName}`);
    expect(system).toContain("## Model transparency");
    expect(system).toContain(`${QORVYNA_MODEL_LABEL} (${call.body?.model})`);
    expect(system).toMatch(/dedicated OpenAI-compatible endpoint/);
    expect(system).not.toMatch(/never discuss provider routing/i);
  });

  it("a longer message that merely contains an identity phrase is not intercepted", async () => {
    const res = await post({ message: "Who are you, and can you help me plan a birthday party for twelve people?", stream: false });
    expect(res.json?.reply).toBe("MODEL-REPLY");
    expect(completions()).toHaveLength(1);
  });

  it("inside a role-play the question belongs to the story", async () => {
    const first = await post({ message: "Let's role-play: you are Captain Jack, a cheerful pirate. Stay in character.", stream: false });
    const conversationId = String(first.json?.conversation_id);
    calls.length = 0;
    const res = await post({ message: "What is your name?", conversation_id: conversationId, stream: false });
    expect(res.json?.reply).toBe("MODEL-REPLY");
    expect(completions()).toHaveLength(1);
    // The model still carries the identity for a sincere question.
    expect(systemText(completions()[0])).toContain("## Identity");
  });

  it("Regenerate on an identity turn asks the model rather than repeating a canned line", async () => {
    const first = await post({ message: "Who are you?", stream: false });
    calls.length = 0;
    const res = await post({ message: "Who are you?", conversation_id: String(first.json?.conversation_id), regenerate: true, stream: false });
    expect(res.status).toBe(200);
    expect(completions()).toHaveLength(1);
    expect(systemText(completions()[0])).toContain(IDENTITY_STATEMENT);
  });
});
