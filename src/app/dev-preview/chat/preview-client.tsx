"use client";

// DEV-ONLY. Renders the real ChatClient against a mocked /api/ai transport so
// the context-aware UX can be reviewed without Firebase credentials:
//
//   • "hi"                      → clean chat, Copy / Regenerate / More only
//   • "…into a PDF"             → export lifecycle, nothing else
//   • "Create a CSV from …"     → tabular reply → CSV/XLSX export only
//   • "Generate an image …"     → Together AI image workflow
//   • "Inspect … run the tests" → Agent activity, collapsed when finished
//   • "Write a Python function" → code actions, no export clutter
//
// The mock chooses its reply with the SAME detectIntent() the UI uses, so the
// preview exercises the real intent → capability → contextual-UI path.
// Not reachable in production.

import { useCallback, useEffect, useState } from "react";
import { ChatClient } from "@/components/chat-client";
import { ToastProvider } from "@/components/toast";
import { detectIntent, selectCapability } from "@/lib/ai/intent";
import { AGENT_STAGES, computeAnalytics } from "@/lib/ai/pipeline";

const SCENARIOS: Array<{ id: string; label: string; prompt: string }> = [
  { id: "t1", label: "1 · hi", prompt: "hi" },
  { id: "t2", label: "2 · Explain photosynthesis", prompt: "Explain photosynthesis." },
  { id: "t3", label: "3 · Turn this into a PDF", prompt: "Turn this answer into a PDF." },
  { id: "t4", label: "4 · CSV from this table", prompt: "Create a CSV from this table of users." },
  { id: "t5", label: "5 · Generate an image", prompt: "Generate an image of a futuristic Matrix city." },
  { id: "t6", label: "6 · Inspect project + run tests", prompt: "Inspect this project, find the bug and run the tests." },
  { id: "t7", label: "7 · Write a Python function", prompt: "Write a Python function to sort a list." },
  { id: "t8", label: "8 · Make a report (ambiguous)", prompt: "Make a report about renewable energy." },
];

const PROSE = "Photosynthesis is how green plants turn light into chemical energy. Chlorophyll in the leaves absorbs sunlight, water is drawn up from the roots and carbon dioxide enters through tiny pores called stomata. The plant uses that light energy to build glucose and releases oxygen as a by-product — which is why forests and oceans are so important to the atmosphere.";

const TABLE_REPLY = [
  "Here is the sample user data as a table:",
  "",
  "| id | name | email | plan |",
  "| --- | --- | --- | --- |",
  "| 1 | Ada Lovelace | ada@example.com | pro |",
  "| 2 | Grace Hopper | grace@example.com | team |",
  "| 3 | Linus Torvalds | linus@example.com | free |",
  "| 4 | Alan Turing | alan@example.com | pro |",
  "",
  "Ask for a CSV or Excel file and Matrix will build it from these rows.",
].join("\n");

const CODE_REPLY = [
  "Here is a small, dependency-free sort helper:",
  "",
  "```python",
  "def sort_list(items, reverse=False):",
  '    """Return a new sorted list without mutating the input."""',
  "    return sorted(items, reverse=reverse)",
  "",
  "",
  'numbers = [5, 2, 9, 1, 5, 6]',
  "print(sort_list(numbers))        # [1, 2, 5, 5, 6, 9]",
  "print(sort_list(numbers, True))  # [9, 6, 5, 5, 2, 1]",
  "```",
  "",
  "`sorted()` is stable and runs in O(n log n). Pass a `key=` argument when sorting dictionaries or objects.",
].join("\n");

const REPORT_REPLY = [
  "# Renewable energy overview",
  "",
  "## 1. Where the grid stands",
  "Solar and wind are now the cheapest new sources of electricity in most of the world, and both grew faster than any other source over the last decade.",
  "",
  "## 2. Main challenges",
  "- Storage: supply is weather-dependent, so batteries and demand response matter.",
  "- Grids: transmission has not kept up with where the best resources are.",
  "- Materials: panels, turbines and batteries need copper, lithium and rare earths.",
  "",
  "## 3. What to watch",
  "Battery prices, permitting speed, and how quickly industrial heat can be electrified.",
].join("\n");

