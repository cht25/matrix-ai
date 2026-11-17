// =============================================================================
// "Generating files · 1/6 steps · Files: 0 · Build: Running" forever
//
// The reported symptom is a run whose worker is gone but whose stored state
// still says "running". These tests pin down every layer that must agree:
//
//   • the stage machine knows when a worker has gone silent (lease/heartbeat);
//   • the server stores that verdict instead of computing it per reader, so a
//     reload, another tab and the dashboard all stop saying "Running";
//   • a pipeline that throws closes its run instead of leaving it alive;
//   • the client follows the stored run to a terminal state after a stream
//     ends, instead of freezing its last snapshot.
// =============================================================================

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyStaleness,
  beginStage,
  completeStage,
  createBuildRun,
  failStage,
  runLiveness,
  stageDef,
  type BuildRun,
} from "@/lib/deploy/stages";
import { runFromFirestore, toFirestoreRun } from "@/lib/deploy/run-store";
import { makeFakeFirestore } from "./helpers/test-db";

vi.mock("@/lib/firebase/admin", () => ({
  nowTs: () => new Date(),
  adminDb: () => {
    throw new Error("adminDb must not be touched by these tests");
  },
  adminAuth: () => {
    throw new Error("adminAuth must not be touched by these tests");
  },
  adminConfigured: () => true,
}));

import { closeBuildRun, readBuildRun } from "@/lib/server/build";
import type { Db } from "@/lib/firebase/admin";

const T0 = 1_700_000_000_000;

function midBuild(now = T0): BuildRun {
  let run = createBuildRun({
    id: "run-stuck",
    projectId: "proj-1",
    conversationId: "conv-1",
    actions: { build: true, publish: true, preview: false },
    now,
  });
  run = completeStage(run, "plan", now + 1_000, "Project ready");
  run = beginStage(run, "generate", now + 2_000, "Agent is writing the project files.");
  return { ...run, updatedAt: now + 2_000, heartbeatAt: now + 2_000 };
}

function nested(run: BuildRun): BuildRun {
  // Round-trip through the Firestore shape, exactly as a reader would see it.
  const parsed = runFromFirestore(toFirestoreRun(run), T0);
  expect(parsed).not.toBeNull();
  return parsed as BuildRun;
}

describe("run liveness (lease + heartbeat)", () => {
  it("stays alive inside the stage's own budget", () => {
    const run = nested(midBuild());
    const liveness = runLiveness(run, T0 + 30_000);
    expect(liveness.inFlight).toBe(true);
    expect(liveness.stageId).toBe("generate");
    expect(liveness.limitMs).toBe(stageDef("generate").timeoutMs);
    // The stage began 2 s after the run and nothing has been heard since.
    expect(liveness.silentMs).toBe(28_000);
    expect(liveness.stale).toBe(false);
  });

  it("reports a worker that stopped reporting as stale", () => {
    const run = nested(midBuild());
    const liveness = runLiveness(run, T0 + stageDef("generate").timeoutMs + 5_000);
    expect(liveness.stale).toBe(true);
    // The stage really has been silent for that long.
    expect(liveness.silentMs).toBeGreaterThanOrEqual(stageDef("generate").timeoutMs);
  });

  it("a later heartbeat revives the lease (a live worker is never called dead)", () => {
    const run = { ...nested(midBuild()), heartbeatAt: T0 + 200_000, updatedAt: T0 + 200_000 };
    expect(runLiveness(run, T0 + 210_000).stale).toBe(false);
    expect(applyStaleness(run, T0 + 210_000).status).toBe("running");
  });

  it("every finished state is not 'in flight'", () => {
    const failed = applyStaleness(nested(midBuild()), T0 + 400_000);
    expect(failed.status).toBe("failed");
    expect(runLiveness(failed, T0 + 900_000).inFlight).toBe(false);
  });
});

describe("applyStaleness — honest failure copy", () => {
  it("says how long the worker was silent and keeps the saved work resumable", () => {
    const failed = applyStaleness(nested(midBuild()), T0 + stageDef("generate").timeoutMs + 5_000);
    expect(failed.status).toBe("failed");
    expect(failed.error?.code).toBe("BUILD_RUN_STALE");
    expect(failed.error?.message).toMatch(/stopped reporting/i);
    expect(failed.error?.message).toMatch(/Generating files/);
    expect(failed.error?.message).toMatch(/saved so far are in the project/i);
    expect(failed.continuation).toMatchObject({ available: true, reason: "interrupted" });
    // The stage that was running is the one reported as failed.
    expect(failed.stages.find((stage) => stage.id === "generate")?.state).toBe("failed");
  });

  it("never rewrites a terminal run", () => {
    const done = { ...nested(midBuild()), status: "succeeded" as const };
    expect(applyStaleness(done, T0 + 900_000)).toBe(done);
  });
});

