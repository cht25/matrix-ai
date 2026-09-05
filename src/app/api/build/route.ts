// =============================================================================
// MATRIX build endpoint (§1, §3, §4, §14–§16, §24)
//
//   POST /api/build           start a real build run, stream its progress (SSE)
//   GET  /api/build?run_id=   poll the persisted run state (never synthesised)
//   GET  /api/build?project_id=  the latest run for a project
//
// The pipeline in `src/lib/server/build.ts` does the work; this route only
// authenticates, forwards real events and mirrors them into Firestore so a
// reload, the project dashboard and the chat card all read the same state.
// =============================================================================

import { NextRequest, NextResponse } from "next/server";
import { adminAuth, adminDb, nowTs } from "@/lib/firebase/admin";
import { verifySession, type SessionUser } from "@/lib/firebase/session";
import { FirestoreDeploymentProvider } from "@/lib/deploy/firestore-provider";
import { runBuildPipeline, latestBuildRunForProject, readBuildRun, type ImageAssetRequest } from "@/lib/server/build";
import { getDeploymentOverview } from "@/lib/server/deploy";
import { detectBuildIntent } from "@/lib/ai/build-intent";
import { RpcError } from "@/lib/server/errors";
import type { BuildActions } from "@/lib/deploy/stages";
import { logGatewayFailure } from "@/lib/ai/provider-error";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const MAX_CONCURRENT_RUNS = 2;
const encoder = new TextEncoder();

/** Same auth contract as /api/ai: session cookie, or a Firebase ID token. */
async function getUser(req: NextRequest): Promise<SessionUser | null> {
  const bearer = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (bearer && bearer.split(".").length === 3) {
    try {
      const decoded = await adminAuth().verifyIdToken(bearer, true);
      return { uid: decoded.uid, email: decoded.email ?? null, emailVerified: decoded.email_verified ?? false };
    } catch {
      return null;
    }
  }
  const cookie = req.cookies.get("__session")?.value;
  if (!cookie) return null;
  try {
    return await verifySession(cookie);
  } catch {
    return null;
  }
}

function providerFor(d: ReturnType<typeof adminDb>, user: SessionUser) {
  return new FirestoreDeploymentProvider(d, user);
}

function json(data: unknown, status = 200, headers?: Record<string, string>) {
  return NextResponse.json(data, { status, headers });
}

function errorStatus(code: string): number {
  if (code === "UNAUTHENTICATED") return 401;
  if (code === "NOT_FOUND") return 404;
  if (code === "BUILD_RATE_LIMITED" || code === "PUBLISH_RATE_LIMITED") return 429;
  if (code === "AI_NOT_CONFIGURED" || code === "HOSTING_NOT_CONFIGURED") return 503;
  if (code === "BUILD_FAILED" || code === "AI_NO_FILES") return 422;
  return 400;
}

/** Concurrency guard so one user cannot start a fleet of builds. */
async function assertCapacity(userId: string): Promise<void> {
  const d = adminDb();
  const snap = await d.collection("build_runs").where("owner_id", "==", userId).get();
  const fiveMinutesAgo = Date.now() - 300_000;
  const active = snap.docs.filter((doc) => {
    const run = doc.data().run as { status?: string; updatedAt?: number } | undefined;
    if (!run) return false;
    if (run.status !== "running" && run.status !== "requested") return false;
    return Number(run.updatedAt ?? 0) >= fiveMinutesAgo;
  });
  if (active.length >= MAX_CONCURRENT_RUNS) throw new RpcError("BUILD_RATE_LIMITED", 429);
}

function parseActions(body: Record<string, unknown>, prompt: string): BuildActions {
  const raw = (body.actions ?? {}) as Record<string, unknown>;
  const intent = detectBuildIntent(prompt, { agentMode: true });
  return {
    build: typeof raw.build === "boolean" ? raw.build : true,
    publish: typeof raw.publish === "boolean" ? raw.publish : intent.publish,
    preview: typeof raw.preview === "boolean" ? raw.preview : !raw.publish,
  };
}

/** Attached text/code files, bounded and shape-checked (never trusted). */
function parseAttachments(body: Record<string, unknown>): Array<{ path: string; content: string }> {
  const raw = Array.isArray(body.attachments) ? body.attachments : [];
  const out: Array<{ path: string; content: string }> = [];
  for (const entry of raw.slice(0, 8)) {
    if (!entry || typeof entry !== "object") continue;
    const item = entry as Record<string, unknown>;
    const path = typeof item.name === "string" ? item.name.trim().slice(0, 200) : "";
    const content = typeof item.content === "string" ? item.content.slice(0, 100_000) : "";
    if (!path || !content) continue;
    out.push({ path, content });
  }
  return out;
}