const JSON_REPLY = 'Here is the structured payload:\n\n```json\n{"users":[{"id":1,"name":"Ada Lovelace","plan":"pro"},{"id":2,"name":"Grace Hopper","plan":"team"}],"generated_at":"2026-01-01T00:00:00.000Z"}\n```';

const AGENT_REPLY = [
  "I inspected the project, found the root cause and ran the checks.",
  "",
  "**Root cause** — `src/lib/session.ts` returned a stale cookie because the cache was never invalidated after sign-out.",
  "",
  "<<<MATRIX_FILE path=\"src/lib/session.ts\">>>",
  "export function readSession(): Session | null {",
  "  const raw = cache.get('session');",
  "  if (!raw) return null;",
  "  return isExpired(raw) ? null : parse(raw);",
  "}",
  "<<<END_MATRIX_FILE>>>",
  "",
  "**Checks** — `npm run typecheck` passed, 34 tests passed, lint clean.",
].join("\n");

function previewImage(prompt: string): string {
  const safe = prompt.replace(/[<>&]/g, "").slice(0, 70);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="640" viewBox="0 0 1024 640">
<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
<stop offset="0%" stop-color="#0b1020"/><stop offset="55%" stop-color="#1b2a6b"/><stop offset="100%" stop-color="#00ffa3"/>
</linearGradient></defs>
<rect width="1024" height="640" fill="url(#g)"/>
<g fill="#0b1020" opacity="0.55">${Array.from({ length: 14 }, (_, i) => `<rect x="${40 + i * 70}" y="${260 + (i % 5) * 40}" width="46" height="${380 - (i % 5) * 40}"/>`).join("")}</g>
<text x="48" y="86" font-family="monospace" font-size="34" fill="#e6fff7">MATRIX dev preview</text>
<text x="48" y="126" font-family="monospace" font-size="20" fill="#9CA3AF">${safe}</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/** Reply text for a message, chosen with the real intent detector. */
function mockReply(message: string): string {
  const intent = detectIntent(message);
  if (intent.formats.includes("csv") || intent.formats.includes("xlsx") || /table|users/i.test(message)) return TABLE_REPLY;
  if (intent.formats.includes("json")) return JSON_REPLY;
  if (intent.intent === "AGENT_TASK") return AGENT_REPLY;
  if (intent.intent === "CODE") return CODE_REPLY;
  if (intent.needsFormatChoice) return REPORT_REPLY;
  if (/^hi$|^hello|^hey/i.test(message.trim())) return "Hello! How can I help you?";
  if (intent.formats.length) return "Sure — I'll prepare that file from the answer above.";
  if (/photosynthesis/i.test(message)) return PROSE;
  return `You asked: “${message.slice(0, 120)}”. In the real app this reply streams from the configured AI provider; this dev preview returns a canned answer so the contextual UI can be reviewed.`;
}

function sse(events: Array<Record<string, unknown>>, delayMs = 140): Response {
  const encoder = new TextEncoder();
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (cancelled) return;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
      controller.close();
    },
    cancel() {
      cancelled = true;
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "x-matrix-request-id": "dev-preview" },
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "x-matrix-request-id": "dev-preview" },
  });
}

