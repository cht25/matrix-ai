// Execution environment lifecycle.
//
// Every execution session of a build run works in an isolated, temporary
// environment and follows one lifecycle:
//
//   acquire → load project files → work → persist to project storage →
//   VERIFY what was saved → terminate → delete temporary data
//
// The environment is reached through the `ExecutionGateway` interface below.
// MATRIX ships one implementation, `matrix-inline`: the session's workspace is
// held in the memory of the request that runs it and nothing is executed
// outside the validators/bundler. An external sandbox service plugs in by
// implementing the same interface; MATRIX does not assume any endpoint of a
// service it has not been given.
//
// Rules enforced here, whatever the gateway:
//   • temporary data is released only AFTER persistence was verified — or when
//     the session is abandoned, in which case nothing in it was the only copy
//     of anything (accepted work is written to project storage as it happens);
//   • cleanup never touches project files, versions or published releases — it
//     only knows the session's own id;
//   • cleanup is idempotent: running it twice, or concurrently, is harmless.
import "server-only";
import { createHash } from "node:crypto";
import type { Db } from "@/lib/firebase/admin";
import { nowTs } from "@/lib/firebase/admin";
import type { ProjectFile } from "@/lib/projects/paths";

export type ExecutionSessionStatus = "active" | "persisted" | "terminated" | "abandoned";

export interface ExecutionGateway {
  readonly name: string;
  /** Create or acquire an isolated environment. Returns its handle. */
  acquire(input: { sessionId: string; projectId: string | null }): Promise<{ handle: string }>;
  /** Stop the environment and delete its temporary files and caches. Must be idempotent. */
  release(handle: string): Promise<void>;
}

/** In-process environment: the workspace lives in the running request's memory. */
class InlineGateway implements ExecutionGateway {
  readonly name = "matrix-inline";
  private live = new Set<string>();
  async acquire(input: { sessionId: string }): Promise<{ handle: string }> {
    this.live.add(input.sessionId);
    return { handle: input.sessionId };
  }
  async release(handle: string): Promise<void> {
    this.live.delete(handle);
  }
  /** Handles still held by this process (tests / diagnostics). */
  held(): string[] { return [...this.live]; }
}

const inline = new InlineGateway();
let active: ExecutionGateway = inline;

export function executionGateway(): ExecutionGateway { return active; }
export function inlineGatewayHandles(): string[] { return inline.held(); }
/** Tests (and a future external integration) swap the gateway here. */
export function setExecutionGateway(gateway: ExecutionGateway | null): void { active = gateway ?? inline; }

const COLLECTION = "execution_sessions";
/** A session silent for this long is abandoned (the longest request is 300 s). */
export const SESSION_ABANDON_MS = 10 * 60_000;
/** Closed session records are kept this long for diagnostics. */
export const SESSION_RETENTION_MS = 7 * 24 * 3_600_000;

export function sessionIdFor(runId: string, segment: number): string {
  return `${runId}-s${segment}`;
}

export function filesDigest(files: Array<Pick<ProjectFile, "path" | "content">>): string {
  const hash = createHash("sha256");
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(file.path).update("\0").update(createHash("sha256").update(file.content ?? "").digest("hex")).update("\n");
  }
  return hash.digest("hex").slice(0, 32);
}

export type ExecutionSession = { id: string; handle: string; gateway: string };

/** Acquire an environment for one execution session of a run and record the mapping. */
export async function openExecutionSession(d: Db, input: { runId: string; segment: number; ownerId: string; projectId: string | null; conversationId: string | null }): Promise<ExecutionSession> {
  const id = sessionIdFor(input.runId, input.segment);
  const gateway = executionGateway();
  const { handle } = await gateway.acquire({ sessionId: id, projectId: input.projectId });
  await d.collection(COLLECTION).doc(id).set({
    run_id: input.runId, segment: input.segment, owner_id: input.ownerId, project_id: input.projectId, conversation_id: input.conversationId,
    gateway: gateway.name, handle, status: "active" satisfies ExecutionSessionStatus,
    started_at: nowTs(), heartbeat_at: Date.now(), persisted_digest: null, verified: false, ended_at: null, cleanup: null,
  }, { merge: true });
  return { id, handle, gateway: gateway.name };
}

