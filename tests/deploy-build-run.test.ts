// =============================================================================
// Build run persistence + progress (§3, §4, §16, §39)
//
// The stored run document is the only thing a reload can trust, so the
// roundtrip has to keep every state that the UI paints — and the stale-run
// guard is what stops "Publishing…" from ever living forever.
// =============================================================================

import { describe, expect, it } from "vitest";
import {
  BUILD_STAGES,
  MAX_LOG_LINES,
  applyStaleness,
  beginStage,
  bumpAttempt,
  buildRunCopy,
  changeCounts,
  completeStage,
  createBuildRun,
  failRun,
  failStage,
  log,
  runFromSnapshot,
  setDeployment,
  stageProgress,
  succeedRun,
  summarizeChanges,
  toRunSnapshot,
} from "@/lib/deploy/stages";
import { STORED_LOG_LIMIT, runFromFirestore, storedDeploymentStatus, toFirestoreRun } from "@/lib/deploy/run-store";

const T0 = 1_700_000_000_000;

function started() {
  return createBuildRun({ id: "run1", projectId: "p1", conversationId: "c1", requestId: "r1", actions: { build: true, publish: true, preview: false, fix: true }, environment: "production", now: T0 });
}

describe("stage progress", () => {
  it("counts completed stages and names the active one", () => {
    let run = started();
    run = completeStage(run, "plan", T0 + 1000, "Planned");
    run = beginStage(run, "generate", T0 + 2000);
    const progress = stageProgress(run);
    expect(progress.total).toBe(BUILD_STAGES.length);
    expect(progress.completed).toBe(1);
    expect(progress.activeId).toBe("generate");
    expect(progress.percent).toBe(Math.round((1 / BUILD_STAGES.length) * 100));
    expect(progress.failedId).toBeNull();
  });

  it("keeps a failed stage visible in the progress", () => {
    let run = started();
    run = failStage(run, "publish", T0 + 500, "Hosting refused");
    expect(stageProgress(run).failedId).toBe("publish");
  });
});

describe("buildRunCopy — the status line the user actually reads", () => {
  it("shows step counts while building", () => {
    let run = started();
    run = completeStage(run, "plan", T0 + 1, "Planned");
    run = beginStage(run, "generate", T0 + 2);
    const copy = buildRunCopy(run);
    expect(copy.title).toBe("Building project");
    expect(copy.detail).toContain(`1 / ${BUILD_STAGES.length} steps`);
    expect(copy.canOpenLive).toBe(false);
  });

  it("says Publishing… only while the deployment is genuinely uploading", () => {
    let run = started();
    run = setDeployment(run, { id: "d1", status: "deploying", url: null, slug: "my-site", environment: "production", rollbackAvailable: false, overridden: false, error: null }, T0 + 3);
    expect(buildRunCopy(run).title).toMatch(/Publishing/);
  });

  it("refuses to claim a live URL the provider did not return", () => {
    let run = started();
    run = BUILD_STAGES.reduce((acc, stage) => completeStage(acc, stage.id, T0 + 10, "ok"), run);
    const copy = buildRunCopy(run);
    expect(copy.canOpenLive).toBe(false);
    expect(copy.liveUrl).toBeNull();
  });

  it("reports success only with a live deployment", () => {
    let run = started();
    run = BUILD_STAGES.reduce((acc, stage) => completeStage(acc, stage.id, T0 + 10, "ok"), run);
    run = setDeployment(run, { id: "d1", status: "live", url: "https://matrix.app/s/my-site", slug: "my-site", environment: "production", rollbackAvailable: true, overridden: false, error: null }, T0 + 15);
    run = succeedRun(run, T0 + 20);
    const copy = buildRunCopy(run);
    expect(copy.title).toMatch(/Published successfully/);
    expect(copy.glyph).toBe("✓");
    expect(copy.canOpenLive).toBe(true);
  });

  it("names publishing failures differently from build failures", () => {
    let run = started();
    run = failRun(run, { code: "SLUG_TAKEN", message: "Address already in use." }, T0 + 5);
    expect(buildRunCopy(run).title).toBe("Build failed");
    run = setDeployment(run, { id: "d1", status: "failed", url: null, slug: null, environment: "production", rollbackAvailable: false, overridden: false, error: "boom" }, T0 + 6);
    expect(buildRunCopy(run).title).toBe("Publishing failed");
  });
});

describe("succeedRun gating", () => {
  it("will not mark a publish run successful without a live deployment", () => {
    let run = started();
    run = BUILD_STAGES.reduce((acc, stage) => completeStage(acc, stage.id, T0 + 1, "ok"), run);
    const after = succeedRun(run, T0 + 2);
    expect(after.status).not.toBe("succeeded");
  });

  it("allows a build-only run to succeed with no deployment", () => {
    let run = createBuildRun({ id: "run2", projectId: "p1", actions: { build: true, publish: false, preview: true }, now: T0 });
    run = BUILD_STAGES.reduce((acc, stage) => (stage.id === "publish" ? acc : completeStage(acc, stage.id, T0 + 1, "ok")), run);
    run = completeStage(run, "publish", T0 + 2, "not published");
    expect(succeedRun(run, T0 + 3).status).toBe("succeeded");
  });
});