/** Install a mock /api/ai transport (streaming chat, image, agent, scan). */
function useMockGateway() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const real = window.fetch.bind(window);

    window.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      if (!url.includes("/api/ai")) return real(input as RequestInfo, init);

      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      const message = typeof body.message === "string" ? body.message : "";
      const started = Date.now();
      const conversationId = "dev-preview-conversation";

      if (body.action === "health") return jsonResponse({ ok: true, provider: "preview" });
      if (body.action === "scan") {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return jsonResponse({ reply: "Preview scan: this is a screenshot of a dashboard with a table and two charts." });
      }

      if (body.action === "image") {
        await new Promise((resolve) => setTimeout(resolve, 1600));
        return jsonResponse({
          reply: "Image ready.",
          conversation_id: conversationId,
          mode: "image",
          image: { mime: "image/svg+xml", data_url: previewImage(message) },
          model: "preview-image-model",
          provider: "Together",
          image_status: "ready",
          analytics: computeAnalytics({ started, toolsExecuted: 1, agentSteps: 4 }),
        });
      }

      const reply = mockReply(message);
      const isAgent = body.mode === "agent";
      const words = reply.split(/(\s+)/);
      const events: Array<Record<string, unknown>> = [];
      if (isAgent) {
        AGENT_STAGES.forEach((stage, index) => {
          events.push({ stage: stage.id, label: stage.label });
          if (index === 2) events.push({ tool: "code.runtime" });
        });
      }
      // Stream in small chunks so the live UI is visible.
      for (let i = 0; i < words.length; i += 6) {
        events.push({ delta: words.slice(i, i + 6).join("") });
      }
      events.push({
        done: true,
        conversation_id: conversationId,
        model: "preview-model",
        provider: "preview",
        mode: body.mode,
        analytics: computeAnalytics({ started, promptTokens: 128, completionTokens: Math.max(24, Math.round(reply.length / 4)), agentSteps: isAgent ? AGENT_STAGES.length : 1, toolsExecuted: isAgent ? 1 : 0 }),
        ...(isAgent
          ? {
              files: [
                { path: "src/lib/session.ts", content: "export function readSession() { return null; }\n", language: "typescript" },
              ],
              project_id: "dev-preview-project",
            }
          : {}),
      });
      return sse(events, isAgent ? 220 : 45);
    }) as typeof window.fetch;

    setReady(true);
    return () => {
      window.fetch = real;
    };
  }, []);

  return ready;
}

export function ChatPreview() {
  const ready = useMockGateway();
  const [resetKey, setResetKey] = useState(0);

  const runScenario = useCallback((prompt: string) => {
    const area = document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message MATRIX"]');
    if (!area) return;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
    setter?.call(area, prompt);
    area.dispatchEvent(new Event("input", { bubbles: true }));
    window.setTimeout(() => {
      area.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }, 40);
  }, []);

  if (!ready) return null;

  return (
    <ToastProvider>
      <div className="flex min-h-screen flex-col bg-bg px-3 py-4 sm:px-6">
        <div className="mx-auto w-full max-w-4xl space-y-3">
          <div className="rounded-xl border border-warning/40 bg-warning-soft px-4 py-2 text-[12px] text-warning">
            Development preview — the real chat components against a mock gateway. Replies are canned; every panel you
            see is produced by the real intent/artifact logic. Not available in production.
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <span className="eyebrow mr-1">Spec test cases</span>
            {SCENARIOS.map((scenario) => (
              <button
                key={scenario.id}
                type="button"
                onClick={() => runScenario(scenario.prompt)}
                className="chip inline-flex min-h-8 items-center rounded-lg border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:bg-accent-soft hover:text-accent"
              >
                {scenario.label}
              </button>
            ))}
            <button
              type="button"
              onClick={() => setResetKey((key) => key + 1)}
              className="chip inline-flex min-h-8 items-center rounded-lg border border-border bg-surface px-2.5 text-[11.5px] font-medium text-ink-2 transition-colors hover:border-accent/40 hover:text-accent"
            >
              Reset conversation
            </button>
          </div>

          <div className="flex h-[calc(100dvh-190px)] min-h-[420px] w-full flex-col rounded-2xl border border-border bg-bg p-3 sm:p-4">
            <ChatClient key={resetKey} initialMessages={[]} conversationId={null} isTemporary={false} initialMode="general" />
          </div>
        </div>
      </div>
    </ToastProvider>
  );
}