describe("the stored run is reconciled, so every reader agrees", () => {
  function seeded(): { db: Db; stored: BuildRun } {
    const fake = makeFakeFirestore();
    const run = nested(midBuild());
    void fake.collection("build_runs").doc(run.id).set({ owner_id: "user-1", run: toFirestoreRun(run), resumable: true, updated_at: new Date() });
    return { db: fake as unknown as Db, stored: run };
  }

  it("readBuildRun writes the stale verdict back to Firestore", async () => {
    const { db } = seeded();
    const user = { uid: "user-1", email: null, emailVerified: true };
    const late = T0 + stageDef("generate").timeoutMs + 10_000;

    const first = await readBuildRun(db, user, "run-stuck", late);
    expect(first?.status).toBe("failed");
    expect(first?.error?.code).toBe("BUILD_RUN_STALE");

    // The verdict is in the document now, not only in this response: a second
    // reader with NO clock advance of its own still sees a failed run.
    const doc = await db.collection("build_runs").doc("run-stuck").get();
    const persisted = runFromFirestore(doc.data()?.run, late + 1);
    expect(persisted?.status).toBe("failed");
    expect(persisted?.error?.code).toBe("BUILD_RUN_STALE");
    expect(persisted?.continuation?.available).toBe(true);
    // And the run is no longer advertised as resumable-but-running.
    expect((doc.data() as { resumable?: boolean }).resumable).toBe(false);
  });

  it("a healthy run is left exactly as it was", async () => {
    const { db, stored } = seeded();
    const user = { uid: "user-1", email: null, emailVerified: true };
    const read = await readBuildRun(db, user, stored.id, T0 + 5_000);
    expect(read?.status).toBe("running");
    const doc = await db.collection("build_runs").doc(stored.id).get();
    expect((doc.data() as { resumable?: boolean }).resumable).toBe(true);
  });

  it("refuses to hand a run to a different owner", async () => {
    const { db } = seeded();
    const other = { uid: "user-2", email: null, emailVerified: true };
    expect(await readBuildRun(db, other, "run-stuck", T0 + 5_000)).toBeNull();
  });
});

describe("a pipeline that throws closes its run", () => {
  function seededRunning(): Db {
    const fake = makeFakeFirestore();
    const run = nested(midBuild());
    void fake.collection("build_runs").doc(run.id).set({ owner_id: "user-1", run: toFirestoreRun(run), resumable: true });
    return fake as unknown as Db;
  }

  it("closeBuildRun turns 'running' into a real failure and keeps the files", async () => {
    const db = seededRunning();
    const closed = await closeBuildRun(db, "run-stuck", { code: "BUILD_RUN_FAILED", message: "The worker exited." });
    expect(closed?.status).toBe("failed");
    expect(closed?.error).toMatchObject({ code: "BUILD_RUN_FAILED" });
    expect(closed?.stages.find((stage) => stage.id === "generate")?.state).toBe("failed");
    expect(closed?.continuation?.available).toBe(true);
    expect(closed?.finishedAt).toBeTypeOf("number");

    const doc = await db.collection("build_runs").doc("run-stuck").get();
    expect(runFromFirestore(doc.data()?.run, Date.now())?.status).toBe("failed");
  });

  it("is idempotent and never overwrites a finished run", async () => {
    const db = seededRunning();
    await closeBuildRun(db, "run-stuck", { code: "BUILD_RUN_FAILED", message: "first" });
    const second = await closeBuildRun(db, "run-stuck", { code: "BUILD_RUN_FAILED", message: "second" });
    expect(second?.error?.message).toBe("first");
  });

  it("does nothing for a run that does not exist", async () => {
    const db = seededRunning();
    expect(await closeBuildRun(db, "missing-run", { code: "X", message: "y" })).toBeNull();
  });
});

describe("the client follows a run to its terminal state", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("keeps polling after the stream ended while the run was still running", async () => {
    vi.doMock("@/lib/client/api", () => ({
      optionalAuthHeaders: async () => ({}),
      rpc: async () => ({
        run: {
          ...nested(midBuild()),
          status: "failed",
          error: { code: "BUILD_RUN_STALE", message: "The build worker stopped reporting." },
        },
      }),
    }));
    const { pollBuildRun } = await import("@/lib/client/build-runner");
    const seen: string[] = [];
    const run = await pollBuildRun("run-stuck", { onRun: (next) => seen.push(next.status) });
    expect(run?.status).toBe("failed");
    expect(seen).toContain("failed");
    vi.doUnmock("@/lib/client/api");
  });
});

describe("a failed stage is never promoted by a later event", () => {
  it("completeStage cannot resurrect a failed stage", () => {
    const failed = failStage(midBuild(), "generate", T0 + 3_000, "interrupted");
    const after = completeStage(failed, "generate", T0 + 4_000, "done");
    expect(after.stages.find((stage) => stage.id === "generate")?.state).toBe("failed");
  });
});