function parseImageRequests(body: Record<string, unknown>): ImageAssetRequest[] {
  const raw = Array.isArray(body.image_requests) ? body.image_requests : [];
  return raw
    .slice(0, 4)
    .map((item) => {
      const entry = (item ?? {}) as Record<string, unknown>;
      const prompt = typeof entry.prompt === "string" ? entry.prompt.trim() : "";
      const name = typeof entry.name === "string" ? entry.name.trim() : "";
      return { name: (name || "hero").slice(0, 40), prompt: prompt.slice(0, 900) };
    })
    .filter((entry) => entry.prompt.length > 8);
}

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "BAD_REQUEST" }, 400);
  }
  const requestId = typeof body.request_id === "string" ? body.request_id.slice(0, 100) : crypto.randomUUID();
  const prompt = typeof body.prompt === "string" ? body.prompt.slice(0, 12_000) : "";
  const projectId = typeof body.project_id === "string" ? body.project_id : null;
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;

  const user = await getUser(req);
  if (!user) return json({ error: "UNAUTHENTICATED" }, 401);

  try {
    await assertCapacity(user.uid);
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "INTERNAL";
    return json({ error: code }, errorStatus(code));
  }

  const actions = parseActions(body, prompt);
  // Only environments the hosting provider reports as supported can be asked
  // for; anything else falls back to the default rather than silently failing.
  const environment: "preview" | "production" = body.environment === "preview" ? "preview" : "production";
  if (!actions.build && !actions.publish && !actions.preview && !projectId) {
    return json({ error: "NO_BUILD_REQUESTED", run: null }, 400);
  }

  const d = adminDb();
  const runId = crypto.randomUUID().replace(/-/g, "").slice(0, 24);
  const wantsStream = (req.headers.get("accept") ?? "").includes("text/event-stream");
  const isTemporary = body.is_temporary === true;

  // A build run belongs to a conversation exactly like a chat turn: reuse the
  // caller's thread (only if it is theirs) or open one, and store the request
  // so a reload shows the same history. Temporary chats stay in memory.
  let convId = conversationId;
  if (!isTemporary && prompt) {
    try {
      if (convId) {
        const existing = await d.collection("conversations").doc(convId).get();
        if (!existing.exists || (existing.data() as { user_id?: string } | undefined)?.user_id !== user.uid) convId = null;
      }
      if (!convId) {
        const created = await d.collection("conversations").add({
          user_id: user.uid,
          title: prompt.replace(/\s+/g, " ").slice(0, 60),
          mode: "agent",
          is_temporary: false,
          summary: "",
          archived_at: null,
          deleted_at: null,
          created_at: nowTs(),
          updated_at: nowTs(),
        });
        convId = created.id;
      }
      await d
        .collection("conversations")
        .doc(convId)
        .collection("messages")
        .add({ role: "user", content: prompt.slice(0, 12_000), metadata: { mode: "agent", intent: "BUILD" }, created_at: nowTs() });
    } catch (error) {
      // Storage trouble must not stop a build; the run document is the source
      // of truth and the chat still shows the turn in memory.
      logGatewayFailure("build_conversation", { requestId, userId: user.uid }, error);
    }
  }

  if (!wantsStream) {
    // Fire-and-check: the caller polls GET /api/build?run_id=… for real state.
    void runBuildPipeline({
      d,
      user,
      provider: providerFor(d, user),
      runId,
      projectId,
      conversationId: convId,
      requestId,
      prompt,
      actions,
      environment,
      slug: typeof body.slug === "string" ? body.slug : null,
      allowOverride: body.allow_override === true,
      imageRequests: parseImageRequests(body),
      attachments: parseAttachments(body),
      isTemporary,
      maxFixAttempts: typeof body.max_fix_attempts === "number" ? Math.max(0, Math.min(5, body.max_fix_attempts)) : undefined,
    }).catch((error) => logGatewayFailure("build_run", { requestId, runId }, error));
    return json({ run_id: runId, conversation_id: convId, status: "queued" }, 202);
  }

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let closed = false;
      const send = (payload: Record<string, unknown>) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          // The browser went away. The run keeps going and persists to
          // Firestore, so the UI can pick the real state up on the next poll.
          closed = true;
        }
      };
      send({ type: "accepted", run_id: runId, request_id: requestId, conversation_id: convId });
      try {
        const result = await runBuildPipeline({
          d,
          user,
          provider: providerFor(d, user),
          runId,
          projectId,
          conversationId: convId,
          requestId,
          prompt,
          actions,
          environment,
          slug: typeof body.slug === "string" ? body.slug : null,
          allowOverride: body.allow_override === true,
          imageRequests: parseImageRequests(body),
          attachments: parseAttachments(body),
          isTemporary,
          maxFixAttempts: typeof body.max_fix_attempts === "number" ? Math.max(0, Math.min(5, body.max_fix_attempts)) : undefined,
          onEvent: ({ run, stage, copy }) => send({ type: "run", stage, run, copy }),
        });
        // The final frame carries the summary sentence and the real
        // deployment, so the chat can commit its turn without a second read.
        send({
          type: "done",
          run: result.run,
          reply: result.reply,
          project_id: result.projectId,
          conversation_id: convId,
          deployment: result.run.deployment
            ? { id: result.run.deployment.id, status: result.run.deployment.status, url: result.run.deployment.url }
            : null,
        });
      } catch (error) {
        const code = error instanceof RpcError ? error.code : "BUILD_RUN_FAILED";
        send({ type: "error", code, message: error instanceof Error ? error.message.slice(0, 240) : "The build stopped." });
      } finally {
        try {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch {
          /* already closed */
        }
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-MATRIX-Request-ID": requestId,
    },
  });
}

export async function GET(req: NextRequest) {
  const user = await getUser(req);
  if (!user) return json({ error: "UNAUTHENTICATED" }, 401);
  const params = req.nextUrl.searchParams;
  const runId = params.get("run_id");
  const projectId = params.get("project_id");
  const d = adminDb();
  const now = Date.now();
  try {
    if (runId) {
      const run = await readBuildRun(d, user, runId, now);
      if (!run) return json({ error: "NOT_FOUND", run: null }, 404);
      return json({ run, deployment: run.projectId ? await getDeploymentOverview(d, user, run.projectId).catch(() => null) : null });
    }
    if (projectId) {
      const run = await latestBuildRunForProject(d, user, projectId, now);
      return json({ run: run ?? null, deployment: await getDeploymentOverview(d, user, projectId) });
    }
    return json({ error: "BAD_REQUEST" }, 400);
  } catch (error) {
    const code = error instanceof RpcError ? error.code : "INTERNAL";
    return json({ error: code }, errorStatus(code));
  }
}