describe("applyStaleness — no card is ever stuck on Publishing", () => {
  it("fails a run whose active stage exceeded its timeout", () => {
    let run = started();
    run = beginStage(run, "publish", T0);
    const stale = applyStaleness(run, T0 + 10 * 60 * 1000);
    expect(stale.status).toBe("failed");
    expect(stale.error?.code).toBe("BUILD_RUN_STALE");
    expect(stale.error?.message).toMatch(/nothing was published/i);
    expect(stale.deployment?.status).not.toBe("live");
  });

  it("leaves a fresh run alone", () => {
    let run = started();
    run = beginStage(run, "generate", T0);
    expect(applyStaleness(run, T0 + 5000).status).toBe("running");
  });

  it("never rewrites a finished run", () => {
    let run = started();
    run = BUILD_STAGES.reduce((acc, stage) => completeStage(acc, stage.id, T0 + 1, "ok"), run);
    run = setDeployment(run, { id: "d1", status: "live", url: "https://matrix.app/s/my-site", slug: "my-site", environment: "production", rollbackAvailable: false, overridden: false, error: null }, T0 + 2);
    run = succeedRun(run, T0 + 3);
    expect(applyStaleness(run, T0 + 10 * 60 * 1000).status).toBe("succeeded");
  });
});

describe("run-store roundtrip", () => {
  it("keeps status, stages, attempts, fix action and deployment through Firestore", () => {
    let run = started();
    run = completeStage(run, "plan", T0 + 1, "Planned: index.html");
    run = failStage(run, "validate", T0 + 2, "2 problems must be fixed");
    run = bumpAttempt(run, T0 + 3);
    run = setDeployment(run, { id: "d1", status: "deploying", url: null, slug: "my-site", environment: "production", rollbackAvailable: false, overridden: true, error: null }, T0 + 4);
    const raw = toFirestoreRun(run);
    const restored = runFromFirestore(raw, T0 + 5);
    expect(restored).not.toBeNull();
    expect(restored?.id).toBe("run1");
    expect(restored?.status).toBe("running");
    expect(restored?.actions.fix).toBe(true);
    expect(restored?.attempts).toBe(1);
    expect(restored?.stages.find((stage) => stage.id === "plan")?.state).toBe("completed");
    expect(restored?.stages.find((stage) => stage.id === "validate")?.state).toBe("failed");
    expect(restored?.deployment?.slug).toBe("my-site");
    expect(restored?.deployment?.overridden).toBe(true);
    expect(storedDeploymentStatus(restored)).toBe("deploying");
  });

  it("writes no undefined fields and bounded logs", () => {
    let run = started();
    for (let i = 0; i < MAX_LOG_LINES + 40; i++) run = log(run, { stage: "generate", level: "info", message: `line ${i}`, at: T0 + i });
    const raw = toFirestoreRun(run) as Record<string, unknown>;
    const stored = raw;
    const json = JSON.stringify(raw);
    expect(json).not.toContain("undefined");
    expect(Array.isArray(stored.logs)).toBe(true);
    expect(run.logs.length).toBe(MAX_LOG_LINES);
    expect((stored.logs as unknown[]).length).toBeLessThanOrEqual(STORED_LOG_LIMIT);
  });

  it("treats a corrupt or unknown status as failed", () => {
    expect(runFromFirestore({ id: "r", status: "vibes" }, T0)?.status).toBe("failed");
    expect(runFromFirestore(null, T0)).toBeNull();
    expect(runFromFirestore("nope", T0)).toBeNull();
  });

  it("keeps the snapshot small enough for a chat message", () => {
    let run = started();
    run = BUILD_STAGES.reduce((acc, stage) => completeStage(acc, stage.id, T0 + 1, "x".repeat(400)), run);
    const snapshot = toRunSnapshot(run);
    expect(JSON.stringify(snapshot).length).toBeLessThan(2000);
    expect(snapshot.stage_states.length).toBe(BUILD_STAGES.length);
    const revived = runFromSnapshot(snapshot, T0 + 9);
    expect(revived.stages.find((stage) => stage.id === "plan")?.state).toBe("completed");
    expect(revived.deployment).toBeNull();
  });
});

describe("change summary", () => {
  it("counts created, modified and removed files", () => {
    const before = [{ path: "index.html", content: "a" }, { path: "styles.css", content: "b" }, { path: "old.js", content: "c" }];
    const after = [{ path: "index.html", content: "a2" }, { path: "styles.css", content: "b" }, { path: "app.js", content: "d" }, { path: "logo.svg", content: "e" }];
    const changes = summarizeChanges(before, after);
    expect(changeCounts(changes)).toEqual({ created: 2, modified: 1, removed: 1 });
    expect(changes.map((change) => change.path)).toEqual(["app.js", "index.html", "logo.svg", "old.js"]);
  });

  it("does not report a file as modified when its content is identical", () => {
    const same = [{ path: "index.html", content: "x" }];
    expect(summarizeChanges(same, same.map((f) => ({ ...f })))).toEqual([]);
  });
});

describe("retry accounting", () => {
  it("increments the attempt so the UI can say 'attempt 2 of 3'", () => {
    let run = started();
    expect(run.attempts).toBe(0);
    run = bumpAttempt(run, T0 + 1);
    run = bumpAttempt(run, T0 + 2);
    expect(run.attempts).toBe(2);
    expect(run.maxAttempts).toBeGreaterThanOrEqual(2);
  });
});
