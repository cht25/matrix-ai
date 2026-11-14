// Self-healing build, reliable deployment and continuation — workflow tests.
//
// These drive the REAL pipeline (runBuildPipeline), the REAL deployment
// provider, the REAL public-site route and the REAL Groq client. Two things
// are simulated, and only these two:
//   • the Groq HTTP API (`fetch` to api.groq.com) — a scripted provider;
//   • Firestore — the in-memory stub shared by the test suite.
// Requests to the public site origin are answered by the real `/s/[slug]`
// route handler reading the same store, so "published" means the bytes were
// actually served back over that code path.
//
// Scenario letters match the acceptance list (A–J).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { type FirestoreStub } from "./helpers/firestore-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => {
  const user = { uid: "heal-user", email: "heal@example.com", emailVerified: true };
  return { verifySession: vi.fn(async () => user), getSessionUser: vi.fn(async () => user) };
});

import { sharedFirestoreStub } from "./helpers/firestore-stub";
import { GET as serveSite } from "../src/app/s/[slug]/[[...path]]/route";
import { MATRIX_MODEL_ID } from "../src/lib/ai/model";
import { resetHealthCacheForTests } from "../src/lib/ai/provider-health";
import { resetScheduler } from "../src/lib/ai/orchestrator/scheduler";
import { accountStatuses, listAccounts, markRateLimited, nextAvailability, observeHeaders, parseResetDuration, resetAccountsForTests, selectAccount } from "../src/lib/ai/accounts";
import { GroqProvider } from "../src/lib/ai/groq";
import { AIProviderError } from "../src/lib/ai/provider-error";
import type { Db } from "../src/lib/firebase/admin";
import { runBuildPipeline, type BuildPipelineResult } from "../src/lib/server/build";
import { recoverInterruptedRuns, resumeBuildRun } from "../src/lib/server/build-resume";
import { cleanupExecutionSessions, inlineGatewayHandles, sessionIdFor, setExecutionGateway, SESSION_ABANDON_MS, type ExecutionGateway } from "../src/lib/server/execution-env";
import { FirestoreDeploymentProvider } from "../src/lib/deploy/firestore-provider";
import { toFirestoreRun } from "../src/lib/deploy/run-store";
import { MAX_RUN_SEGMENTS } from "../src/lib/deploy/stages";
import { analyzeHtml, repairHtml } from "../src/lib/deploy/analyze/html";
import { jsSyntaxError, cssSyntaxError, repairJs } from "../src/lib/deploy/analyze/code";
import { validateProject } from "../src/lib/deploy/validate";
import { classifyReport, deployVerdict } from "../src/lib/deploy/classify";
import { autoRepairFiles, runRepairLoop } from "../src/lib/deploy/repair";
import type { ProjectFile } from "../src/lib/projects/paths";

const stub: FirestoreStub = sharedFirestoreStub();
const user = { uid: "heal-user", email: "heal@example.com", emailVerified: true };
const ORIGIN = "https://matrix.thamjj13.top";

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

// ---- site content ----------------------------------------------------------
const STYLE = `:root{--ink:#1d2433;--paper:#f7f4ee;--accent:#b4532a}*{box-sizing:border-box}body{margin:0;font-family:Georgia,serif;background:var(--paper);color:var(--ink);line-height:1.6}header{padding:3.5rem 1.5rem;text-align:center}h1{font-size:2.8rem;margin:0 0 .5rem}nav a{margin:0 .6rem;color:var(--accent);text-decoration:none}main{max-width:62rem;margin:0 auto;padding:2.5rem 1.5rem}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(15rem,1fr));gap:1.5rem}.card{background:#fff;border-radius:1rem;padding:1.5rem;box-shadow:0 1px 3px rgba(0,0,0,.08)}footer{padding:2rem;text-align:center;background:var(--ink);color:var(--paper)}img{max-width:100%;height:auto}@media(max-width:600px){h1{font-size:2.1rem}header{padding:2.5rem 1rem}}`;
const SCRIPT = `document.addEventListener("DOMContentLoaded", function () {\n  var year = document.querySelector("[data-year]");\n  if (year) { year.textContent = String(new Date().getFullYear()); }\n});\n`;
function page(brand: string, title: string, body: string, depth = 0): string {
  const up = "../".repeat(depth);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title} — ${brand}</title><meta name="description" content="${brand}: ${title}."><link rel="stylesheet" href="${up}styles.css"></head>
<body><header><h1>${title}</h1><p>${brand} — hand-built furniture from reclaimed oak, made to order in our Leeds workshop.</p><nav><a href="${up}index.html">Home</a><a href="${up}about.html">About</a><a href="${up}work.html">Work</a><a href="${up}contact.html">Contact</a><a href="${up}journal/first-table.html">Journal</a></nav></header>
<main><section><h2>${title}</h2><div class="grid"><article class="card"><h3>Dining tables</h3><p>${body}</p></article><article class="card"><h3>Shelving</h3><p>Wall-hung and freestanding units cut to fit the room they live in.</p></article><article class="card"><h3>Benches</h3><p>Solid seats with wedged tenons that tighten with age.</p></article></div><p><img src="${up}assets/mark.svg" alt="${brand} maker's mark" width="96" height="96"></p></section></main>
<footer><p>${brand} · <span data-year></span></p></footer><script src="${up}app.js"></script></body></html>`;
}
const MARK = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#b4532a"/><path d="M24 66 48 26l24 40z" fill="#f7f4ee"/></svg>`;
function site(brand: string, note = "Each top is planed by hand and finished with hard-wax oil."): ProjectFile[] {
  const file = (path: string, content: string): ProjectFile => ({ path, content, language: path.split(".").pop() ?? "text", encoding: "utf8" });
  return [
    file("index.html", page(brand, "Furniture that outlives its maker", note)),
    file("about.html", page(brand, "About the workshop", "Three makers, one bandsaw and a lot of patience.")),
    file("work.html", page(brand, "Recent work", "A twelve-seat table for a farmhouse kitchen in Ilkley.")),
    file("services.html", page(brand, "What we make", "Tables, shelving, benches and the occasional staircase.")),
    file("pricing.html", page(brand, "Pricing", "Dining tables start at £2,400 including delivery.")),
    file("faq.html", page(brand, "Questions", "Lead time is usually ten to twelve weeks.")),
    file("contact.html", page(brand, "Contact", "Write to hello@oakline.example or visit by appointment.")),
    file("journal/first-table.html", page(brand, "The first table", "It wobbled. We kept it anyway.", 1)),
    file("journal/oak-sourcing.html", page(brand, "Where the oak comes from", "Mostly barns in North Yorkshire.", 1)),
    file("styles.css", STYLE),
    file("app.js", SCRIPT),
    file("assets/mark.svg", MARK),
  ];
}
const asBlocks = (files: Array<{ path: string; content: string }>, lead = "Done.") => `${lead}\n\n${files.map((file) => `<<<MATRIX_FILE path="${file.path}">>>\n${file.content}\n<<<END_MATRIX_FILE>>>`).join("\n\n")}`;

