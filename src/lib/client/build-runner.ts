"use client";

// =============================================================================
// MATRIX build client (§2, §3, §4, §24)
//
// One code path for the UI: start a run, follow the real events, and fall back
// to polling the persisted run if the stream drops. The client never derives
// progress locally — it mirrors whatever the pipeline reported. If the stream
// goes silent, `applyStaleness` (the same rule the server uses) fails the run
// so "Publishing..." can never stay on screen forever.
// =============================================================================

import type { BuildStageId, BuildRun } from "@/lib/deploy/stages";
import { applyStaleness } from "@/lib/deploy/stages";
import { rpc } from "@/lib/client/api";

export type BuildStreamEvent = {
  type?: "accepted" | "run" | "done" | "error";
  stage?: BuildStageId;
  run?: BuildRun;
  code?: string;
  message?: string;
  run_id?: string;
  reply?: string;
  project_id?: string | null;
};

export type BuildDonePayload = { run: BuildRun | null; reply: string; projectId: string | null };

export type BuildStreamHandlers = {
  onRun?: (run: BuildRun, stage?: BuildStageId) => void;
  onError?: (code: string, message: string) => void;
  onDone?: (payload: BuildDonePayload) => void;
  signal?: AbortSignal;
};

export type BuildStartInput = {
  prompt: string;
  projectId?: string | null;
  conversationId?: string | null;
  actions?: { build?: boolean; publish?: boolean; preview?: boolean; fix?: boolean };
  slug?: string | null;
  /** Where the deployment goes — only environments the host reports as supported. */
  environment?: "preview" | "production";
  allowOverride?: boolean;
  imageRequests?: Array<{ name: string; prompt: string }>;
  maxFixAttempts?: number;
  requestId?: string;
};

const IDLE_TIMEOUT_MS = 90_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_LIMIT_MS = 15 * 60_000;

/**
 * POST /api/build with `Accept: text/event-stream`. Resolves with the final
 * run as reported by the server (or the last known state if it went silent).
 */
export async function streamBuildRun(
  input: BuildStartInput,
  handlers: BuildStreamHandlers = {},
): Promise<{ run: BuildRun | null; reply: string; projectId: string | null }> {
  let reply = "";
  const controller = new AbortController();
  const external = handlers.signal;
  if (external) external.addEventListener("abort", () => controller.abort(), { once: true });

  let last: BuildRun | null = null;
  let idle: ReturnType<typeof setTimeout> | null = null;
  const armIdle = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(() => {
      // The stream stalled: switch to polling the stored run, which keeps the
      // UI truthful without inventing progress.
      void pollBuildRun(last?.id ?? "", handlers).then((run) => {
        if (run) {
          last = run;
          handlers.onRun?.(run);
        }
      }).catch(() => {
        handlers.onError?.("BUILD_STREAM_INTERRUPTED", "MATRIX lost the live build feed. Refresh the project to see its real state.");
      });
      controller.abort();
    }, IDLE_TIMEOUT_MS);
  };

  armIdle();
  try {
    const res = await fetch("/api/build", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      credentials: "same-origin",
      signal: controller.signal,
      body: JSON.stringify({
        prompt: input.prompt,
        project_id: input.projectId ?? null,
        conversation_id: input.conversationId ?? null,
        actions: input.actions ?? null,
        slug: input.slug ?? null,
        environment: input.environment ?? "production",
        allow_override: input.allowOverride === true,
        image_requests: input.imageRequests ?? [],
        max_fix_attempts: input.maxFixAttempts ?? undefined,
        request_id: input.requestId ?? crypto.randomUUID(),
      }),
    });
    if (!res.ok || !res.body) {
      const data = (await res.json().catch(() => ({}))) as { error?: string };
      throw new BuildRunError(data.error ?? `BUILD_HTTP_${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      armIdle();
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.trim();
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === "[DONE]") continue;
        let event: BuildStreamEvent;
        try {
          event = JSON.parse(payload) as BuildStreamEvent;
        } catch {
          continue;
        }
        if (event.type === "error") {
          handlers.onError?.(event.code ?? "BUILD_RUN_FAILED", event.message ?? "The build stopped.");
          continue;
        }
        if (event.type === "done") {
          reply = event.reply ?? reply;
          if (event.run) last = event.run;
          handlers.onDone?.({ run: event.run ?? null, reply: event.reply ?? "", projectId: event.project_id ?? null });
          continue;
        }
        if (event.run) {
          last = event.run;
          handlers.onRun?.(event.run, event.stage);
        }
      }
    }
    if (buffer.trim().startsWith("data:")) {
      const payload = buffer.trim().slice(5).trim();
      if (payload && payload !== "[DONE]") {
        try {
          const event = JSON.parse(payload) as BuildStreamEvent;
          if (event.reply) reply = event.reply;
          if (event.run) {
            last = event.run;
            handlers.onRun?.(event.run, event.stage);
          }
        } catch {
          /* trailing partial event — the poll path will reconcile */
        }
      }
    }
  } catch (error) {
    if ((error as Error)?.name !== "AbortError") throw error;
  } finally {
    if (idle) clearTimeout(idle);
  }
  // Anything still "running" after the feed ended is judged by its timestamps.
  const run = last ? applyStaleness(last, Date.now()) : null;
  return { run, reply, projectId: run?.projectId ?? null };
}

/** Poll the persisted run (used after a reload or when the stream dropped). */
export async function pollBuildRun(runId: string, handlers: BuildStreamHandlers = {}): Promise<BuildRun | null> {
  if (!runId) return null;
  const deadline = Date.now() + POLL_LIMIT_MS;
  while (Date.now() < deadline) {
    const run = await readBuildRun(runId);
    if (!run) return null;
    handlers.onRun?.(run);
    if (run.status === "succeeded" || run.status === "failed") return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const final = await readBuildRun(runId);
  return final ? applyStaleness(final, Date.now()) : null;
}

export async function readBuildRun(runId: string): Promise<BuildRun | null> {
  const data = await rpc<{ run: BuildRun | null }>("build_run_get", { run_id: runId }).catch(() => null);
  return data?.run ?? null;
}

export async function readLatestBuildRun(projectId: string): Promise<BuildRun | null> {
  const data = await rpc<{ run: BuildRun | null }>("build_run_latest", { project_id: projectId }).catch(() => null);
  return data?.run ?? null;
}

export class BuildRunError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "BuildRunError";
  }
}