export async function heartbeatExecutionSession(d: Db, session: ExecutionSession, projectId?: string | null): Promise<void> {
  await d.collection(COLLECTION).doc(session.id).set({ heartbeat_at: Date.now(), ...(projectId ? { project_id: projectId } : {}) }, { merge: true }).catch(() => undefined);
}

export type CloseResult = { verified: boolean; released: boolean; detail: string };

/**
 * End a session. `working` is the file set the session believes it produced;
 * `stored` is what project storage returns now. The environment is released
 * when the two match (or when the session produced nothing to save). On a
 * mismatch the session is still released — the inline workspace cannot be kept
 * past the request — but the record says persistence was NOT verified, with
 * the differing paths, so the caller must not report success.
 */
export async function closeExecutionSession(d: Db, session: ExecutionSession, input: { working: ProjectFile[] | null; stored: ProjectFile[] | null; outcome: string }): Promise<CloseResult> {
  let verified = true;
  let detail = "No files were produced in this session.";
  let digest: string | null = null;
  if (input.working && input.stored) {
    digest = filesDigest(input.stored);
    verified = filesDigest(input.working) === digest;
    if (verified) {
      detail = `${input.stored.length} file${input.stored.length === 1 ? "" : "s"} verified in project storage.`;
    } else {
      const stored = new Map(input.stored.map((file) => [file.path, file.content]));
      const differing = input.working.filter((file) => stored.get(file.path) !== file.content).map((file) => file.path);
      const missing = input.stored.filter((file) => !input.working?.some((item) => item.path === file.path)).map((file) => file.path);
      detail = `Storage differs from the session workspace: ${[...differing, ...missing].slice(0, 6).join(", ") || "file set mismatch"}.`;
    }
  }
  const ref = d.collection(COLLECTION).doc(session.id);
  await ref.set({ status: "persisted" satisfies ExecutionSessionStatus, persisted_digest: digest, verified, verify_detail: detail, outcome: input.outcome.slice(0, 60), heartbeat_at: Date.now() }, { merge: true }).catch(() => undefined);
  let released = false;
  try {
    await executionGateway().release(session.handle);
    released = true;
    await ref.set({ status: "terminated" satisfies ExecutionSessionStatus, ended_at: nowTs(), cleanup: { at: Date.now(), by: "session", released: true } }, { merge: true }).catch(() => undefined);
  } catch (error) {
    // Left as "persisted": the cleanup job retries the release.
    await ref.set({ cleanup: { at: Date.now(), by: "session", released: false, error: error instanceof Error ? error.message.slice(0, 200) : "release failed" } }, { merge: true }).catch(() => undefined);
  }
  return { verified, released, detail };
}

export type CleanupReport = { scanned: number; released: number; abandoned: number; purged: number; errors: number };

/**
 * Scheduled cleanup. Releases environments whose session ended without
 * releasing them and those abandoned by a crashed or timed-out request, then
 * purges old closed records. Only `execution_sessions` documents and gateway
 * handles are touched. Safe to run repeatedly and concurrently.
 */
export async function cleanupExecutionSessions(d: Db, now = Date.now()): Promise<CleanupReport> {
  const report: CleanupReport = { scanned: 0, released: 0, abandoned: 0, purged: 0, errors: 0 };
  const snap = await d.collection(COLLECTION).get();
  for (const doc of snap.docs) {
    report.scanned += 1;
    const data = doc.data() as { status?: ExecutionSessionStatus; heartbeat_at?: number; handle?: string; cleanup?: { at?: number } | null };
    const status = data.status ?? "active";
    const heartbeat = Number(data.heartbeat_at ?? 0);
    try {
      if (status === "terminated" || status === "abandoned") {
        if (now - Number(data.cleanup?.at ?? heartbeat) > SESSION_RETENTION_MS) {
          await doc.ref.delete();
          report.purged += 1;
        }
        continue;
      }
      const silent = now - heartbeat > SESSION_ABANDON_MS;
      if (status === "active" && !silent) continue; // still working
      // "persisted" (release failed earlier) or silent "active" (abandoned).
      await executionGateway().release(String(data.handle ?? doc.id));
      await doc.ref.set({ status: (status === "active" ? "abandoned" : "terminated") satisfies ExecutionSessionStatus, ended_at: nowTs(), cleanup: { at: now, by: "job", released: true } }, { merge: true });
      if (status === "active") report.abandoned += 1; else report.released += 1;
    } catch {
      report.errors += 1;
    }
  }
  return report;
}