// ---- simulated Groq --------------------------------------------------------
type GroqRequest = { model: string; stream: boolean; auth: string; text: string };
type Responder = (request: GroqRequest) => string | Response;
let responders: Responder[] = [];
let groq: GroqRequest[] = [];
let siteFault: ((url: URL, staged: boolean) => Response | null) | null = null;
let siteRequests: string[] = [];
const realFetch = globalThis.fetch;

function installFetch(): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (raw.startsWith(`${ORIGIN}/s/`)) {
      const url = new URL(raw);
      const headers = new Headers(init?.headers);
      const staged = url.searchParams.has("__matrix_verify");
      siteRequests.push(`${staged ? "staged" : "live"} ${url.pathname}`);
      const fault = siteFault?.(url, staged);
      if (fault) return fault;
      const [, , slug, ...rest] = url.pathname.split("/");
      return serveSite(new NextRequest(raw, { headers }), { params: Promise.resolve({ slug, path: rest.filter(Boolean) }) });
    }
    if (!raw.startsWith("https://api.groq.com/openai/v1")) throw new Error(`unexpected outbound request: ${raw}`);
    if (raw.endsWith("/models")) return new Response(JSON.stringify({ data: [{ id: MATRIX_MODEL_ID, context_window: 131072 }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    const body = JSON.parse(String(init?.body)) as { model: string; stream?: boolean; messages: Array<{ role: string; content: string }> };
    const request: GroqRequest = { model: body.model, stream: body.stream === true, auth: String(new Headers(init?.headers).get("authorization")), text: body.messages.map((message) => message.content).join("\n\n") };
    groq.push(request);
    if (!request.stream) return new Response(JSON.stringify({ model: body.model, choices: [{ message: { content: "{}" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    const next = responders.shift();
    const answer = next ? next(request) : "No changes are needed.";
    if (answer instanceof Response) return answer;
    const usage = { prompt_tokens: Math.ceil(request.text.length / 4), completion_tokens: Math.ceil(answer.length / 4), total_tokens: Math.ceil((request.text.length + answer.length) / 4) };
    return new Response(`data: ${JSON.stringify({ choices: [{ delta: { content: answer } }] })}\n\ndata: ${JSON.stringify({ choices: [], usage })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }) as typeof fetch;
}
const outage = () => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 503, headers: { "Content-Type": "application/json" } });

const key = (name: string) => `gsk_${name}_${"0".repeat(24)}`;
let runCounter = 0;
const runId = (label: string) => `heal-${label}-${++runCounter}`;

beforeEach(() => {
  stub.clearFaults();
  resetHealthCacheForTests();
  resetScheduler();
  resetAccountsForTests();
  setExecutionGateway(null);
  responders = [];
  groq = [];
  siteFault = null;
  siteRequests = [];
  vi.stubEnv("GROQ_API_KEY", `gsk_heal_000000000000_${Math.random().toString(36).slice(2, 12)}`);
  vi.stubEnv("GPT_OSS_API_KEY", "");
  vi.stubEnv("GPT_OSS_BASE_URL", "");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", ORIGIN);
  installFetch();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
});

async function conversation(title: string): Promise<string> {
  const ref = await stub.collection("conversations").add({ user_id: user.uid, title, mode: "agent", is_temporary: false, deleted_at: null });
  return ref.id;
}
type RunOptions = { prompt: string; publish?: boolean; projectId?: string | null; conversationId?: string | null; aiBudgetMs?: number; maxFixAttempts?: number; id?: string };
async function run(options: RunOptions): Promise<BuildPipelineResult> {
  const db = dbWithWrites();
  return runBuildPipeline({
    d: db, user, provider: new FirestoreDeploymentProvider(db, user), runId: options.id ?? runId("run"), requestId: `req-${runCounter}`,
    prompt: options.prompt, projectId: options.projectId ?? null, conversationId: options.conversationId ?? null,
    actions: { build: true, publish: options.publish === true, preview: false }, chatMode: "agent", isTemporary: !options.conversationId,
    aiBudgetMs: options.aiBudgetMs, maxFixAttempts: options.maxFixAttempts,
  });
}
const resume = (id: string, aiBudgetMs?: number) => { const db = dbWithWrites(); return resumeBuildRun(db, user, id, { provider: new FirestoreDeploymentProvider(db, user), aiBudgetMs }); };
const docs = (prefix: string) => [...stub._state.docs.entries()].filter(([path]) => path.startsWith(prefix));
const projectFiles = (projectId: string) => new Map(docs(`projects/${projectId}/files/`).filter(([path]) => path.split("/").length === 4).map(([, value]) => [String((value as { path: string }).path), String((value as { content: string }).content)]));
const projectCount = () => docs("projects/").filter(([path]) => path.split("/").length === 2).length;
const visit = async (path: string) => fetch(`${ORIGIN}${path}`, { redirect: "manual" });
const logText = (result: BuildPipelineResult) => result.run.logs.map((line) => line.message).join("\n");
const fail = (result: BuildPipelineResult) => JSON.stringify({ status: result.run.status, error: result.run.error, continuation: result.run.continuation, log: result.run.logs.slice(-12).map((line) => line.message) }, null, 1);

// ===========================================================================
describe("validators are real parsers", () => {
  it("HTML: finds unclosed html/body/script and structural damage, and repairs it without touching a valid page", () => {
    const good = page("Oakline", "Home", "Body copy.");
    expect(analyzeHtml(good)).toEqual([]);
    expect(repairHtml(good).content).toBe(good);
    const broken = `<!doctype html><html><head><title>x</title></head><body><main><section><h1>Hello</h1><p>Unfinished<script>const a = 1;`;
    const issues = analyzeHtml(broken).map((issue) => issue.code);
    expect(issues).toContain("html-unterminated-raw");
    const fixed = repairHtml(broken);
    expect(fixed.changed).toBe(true);
    expect(analyzeHtml(fixed.content)).toEqual([]);
    expect(fixed.content).toMatch(/<\/script>\s*<\/section>\s*<\/main>\s*<\/body>\s*<\/html>\s*$/);
    expect(analyzeHtml("<html><body><div><span></div></body></html>").some((issue) => issue.code === "html-mismatch" || issue.code === "html-unclosed")).toBe(true);
    // Text that only looks like markup inside a script is not a tag.
    expect(analyzeHtml(`<!doctype html><html><head><title>t</title></head><body><script>var s = "<div>" + "<b>";</script></body></html>`)).toEqual([]);
  });

  it("JavaScript and CSS: syntax errors carry a line, valid modern syntax passes, fences are stripped", () => {
    expect(jsSyntaxError("const a = {b: 1;\n")?.line).toBe(1);
    expect(jsSyntaxError("function f( {\n return 1 }")).not.toBeNull();
    expect(jsSyntaxError("const f = async (a) => { const { b = 1, ...rest } = a ?? {}; return b?.c ?? `${rest}`; };\nexport default f;")).toBeNull();
    expect(jsSyntaxError("const re = /[{(]/g; const s = '}) not code';")).toBeNull();
    expect(repairJs("```js\nconst a = 1;\n```")?.content.trim()).toBe("const a = 1;");
    expect(cssSyntaxError("a{color:red}\n.b{margin:0")).not.toBeNull();
    expect(cssSyntaxError(STYLE)).toBeNull();
  });

  it("project checks: missing scripts, stylesheets, assets and broken links are found, classified and decide the verdict", () => {
    const html = (extra: string) => page("Oakline", "Home", "Copy.").replace("</main>", `${extra}</main>`);
    const files: ProjectFile[] = [
      { path: "index.html", language: "html", content: html(`<a href="missing-page.html">Gone</a><img src="assets/none.png" alt="x"><script src="lost.js"></script>`) },
      { path: "styles.css", language: "css", content: STYLE }, { path: "app.js", language: "js", content: SCRIPT }, { path: "assets/mark.svg", language: "svg", content: MARK },
      ...["about.html", "work.html", "contact.html", "journal/first-table.html"].map((path) => ({ path, language: "html", content: page("Oakline", path, "Copy.", path.includes("/") ? 1 : 0) })),
    ];
    const report = validateProject(files);
    const codes = classifyReport(report).filter((issue) => issue.class !== "warning").map((issue) => issue.code);
    expect(codes).toEqual(expect.arrayContaining(["broken-link", "missing-asset", "missing-script"]));
    const verdict = deployVerdict(report);
    // A script the page needs is a blocker; a dead link and a missing image are published as known issues.
    expect(verdict.blockers.map((issue) => issue.code)).toContain("missing-script");
    expect(verdict.knownIssues.map((issue) => issue.code).sort()).toEqual(["broken-link", "missing-asset"]);
    expect(verdict.deployable).toBe(false);
    const withoutScript = files.map((file) => file.path === "index.html" ? { ...file, content: file.content.replace(`<script src="lost.js"></script>`, "") } : file);
    const relaxed = deployVerdict(validateProject(withoutScript));
    expect(relaxed.deployable).toBe(true);
    expect(relaxed.knownIssues).toHaveLength(2);
  });
});

describe("repair loop", () => {
  const evaluate = async (files: ProjectFile[]) => validateProject(files);
  const base = (): ProjectFile[] => site("Oakline");

  it("accepts a repair only when it leaves fewer errors, keeps working files, and stops when stalled", async () => {
    const files = base().map((file) => file.path === "app.js" ? { ...file, content: "function init( {\n  console.log('x');\n}\n" } : file);
    const asked: string[][] = [];
    const answers = [
      [{ path: "app.js", content: "function init() {\n  console.log('x'\n}\n" }, { path: "styles.css", content: "body{color:red}" }], // still broken + touches a healthy file
      [{ path: "app.js", content: "function init() {\n  console.log('x');\n}\ninit();\n" }],
    ];
    const saved: string[][] = [];
    const result = await runRepairLoop({
      files, evaluate, maxAttempts: 4,
      model: async (request) => { asked.push(request.targets.map((file) => file.path)); return answers.shift() ?? []; },
      onAccept: async (changed) => { saved.push(changed.map((file) => file.path)); },
    });
    expect(result.stop).toBe("clean");
    expect(result.history.map((item) => item.outcome)).toEqual(["rejected", "accepted"]);
    expect(saved).toEqual([["app.js"]]);
    // The healthy stylesheet the model tried to rewrite is untouched.
    expect(result.files.find((file) => file.path === "styles.css")?.content).toBe(STYLE);
    // Context is the broken file plus the pages that load it — not the whole project.
    expect(asked[0]).toContain("app.js");
    expect(asked[0]).not.toContain("styles.css");
    expect(asked[0]).not.toContain("assets/mark.svg");

    const stuck = await runRepairLoop({ files, evaluate, maxAttempts: 8, model: async () => [{ path: "app.js", content: "function init( {" }] });
    expect(stuck.stop).toBe("stalled");
    expect(stuck.attempts).toBe(2);
    expect(stuck.files.find((file) => file.path === "app.js")?.content).toBe(files.find((file) => file.path === "app.js")?.content);
  });

  it("deterministic repair fixes structure without a model and leaves valid files byte-identical", async () => {
    const files = base().map((file) => file.path === "about.html" ? { ...file, content: file.content.replace("</main>", "").replace("</body></html>", "") } : file);
    const auto = autoRepairFiles(files);
    expect(auto.fixes.map((fix) => fix.path)).toEqual(["about.html"]);
    for (const file of auto.files) if (file.path !== "about.html") expect(file.content).toBe(files.find((item) => item.path === file.path)?.content);
    const result = await runRepairLoop({ files, evaluate, maxAttempts: 3, model: null });
    expect(result.stop).toBe("clean");
    expect(result.attempts).toBe(0);
    expect(result.history[0]).toMatchObject({ kind: "deterministic", outcome: "accepted" });
  });
});

// ===========================================================================
describe("A. large website: create, validate, publish, verify", () => {
  it("a 12-file site with nested pages is written, published and every page and asset is served at the public address", async () => {
    responders.push(() => asBlocks(site("Oakline"), "I built the Oakline site."));
    const result = await run({ prompt: "Build a multi-page website for Oakline, a furniture workshop, with about, work, services, pricing, faq, contact and a journal.", publish: true });
    expect(result.run.status, fail(result)).toBe("succeeded");
    expect(result.run.deployment?.status).toBe("live");
    expect(result.run.fileCount).toBeGreaterThanOrEqual(12);
    const url = String(result.run.deployment?.url);
    expect(url.startsWith(`${ORIGIN}/s/`)).toBe(true);
    expect(url).not.toMatch(/localhost|127\.0\.0\.1/);
    const slug = String(result.run.deployment?.slug);
    // Verified twice: the staged release, then the live address with no credentials.
    expect(logText(result)).toMatch(/Staging verified: 9 pages, \d+ assets/);
    expect(logText(result)).toMatch(/Production verified: 9 pages and 3 assets return HTTP 200/);
    expect(siteRequests).toEqual(expect.arrayContaining([`live /s/${slug}/journal/first-table.html`, `live /s/${slug}/styles.css`, `live /s/${slug}/app.js`, `live /s/${slug}/assets/mark.svg`]));
    // A visitor gets the same bytes: nested route, stylesheet, script, image, and a refresh of a deep page.
    for (const path of ["/", "/about.html", "/journal/first-table.html", "/journal/oak-sourcing.html", "/styles.css", "/app.js", "/assets/mark.svg", "/journal/first-table.html"]) {
      const response = await visit(`/s/${slug}${path}`);
      expect(response.status, path).toBe(200);
    }
    expect(await (await visit(`/s/${slug}/journal/first-table.html`)).text()).toContain("It wobbled. We kept it anyway.");
    expect(await (await visit(`/s/${slug}/styles.css`)).text()).toBe(STYLE);
    expect((await visit(`/s/${slug}`)).status).toBe(308);
    expect(result.run.repairs ?? []).toEqual([]);
  });
});

describe("B. automatic repair of deliberately broken HTML and JavaScript", () => {
  it("unclosed html/body/script, a JS syntax error and a missing script are found and fixed; the run publishes the repaired files", async () => {
    const files = site("Thornbury");
    const broken = files.map((file) => {
      if (file.path === "index.html") return { ...file, content: file.content.replace(`<script src="app.js"></script></body></html>`, `<script src="app.js"></script><script src="menu.js"></script><script>document.title = "Thornbury";`) };
      if (file.path === "contact.html") return { ...file, content: file.content.replace("</main>", "").replace("</body></html>", "") };
      if (file.path === "app.js") return { ...file, content: `document.addEventListener("DOMContentLoaded", function () {\n  var year = document.querySelector("[data-year]");\n  if (year) { year.textContent = String(new Date().getFullYear(); }\n});\n` };
      return file;
    });
    responders.push(() => asBlocks(broken, "Built."));
    // Attempt 1 makes the script worse; attempt 2 fixes the script and supplies the missing file.
    responders.push(() => asBlocks([{ path: "app.js", content: "document.addEventListener('DOMContentLoaded', function () {\n  var year = ;\n" }]));
    responders.push(() => asBlocks([{ path: "app.js", content: SCRIPT }, { path: "menu.js", content: "document.documentElement.classList.add('js');\n" }]));
    const result = await run({ prompt: "Build a multi-page website for Thornbury, a furniture workshop, with about, work, contact and a journal.", publish: true });
    expect(result.run.status, fail(result)).toBe("succeeded");
    expect(result.run.deployment?.status).toBe("live");
    const repairs = result.run.repairs ?? [];
    expect(repairs[0]).toMatchObject({ kind: "deterministic", outcome: "accepted" });
    expect(repairs[0].files.sort()).toEqual(["contact.html", "index.html"]);
    expect(repairs.filter((item) => item.kind === "model").map((item) => item.outcome)).toEqual(["rejected", "accepted"]);
    expect(result.run.attempts).toBe(2);
    // The repair request carried the exact error and only the files involved.
    const repairRequest = groq.filter((request) => request.text.includes("The MATRIX validator found the problems below"))[0];
    expect(repairRequest.text).toMatch(/app\.js:3 — /);
    expect(repairRequest.text).toMatch(/menu\.js/);
    expect(repairRequest.text).toContain("<<<FILE app.js>>>");
    expect(repairRequest.text).not.toContain("<<<FILE styles.css>>>");
    expect(repairRequest.text).not.toContain("<<<FILE journal/oak-sourcing.html>>>");
    // The second request says why the first attempt was refused.
    expect(groq.filter((request) => request.text.includes("Your previous attempt was not applied"))).toHaveLength(1);
    // What is stored and what is served are the repaired files.
    const stored = projectFiles(String(result.projectId));
    expect(jsSyntaxError(stored.get("app.js") ?? "")).toBeNull();
    expect(stored.get("menu.js")).toContain("classList.add");
    expect(analyzeHtml(stored.get("index.html") ?? "")).toEqual([]);
    expect(analyzeHtml(stored.get("contact.html") ?? "")).toEqual([]);
    expect(stored.get("styles.css")).toBe(STYLE);
    const slug = String(result.run.deployment?.slug);
    expect((await (await visit(`/s/${slug}/app.js`)).text()).trim()).toBe(SCRIPT.trim());
    expect((await visit(`/s/${slug}/menu.js`)).status).toBe(200);
    // A restore point was saved before the first repair touched the project.
    expect(docs(`projects/${result.projectId}/versions/`).some(([, value]) => (value as { summary?: string }).summary === "Before automatic repair")).toBe(true);
    expect(logText(result)).toContain("Repair completed.");
  });

  it("an unrepairable page is NOT published and the exact blocker is reported; a non-critical leftover is published as a known issue", async () => {
    const files = site("Marlow").map((file) => file.path === "app.js" ? { ...file, content: "function boot( {\n" } : file);
    responders.push(() => asBlocks(files, "Built."));
    for (let i = 0; i < 6; i += 1) responders.push(() => asBlocks([{ path: "app.js", content: "function boot( {\n  // still broken\n" }]));
    const failed = await run({ prompt: "Build a multi-page website for Marlow, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error?.code).toBe("BUILD_FAILED");
    expect(failed.run.error?.message).toMatch(/app\.js:\d+ — /);
    expect(failed.run.error?.message).toMatch(/stopped making progress/);
    expect(failed.run.deployment).toBeNull();
    expect(siteRequests).toEqual([]);
    // The failure can be continued from the saved files rather than restarted.
    expect(failed.run.continuation).toMatchObject({ available: true, phase: "repair" });

    responders = [];
    resetScheduler();
    const linked = site("Penrose").map((file) => file.path === "faq.html" ? { ...file, content: file.content.replace("</main>", `<p><a href="returns.html">Returns policy</a></p></main>`) } : file);
    responders.push(() => asBlocks(linked, "Built."));
    const published = await run({ prompt: "Build a multi-page website for Penrose, a furniture workshop, with about, work, faq and contact pages.", publish: true });
    expect(published.run.status, fail(published)).toBe("succeeded");
    expect(published.run.deployment?.status).toBe("live");
    expect(published.run.knownIssues).toBe(1);
    expect(published.reply).toMatch(/Known issue/);
    expect(published.reply).toMatch(/faq\.html/);
    expect(published.reply).toMatch(/returns\.html/);
  });
});

describe("C + H. editing an existing project keeps the project, the address and earlier sites", () => {
  it("a follow-up edit updates the same project and URL, adds a deployment, and other live sites are untouched", async () => {
    responders.push(() => asBlocks(site("Ashdown"), "Built."));
    const chat = await conversation("Ashdown site");
    const first = await run({ prompt: "Build a multi-page website for Ashdown, a furniture workshop, with about, work and contact pages.", publish: true, conversationId: chat });
    expect(first.run.status, fail(first)).toBe("succeeded");
    const projectId = String(first.projectId);
    const slug = String(first.run.deployment?.slug);
    const siteBefore = structuredClone(stub._state.docs.get(`published_sites/${slug}`)) as Record<string, unknown>;

    // An unrelated site that was live before this work, stored the older way (files directly on the site).
    await stub.collection("published_sites").doc("legacy-shop").set({ status: "live", owner_id: "someone-else", project_id: "legacy-project", slug: "legacy-shop" });
    await stub.collection("published_sites").doc("legacy-shop").collection("files").doc("index").set({ path: "index.html", content: "<!doctype html><html><head><title>Legacy</title></head><body><h1>Legacy shop</h1></body></html>", content_type: "text/html", encoding: "utf8" });
    const legacyBefore = JSON.stringify(docs("published_sites/legacy-shop"));

    const projectsBefore = projectCount();
    const edited = site("Ashdown").find((file) => file.path === "contact.html")!;
    responders.push(() => asBlocks([{ path: "contact.html", content: edited.content.replace("visit by appointment", "visit by appointment — now open Saturdays") }], "Updated the contact page."));
    const second = await run({ prompt: "On the contact page, mention that we are now open Saturdays, and deploy the changes again.", publish: true, conversationId: chat });
    expect(second.run.status, fail(second)).toBe("succeeded");
    expect(second.projectId).toBe(projectId);
    expect(projectCount()).toBe(projectsBefore);
    expect(second.run.deployment?.slug).toBe(slug);
    expect(second.run.deployment?.url).toBe(first.run.deployment?.url);
    expect(second.run.deployment?.id).not.toBe(first.run.deployment?.id);
    expect(second.run.changes.map((change) => `${change.path}:${change.kind}`)).toEqual(["contact.html:modified"]);
    expect(await (await visit(`/s/${slug}/contact.html`)).text()).toContain("now open Saturdays");
    expect(await (await visit(`/s/${slug}/about.html`)).text()).toContain("Three makers, one bandsaw");
    // Same site record: id, owner, project and creation time are unchanged; only the release pointer moved.
    const siteAfter = stub._state.docs.get(`published_sites/${slug}`) as Record<string, unknown>;
    expect(siteAfter.owner_id).toBe(siteBefore.owner_id);
    expect(siteAfter.project_id).toBe(siteBefore.project_id);
    expect(siteAfter.created_at).toEqual(siteBefore.created_at);
    expect(siteAfter.live_release_id).toBe(second.run.deployment?.id);
    const deployments = docs("deployments/").filter(([path, value]) => path.split("/").length === 2 && (value as { project_id?: string }).project_id === projectId);
    expect(deployments).toHaveLength(2);
    expect(deployments.filter(([, value]) => (value as { status?: string }).status === "live")).toHaveLength(1);
    // The older site still serves and its records were not rewritten.
    const legacy = await visit("/s/legacy-shop/");
    expect(legacy.status).toBe(200);
    expect(await legacy.text()).toContain("Legacy shop");
    expect(JSON.stringify(docs("published_sites/legacy-shop"))).toBe(legacyBefore);
  });
});

describe("D. a new execution session continues the same chat, project and run", () => {
  it("provider outage while writing: nothing is lost, and the next session finishes the same run with one chat message", async () => {
    const chat = await conversation("Fernhill site");
    responders.push(outage, outage, outage);
    const id = runId("pause");
    const paused = await run({ id, prompt: "Build a multi-page website for Fernhill, a furniture workshop, with about, work and contact pages.", publish: true, conversationId: chat });
    expect(paused.run.status, fail(paused)).toBe("paused");
    expect(paused.run.continuation).toMatchObject({ available: true, reason: "provider_unavailable", phase: "generate" });
    const projectId = String(paused.projectId);
    expect(projectFiles(projectId).size).toBe(0);
    const projectsBefore = projectCount();
    const conversationsBefore = docs("conversations/").filter(([path]) => path.split("/").length === 2).length;
    const stored = stub._state.docs.get(`build_runs/${id}`) as { resumable?: boolean; resume?: { prompt?: string; projectId?: string; conversationId?: string; pending?: string[] } };
    expect(stored.resumable).toBe(true);
    expect(stored.resume).toMatchObject({ projectId, conversationId: chat, phase: "generate" });
    expect(stored.resume?.prompt).toContain("Fernhill");
    expect(stored.resume?.pending).toEqual(expect.arrayContaining(["generate", "publish"]));

    responders = [() => asBlocks(site("Fernhill"), "Built.")];
    resetScheduler();
    const done = await resume(id);
    expect(done.run.status, fail(done)).toBe("succeeded");
    expect(done.run.id).toBe(id);
    expect(done.run.segment).toBe(2);
    expect(done.projectId).toBe(projectId);
    expect(done.run.conversationId).toBe(chat);
    expect(done.run.deployment?.status).toBe("live");
    expect(projectCount()).toBe(projectsBefore);
    expect(docs("conversations/").filter(([path]) => path.split("/").length === 2).length).toBe(conversationsBefore);
    // One assistant message for the run: the paused notice was updated in place, not followed by a second message.
    const messages = docs(`conversations/${chat}/messages/`).map(([, value]) => value as { role: string; content: string; metadata?: { build?: { status?: string; run_id?: string } } });
    expect(messages).toHaveLength(1);
    expect(messages[0].metadata?.build).toMatchObject({ run_id: id, status: "succeeded" });
    expect(messages[0].content).toContain("Live: ");
    // Nothing left to resume, and a second attempt is refused.
    expect((stub._state.docs.get(`build_runs/${id}`) as { resume?: unknown; resumable?: boolean }).resume).toBeNull();
    await expect(resume(id)).rejects.toMatchObject({ code: "NOTHING_TO_RESUME" });
  });

  it("time limit during repair: fixed files are kept, the next session repairs from them and never regenerates", async () => {
    const files = site("Glenmoor").map((file) => file.path === "app.js" ? { ...file, content: "function boot( {\n" } : file);
    responders.push(() => asBlocks(files, "Built."));
    const id = runId("deadline");
    const paused = await run({ id, prompt: "Build a multi-page website for Glenmoor, a furniture workshop, with about, work and contact pages.", publish: true, aiBudgetMs: 0 });
    // With no time left the generation call itself is refused or the repair hits the deadline: either way the run pauses.
    expect(paused.run.status, fail(paused)).toBe("paused");
    expect(paused.run.continuation?.reason).toBe("time_limit");
    const projectId = String(paused.projectId);
    if (paused.run.continuation?.phase === "repair") {
      expect(projectFiles(projectId).size).toBe(12);
      const generationCalls = groq.filter((request) => request.text.includes("MATRIX build pipeline: emit complete")).length;
      responders = [() => asBlocks([{ path: "app.js", content: SCRIPT }])];
      const done = await resume(id);
      expect(done.run.status, fail(done)).toBe("succeeded");
      expect(done.projectId).toBe(projectId);
      expect(logText(done)).toContain("already saved in the project by the earlier session");
      // No further generation request: only the repair was asked for.
      expect(groq.filter((request) => request.text.includes("MATRIX build pipeline: emit complete")).length).toBe(generationCalls);
      expect(projectFiles(projectId).get("app.js")?.trim()).toBe(SCRIPT.trim());
      expect(done.run.changes.length).toBeGreaterThanOrEqual(12);
    } else {
      expect(paused.run.continuation?.phase).toBe("generate");
      expect(projectFiles(projectId).size).toBe(0);
    }
  });

  it("continuation is bounded: after the session limit the run stops with a clear reason instead of looping", async () => {
    const id = runId("loop");
    responders.push(outage, outage, outage);
    let result = await run({ id, prompt: "Build a multi-page website for Harrow, a furniture workshop, with about and contact pages.", publish: true });
    let sessions = 1;
    while (result.run.status === "paused" && sessions < 12) {
      responders = [outage, outage, outage];
      resetScheduler();
      result = await resume(id);
      sessions += 1;
    }
    expect(sessions).toBe(MAX_RUN_SEGMENTS);
    expect(result.run.status).toBe("failed");
    expect(result.run.error?.code).toBe("CONTINUATION_LIMIT");
    await expect(resume(id)).rejects.toMatchObject({ code: "CONTINUATION_LIMIT" });
  });
});

describe("E. Groq account rotation", () => {
  const A = key("acct_a");
  const B = key("acct_b");
  const C = key("acct_c");
  const limited = (retryAfter: string) => new Response(JSON.stringify({ error: { message: `Rate limit reached for model in organization org_x on tokens per minute (TPM): Limit 8000, Used 7900, Requested 600. Please try again in ${retryAfter}s.`, type: "tokens", code: "rate_limit_exceeded" } }), { status: 429, headers: { "Content-Type": "application/json", "retry-after": retryAfter } });
  const ok = (auth: string) => new Response(JSON.stringify({ model: MATRIX_MODEL_ID, choices: [{ message: { content: `answer via ${auth.slice(-30, -24)}` }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } }), { status: 200, headers: { "Content-Type": "application/json", "x-ratelimit-limit-requests": "14400", "x-ratelimit-remaining-requests": "14399", "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "7400", "x-ratelimit-reset-tokens": "4.5s", "x-ratelimit-reset-requests": "6s" } });
  let calls: string[] = [];
  let behaviour: Record<string, () => Response> = {};
  let nowMs = 1_800_000_000_000;

  beforeEach(() => {
    calls = [];
    behaviour = {};
    nowMs = 1_800_000_000_000;
    vi.stubEnv("GROQ_API_KEY", A);
    vi.stubEnv("GROQ_API_KEY_2", B);
    vi.stubEnv("GROQ_API_KEYS", `${C}, ${A}`);
    resetAccountsForTests({ clock: () => nowMs });
    globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const auth = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
      calls.push(auth);
      return (behaviour[auth] ?? (() => ok(auth)))();
    }) as typeof fetch;
  });
  const ask = () => new GroqProvider(A, { pooled: true }).chat({ model: MATRIX_MODEL_ID, messages: [{ role: "user", content: "hello" }], maxTokens: 200 });

  it("registers every distinct key once, from GROQ_API_KEY, numbered keys and the list", () => {
    expect(listAccounts().map((account) => account.key)).toEqual([A, B, C]);
    expect(new Set(listAccounts().map((account) => account.id)).size).toBe(3);
    expect(JSON.stringify(accountStatuses())).not.toContain("gsk_");
    expect(parseResetDuration("2m59.56s")).toBe(179_560);
    expect(parseResetDuration("7.66s")).toBe(7_660);
    expect(parseResetDuration("450ms")).toBe(450);
    expect(parseResetDuration("12")).toBe(12_000);
  });

  it("a rate-limited account hands the same request to another account, and is not selected again until its retry time", async () => {
    behaviour[A] = () => limited("42");
    const first = await ask();
    expect(first.content).toMatch(/^answer via /);
    expect(calls).toEqual([A, B]);
    // While A is cooling down it is never asked.
    for (let i = 0; i < 4; i += 1) await ask();
    expect(calls.slice(2)).not.toContain(A);
    const status = accountStatuses().find((account) => account.key_hint === `…${A.slice(-4)}` && account.state === "rate_limited") ?? accountStatuses().find((account) => account.state === "rate_limited");
    expect(status?.state).toBe("rate_limited");
    expect(new Date(String(status?.available_at)).getTime()).toBe(nowMs + 42_000);
    // Once the provider's own retry time has passed, A is eligible again.
    nowMs += 43_000;
    behaviour[A] = () => ok(A);
    calls = [];
    for (let i = 0; i < 6; i += 1) await ask();
    expect(calls).toContain(A);
  });

  it("limits come from the provider's headers: an account reported out of tokens is skipped without sending a request", async () => {
    const [a, b, c] = listAccounts();
    const exhausted = new Headers({ "x-ratelimit-limit-tokens": "8000", "x-ratelimit-remaining-tokens": "50", "x-ratelimit-reset-tokens": "30s", "x-ratelimit-limit-requests": "100", "x-ratelimit-remaining-requests": "90", "x-ratelimit-reset-requests": "30s" });
    observeHeaders(a.id, MATRIX_MODEL_ID, exhausted);
    observeHeaders(b.id, MATRIX_MODEL_ID, exhausted);
    expect(selectAccount(MATRIX_MODEL_ID, 600).account?.id).toBe(c.id);
    await ask();
    expect(calls).toEqual([C]);
    const view = accountStatuses().find((account) => account.id === a.id)!;
    expect(view.models[0]).toMatchObject({ limit_tokens: 8000, remaining_tokens: 50, limit_requests: 100, remaining_requests: 90 });
  });

  it("when every account is limited the request fails once, honestly, with the time it can be retried — no hammering", async () => {
    behaviour[A] = () => limited("30");
    behaviour[B] = () => limited("90");
    behaviour[C] = () => limited("60");
    const error = await ask().catch((cause) => cause as AIProviderError);
    expect(error).toBeInstanceOf(AIProviderError);
    expect((error as AIProviderError).type).toBe("rate_limit");
    expect((error as AIProviderError).detail).toMatch(/all 3 connected accounts tried/);
    expect((error as AIProviderError).retryAt).toBe(nowMs + 30_000);
    expect(calls).toHaveLength(3);
    expect(nextAvailability(MATRIX_MODEL_ID)).toBe(nowMs + 30_000);
    // A second request does not touch the provider at all while every account is cooling down.
    const again = await ask().catch((cause) => cause as AIProviderError);
    expect((again as AIProviderError).type).toBe("rate_limit");
    expect((again as AIProviderError).retryAt).toBe(nowMs + 30_000);
    expect(calls).toHaveLength(3);
    // Without a provider-stated wait, the pause doubles per consecutive limit.
    const [a] = listAccounts();
    resetAccountsForTests({ clock: () => nowMs });
    expect(markRateLimited(a.id, MATRIX_MODEL_ID, null) - nowMs).toBe(30_000);
    expect(markRateLimited(a.id, MATRIX_MODEL_ID, null) - nowMs).toBe(60_000);
    expect(markRateLimited(a.id, MATRIX_MODEL_ID, null) - nowMs).toBe(120_000);
  });

  it("a rejected key is set aside and the request continues; a bad request is not retried on other accounts", async () => {
    behaviour[A] = () => new Response(JSON.stringify({ error: { message: "Invalid API Key", code: "invalid_api_key" } }), { status: 401, headers: { "Content-Type": "application/json" } });
    await ask();
    expect(calls).toEqual([A, B]);
    expect(accountStatuses().find((account) => account.state === "invalid")).toBeTruthy();
    calls = [];
    behaviour = { [B]: () => new Response(JSON.stringify({ error: { message: "messages: too long" } }), { status: 400, headers: { "Content-Type": "application/json" } }), [C]: () => new Response(JSON.stringify({ error: { message: "messages: too long" } }), { status: 400, headers: { "Content-Type": "application/json" } }) };
    await expect(ask()).rejects.toMatchObject({ status: 400 });
    expect(calls).toHaveLength(1);
  });

  it("a build keeps going on another account when the first hits its limit mid-task — same run, same project", async () => {
    resetAccountsForTests();
    installFetch();
    const seen: string[] = [];
    responders.push((request) => { seen.push(request.auth); return limited("50"); });
    responders.push((request) => { seen.push(request.auth); return asBlocks(site("Islington"), "Built."); });
    const result = await run({ prompt: "Build a multi-page website for Islington, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(result.run.status, fail(result)).toBe("succeeded");
    expect(seen).toHaveLength(2);
    expect(seen[0]).not.toBe(seen[1]);
    expect(result.run.segment ?? 1).toBe(1);
    expect(projectFiles(String(result.projectId)).size).toBe(12);
  });
});

describe("F. execution environment lifecycle and cleanup", () => {
  it("each session is recorded, verified against storage, released, and leaves nothing behind", async () => {
    const acquired: string[] = [];
    const released: string[] = [];
    const gateway: ExecutionGateway = { name: "test-gateway", acquire: async ({ sessionId }) => { acquired.push(sessionId); return { handle: `env-${sessionId}` }; }, release: async (handle) => { released.push(handle); } };
    setExecutionGateway(gateway);
    responders.push(() => asBlocks(site("Juniper"), "Built."));
    const id = runId("env");
    const result = await run({ id, prompt: "Build a multi-page website for Juniper, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(result.run.status, fail(result)).toBe("succeeded");
    const sessionId = sessionIdFor(id, 1);
    expect(acquired).toEqual([sessionId]);
    expect(released).toEqual([`env-${sessionId}`]);
    const record = stub._state.docs.get(`execution_sessions/${sessionId}`) as Record<string, unknown>;
    expect(record).toMatchObject({ run_id: id, owner_id: user.uid, gateway: "test-gateway", status: "terminated", verified: true, project_id: result.projectId });
    expect(String(record.verify_detail)).toMatch(/12 files verified in project storage/);
    expect((record.cleanup as { released: boolean }).released).toBe(true);
    // The record holds no file content and no credential.
    expect(JSON.stringify(record)).not.toMatch(/gsk_|<!doctype/i);
    expect(inlineGatewayHandles()).toEqual([]);
  });

  it("cleanup releases abandoned and unreleased environments, is idempotent, and never touches project or published files", async () => {
    responders.push(() => asBlocks(site("Kestrel"), "Built."));
    const live = await run({ prompt: "Build a multi-page website for Kestrel, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(live.run.status, fail(live)).toBe("succeeded");
    const protectedBefore = JSON.stringify([...docs(`projects/${live.projectId}`), ...docs("published_sites/"), ...docs("deployments/")]);
    const released: string[] = [];
    let failRelease = true;
    setExecutionGateway({ name: "test-gateway", acquire: async ({ sessionId }) => ({ handle: sessionId }), release: async (handle) => { if (handle === "env-flaky" && failRelease) throw new Error("gateway timeout"); released.push(handle); } });
    const now = Date.now();
    await stub.collection("execution_sessions").doc("crashed-s1").set({ run_id: "crashed", status: "active", handle: "env-crashed", heartbeat_at: now - SESSION_ABANDON_MS - 1000 });
    await stub.collection("execution_sessions").doc("working-s1").set({ run_id: "working", status: "active", handle: "env-working", heartbeat_at: now - 5_000 });
    await stub.collection("execution_sessions").doc("flaky-s1").set({ run_id: "flaky", status: "persisted", handle: "env-flaky", heartbeat_at: now - 60_000 });
    await stub.collection("execution_sessions").doc("old-s1").set({ run_id: "old", status: "terminated", handle: "env-old", heartbeat_at: now - 9 * 24 * 3_600_000, cleanup: { at: now - 8 * 24 * 3_600_000 } });
    const first = await cleanupExecutionSessions(dbWithWrites(), now);
    expect(first).toMatchObject({ abandoned: 1, released: 0, purged: 1, errors: 1 });
    expect(released).toEqual(["env-crashed"]);
    expect((stub._state.docs.get("execution_sessions/crashed-s1") as { status: string }).status).toBe("abandoned");
    expect((stub._state.docs.get("execution_sessions/working-s1") as { status: string }).status).toBe("active");
    expect(stub._state.docs.has("execution_sessions/old-s1")).toBe(false);
    // The release that failed is retried on the next pass; finished work is not repeated.
    failRelease = false;
    const second = await cleanupExecutionSessions(dbWithWrites(), now);
    expect(second).toMatchObject({ abandoned: 0, released: 1, purged: 0, errors: 0 });
    expect(released).toEqual(["env-crashed", "env-flaky"]);
    const third = await cleanupExecutionSessions(dbWithWrites(), now);
    expect(third).toMatchObject({ abandoned: 0, released: 0, purged: 0, errors: 0 });
    expect(released).toHaveLength(2);
    expect(JSON.stringify([...docs(`projects/${live.projectId}`), ...docs("published_sites/"), ...docs("deployments/")])).toBe(protectedBefore);
    expect((await visit(`/s/${live.run.deployment?.slug}/about.html`)).status).toBe(200);
  });
});

describe("G. deployment failure: diagnostics, rollback, retry", () => {
  it("a release that fails the production check is rolled back automatically; Retry publishes without rebuilding", async () => {
    responders.push(() => asBlocks(site("Larkspur", "Version one of the table copy."), "Built."));
    const first = await run({ prompt: "Build a multi-page website for Larkspur, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(first.run.status, fail(first)).toBe("succeeded");
    const projectId = String(first.projectId);
    const slug = String(first.run.deployment?.slug);

    const index = site("Larkspur", "Version two of the table copy.").find((file) => file.path === "index.html")!;
    responders.push(() => asBlocks([{ path: "index.html", content: index.content }], "Updated."));
    // Hosting serves the staged release, but the live address fails for one stylesheet after activation.
    siteFault = (url, staged) => (!staged && url.pathname.endsWith("/styles.css") ? new Response("upstream error", { status: 502 }) : null);
    const id = runId("deploy-fail");
    const failed = await run({ id, prompt: "Change the home page table copy to version two and publish it.", publish: true, projectId });
    expect(failed.run.status).toBe("failed");
    expect(failed.run.error?.code).toBe("DEPLOY_VERIFY_FAILED");
    expect(failed.run.error?.message).toMatch(/Asset styles\.css returned HTTP 502/);
    expect(failed.run.error?.message).toMatch(/previous version was restored automatically/i);
    expect(failed.run.deployment?.status ?? "failed").not.toBe("live");
    expect(logText(failed)).toMatch(/Production check failed after activation/);
    expect(logText(failed)).toMatch(/rollback: Restoring the previous live release automatically/);
    // The previous version is what visitors get; the site record points at the old release again.
    siteFault = null;
    expect(await (await visit(`/s/${slug}/`)).text()).toContain("Version one of the table copy.");
    const siteDoc = stub._state.docs.get(`published_sites/${slug}`) as Record<string, unknown>;
    expect(siteDoc.live_release_id).toBe(first.run.deployment?.id);
    expect(siteDoc.status).toBe("live");
    expect((stub._state.docs.get(`projects/${projectId}`) as Record<string, unknown>).live_deployment_id).toBe(first.run.deployment?.id);
    // The failed deployment keeps its diagnostics.
    const failedDeployment = docs("deployments/").map(([, value]) => value as Record<string, unknown>).find((value) => value.run_id === id)!;
    expect(failedDeployment).toMatchObject({ status: "failed", failed_stage: "verify", verification_status: "failed" });
    expect(String(failedDeployment.error)).toMatch(/502/);
    // The edit itself is saved in the project, so Retry only publishes.
    expect(projectFiles(projectId).get("index.html")).toContain("Version two");
    expect(failed.run.continuation).toMatchObject({ available: true, phase: "publish" });
    const modelCalls = groq.length;
    const retried = await resume(id);
    expect(retried.run.status, fail(retried)).toBe("succeeded");
    expect(retried.run.deployment?.status).toBe("live");
    expect(retried.run.deployment?.slug).toBe(slug);
    expect(groq.length).toBe(modelCalls);
    expect(await (await visit(`/s/${slug}/`)).text()).toContain("Version two of the table copy.");
  });

  it("a first publish that cannot be verified leaves nothing live and says so", async () => {
    responders.push(() => asBlocks(site("Mistral"), "Built."));
    siteFault = (url, staged) => (staged && url.pathname.endsWith("/about.html") ? new Response("nope", { status: 500 }) : null);
    const result = await run({ prompt: "Build a multi-page website for Mistral, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(result.run.status).toBe("failed");
    expect(result.run.error?.code).toBe("DEPLOY_VERIFY_FAILED");
    expect(result.run.error?.message).toMatch(/Page about\.html returned HTTP 500/);
    siteFault = null;
    const slug = String((docs("deployments/").map(([, value]) => value as Record<string, unknown>).find((value) => value.run_id === result.run.id) ?? {}).slug);
    expect((await visit(`/s/${slug}/`)).status).toBe(404);
  });
});

describe("I. concurrent tasks do not interfere", () => {
  it("two builds at once write to their own projects and addresses; one run cannot be continued twice at the same time", async () => {
    const answer: Responder = (request) => asBlocks(site(request.text.includes("Northgate") ? "Northgate" : "Orchard"), "Built.");
    responders.push(answer, answer);
    const [north, orchard] = await Promise.all([
      run({ prompt: "Build a multi-page website for Northgate, a furniture workshop, with about, work and contact pages.", publish: true }),
      run({ prompt: "Build a multi-page website for Orchard, a furniture workshop, with about, work and contact pages.", publish: true }),
    ]);
    expect(north.run.status, fail(north)).toBe("succeeded");
    expect(orchard.run.status, fail(orchard)).toBe("succeeded");
    expect(north.projectId).not.toBe(orchard.projectId);
    expect(north.run.deployment?.slug).not.toBe(orchard.run.deployment?.slug);
    for (const content of projectFiles(String(north.projectId)).values()) expect(content).not.toContain("Orchard");
    for (const content of projectFiles(String(orchard.projectId)).values()) expect(content).not.toContain("Northgate");
    expect(await (await visit(`/s/${north.run.deployment?.slug}/`)).text()).toContain("Northgate");
    expect(await (await visit(`/s/${orchard.run.deployment?.slug}/`)).text()).toContain("Orchard");

    const id = runId("double");
    responders.push(outage, outage, outage);
    const paused = await run({ id, prompt: "Build a multi-page website for Pinecrest, a furniture workshop, with about and contact pages.", publish: true });
    expect(paused.run.status).toBe("paused");
    resetScheduler();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let entered: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    responders = [() => { entered(); return asBlocks(site("Pinecrest"), "Built."); }];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await original(input, init);
      if (String(input).endsWith("/chat/completions") && JSON.parse(String(init?.body)).stream) await gate;
      return response;
    }) as typeof fetch;
    const one = resume(id);
    await started;
    await expect(resume(id)).rejects.toMatchObject({ code: "ALREADY_RESUMING" });
    release();
    const finished = await one;
    expect(finished.run.status, fail(finished)).toBe("succeeded");
    expect(projectFiles(String(finished.projectId)).size).toBe(12);
    expect(docs("deployments/").filter(([, value]) => (value as { run_id?: string }).run_id === id)).toHaveLength(1);
  });
});

describe("J. recovery after a server restart", () => {
  it("a run cut off mid-repair is found by the recovery job and finished from the saved files; the job is safe to repeat", async () => {
    const files = site("Quarry").map((file) => file.path === "app.js" ? { ...file, content: "function boot( {\n" } : file);
    responders.push(() => asBlocks(files, "Built."));
    for (let i = 0; i < 4; i += 1) responders.push(() => asBlocks([{ path: "app.js", content: "function boot( {\n" }]));
    const id = runId("restart");
    const stopped = await run({ id, prompt: "Build a multi-page website for Quarry, a furniture workshop, with about, work and contact pages.", publish: true });
    expect(stopped.run.status).toBe("failed");
    const projectId = String(stopped.projectId);
    // Simulate the process dying mid-repair: the stored run still says "running" and stopped reporting 6 minutes ago.
    const stale = Date.now() - 6 * 60_000;
    const record = stub._state.docs.get(`build_runs/${id}`) as Record<string, unknown>;
    const interrupted = { ...stopped.run, status: "running" as const, error: null, continuation: null, finishedAt: null, updatedAt: stale, stages: stopped.run.stages.map((stage) => stage.id === "validate" ? { ...stage, state: "running" as const, startedAt: stale, finishedAt: null } : stage) };
    stub._state.docs.set(`build_runs/${id}`, { ...record, run: toFirestoreRun(interrupted), resumable: true, resume_claim: null });
    expect((record.resume as { phase: string }).phase).toBe("repair");

    responders = [() => asBlocks([{ path: "app.js", content: SCRIPT }])];
    const generationCalls = groq.filter((request) => request.text.includes("MATRIX build pipeline: emit complete")).length;
    const db = dbWithWrites();
    const recovered = await recoverInterruptedRuns(db, { providerFor: (owner) => new FirestoreDeploymentProvider(db, owner) });
    const mine = recovered.find((item) => item.runId === id);
    expect(mine?.status, JSON.stringify(recovered)).toBe("succeeded");
    const after = stub._state.docs.get(`build_runs/${id}`) as { run: { status: string; segment: number; deployment?: { status?: string } }; resumable: boolean };
    expect(after.run.status).toBe("succeeded");
    expect(after.run.segment).toBe(2);
    expect(after.resumable).toBe(false);
    expect(projectFiles(projectId).get("app.js")?.trim()).toBe(SCRIPT.trim());
    expect(groq.filter((request) => request.text.includes("MATRIX build pipeline: emit complete")).length).toBe(generationCalls);
    // Running the job again finds nothing to do for this run.
    const again = await recoverInterruptedRuns(db, { providerFor: (owner) => new FirestoreDeploymentProvider(db, owner) });
    expect(again.find((item) => item.runId === id)).toBeUndefined();
  });
});
