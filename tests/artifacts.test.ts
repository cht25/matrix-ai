import { describe, expect, it } from "vitest";
import {
  activityLines, advanceExecution, artifactFilename, artifactLabel, artifactStatusCopy, beginArtifact,
  clearArtifact, completeArtifact, emptyArtifactState, emptyExecution, failArtifact, finishExecution,
  fromSnapshot, hasExecutionDetail, isArtifactReady, isArtifactVisible, pickArtifactContent,
  requestArtifact, startExecution, toSnapshot,
} from "../src/lib/ai/artifacts";

describe("artifact lifecycle", () => {
  it("starts as Not Requested and is invisible", () => {
    const state = emptyArtifactState();
    expect(state.requested).toBe(false);
    expect(state.type).toBe("NONE");
    expect(state.status).toBeNull();
    expect(isArtifactVisible(state)).toBe(false);
    expect(isArtifactReady(state)).toBe(false);
    expect(artifactStatusCopy(state)).toBeNull();
    expect(toSnapshot(state)).toBeNull();
  });

  it("walks Requested → Generating → Ready → Available", () => {
    let state = requestArtifact(emptyArtifactState(), { format: "pdf", title: "Photosynthesis" });
    expect(state.requested).toBe(true);
    expect(state.type).toBe("PDF");
    expect(state.status).toBe("requested");
    expect(state.label).toBe("PDF");
    expect(state.filename).toBe("photosynthesis.pdf");
    expect(isArtifactVisible(state)).toBe(true);
    expect(artifactStatusCopy(state)?.title).toBe("PDF requested");

    state = beginArtifact(state);
    expect(state.status).toBe("generating");
    expect(artifactStatusCopy(state)?.title).toBe("Generating PDF…");
    expect(artifactStatusCopy(state)?.tone).toBe("active");

    state = completeArtifact(state);
    expect(state.status).toBe("ready");
    expect(isArtifactReady(state)).toBe(true);
    expect(artifactStatusCopy(state)?.title).toBe("PDF ready");
    expect(artifactStatusCopy(state)?.tone).toBe("success");
    expect(state.durationMs).not.toBeNull();
  });

  it("refuses to skip a step", () => {
    const empty = emptyArtifactState();
    // Nothing was requested → nothing can start or complete.
    expect(beginArtifact(empty)).toEqual(empty);
    expect(completeArtifact(empty)).toEqual(empty);
    expect(failArtifact(empty, "nope")).toEqual(empty);

    const requested = requestArtifact(empty, { format: "csv" });
    // Requested cannot jump straight to Ready.
    expect(completeArtifact(requested)).toEqual(requested);
    // A ready artifact cannot be marked failed.
    const ready = completeArtifact(beginArtifact(requested));
    expect(failArtifact(ready, "too late")).toEqual(ready);
  });

  it("cannot be requested twice while in flight", () => {
    const first = requestArtifact(emptyArtifactState(), { format: "pdf" });
    const second = requestArtifact(first, { format: "csv" });
    expect(second).toEqual(first);
    // After a failure the user may ask again.
    const failed = failArtifact(beginArtifact(first), "no tabular data");
    expect(failed.status).toBe("failed");
    expect(artifactStatusCopy(failed)?.tone).toBe("danger");
    expect(requestArtifact(failed, { format: "csv" }).type).toBe("CSV");
  });

  it("ignores nonsense requests", () => {
    expect(requestArtifact(emptyArtifactState(), {})).toEqual(emptyArtifactState());
    expect(requestArtifact(emptyArtifactState(), { type: "NONE" })).toEqual(emptyArtifactState());
  });

  it("dismisses back to Not Requested", () => {
    const ready = completeArtifact(beginArtifact(requestArtifact(emptyArtifactState(), { format: "txt" })));
    expect(clearArtifact()).toEqual(emptyArtifactState());
    expect(isArtifactVisible(ready)).toBe(true);
  });

  it("supports non-document artifacts", () => {
    const image = requestArtifact(emptyArtifactState(), { type: "IMAGE" });
    expect(image.type).toBe("IMAGE");
    expect(image.format).toBeNull();
    expect(image.filename).toBe("matrix-image.png");
    expect(artifactLabel("AGENT_TASK")).toBe("Agent task");
    expect(artifactFilename("MARKDOWN", "My Report")).toBe("my-report.md");
    expect(artifactFilename("IMAGE", " Anything ")).toBe("matrix-image.png");
  });

  it("round-trips through a serializable snapshot", () => {
    const ready = completeArtifact(beginArtifact(requestArtifact(emptyArtifactState(), { format: "docx", title: "Field notes" })));
    const snapshot = toSnapshot(ready);
    expect(snapshot).not.toBeNull();
    const restored = fromSnapshot(snapshot);
    expect(restored.type).toBe("DOCX");
    expect(restored.status).toBe("ready");
    expect(restored.filename).toBe("field-notes.docx");
    expect(fromSnapshot(null)).toEqual(emptyArtifactState());
    expect(fromSnapshot(undefined)).toEqual(emptyArtifactState());
  });
});

describe("execution state and safe activity lines", () => {
  it("is empty — and therefore invisible — for plain chat", () => {
    const execution = emptyExecution();
    expect(execution.status).toBe("idle");
    expect(hasExecutionDetail(execution)).toBe(false);
    expect(activityLines(execution)).toEqual([]);
  });

  it("tracks a run and collapses when it finishes", () => {
    let execution = startExecution(emptyExecution(), "Agent initialized");
    expect(execution.status).toBe("running");
    expect(hasExecutionDetail(execution)).toBe(true);

    execution = advanceExecution(execution, { stage: "planning", event: { at: Date.now(), type: "stage", message: "Planning task", stage: "planning" } });
    execution = advanceExecution(execution, { tool: "code.runtime", event: { at: Date.now(), type: "tool", message: "Tool selected", tool: "code.runtime" } });
    execution = finishExecution(execution, "complete");
    expect(execution.status).toBe("complete");
    expect(execution.stage).toBe("complete");

    const labels = activityLines(execution).map((line) => line.label);
    expect(labels).toContain("Agent initialized");
    expect(labels).toContain("Task Planner");
    expect(labels).toContain("Executing tool · code.runtime");
  });

  it("never leaks unexpected text into the activity feed", () => {
    const execution = advanceExecution(startExecution(emptyExecution(), "Connecting"), {
      event: { at: Date.now(), type: "info", message: "The user seems anxious; internally I reasoned that step 1 should be" },
    });
    const labels = activityLines(execution).map((line) => line.label);
    expect(labels).toContain("Processing request");
    expect(labels.join(" ")).not.toMatch(/anxious|internally|reasoned/i);
  });

  it("sanitises tool identifiers and errors", () => {
    const execution = advanceExecution(startExecution(emptyExecution()), {
      event: { at: Date.now(), type: "tool", message: "Tool selected", tool: "<script>alert(1)</script>" },
    });
    const withError = advanceExecution(execution, { event: { at: Date.now(), type: "error", message: "secret key leaked" } });
    const labels = activityLines(withError).map((line) => line.label);
    expect(labels).toContain("Executing tool · tool");
    expect(labels).toContain("Something went wrong");
    expect(labels.join(" ")).not.toMatch(/script|secret/i);
  });

  it("shows a live step while running", () => {
    const labels = activityLines(startExecution(emptyExecution())).map((line) => line.label);
    expect(labels).toEqual(["Preparing response"]);
  });

  it("finishExecution ignores an idle run", () => {
    expect(finishExecution(emptyExecution())).toEqual(emptyExecution());
  });
});

describe("pickArtifactContent — what an export request refers to", () => {
  const previous = "# Photosynthesis\n\nPlants convert light into chemical energy, releasing oxygen as a by-product.";
  const ack = "Sure — I'll prepare the PDF from the answer above.";
  const table = "| id | name |\n| --- | --- |\n| 1 | Ada |\n| 2 | Grace |";

  it("exports the previous answer when the reply is only an acknowledgement", () => {
    expect(pickArtifactContent({ format: "pdf", reply: ack, previous })).toBe(previous);
    expect(pickArtifactContent({ format: "docx", reply: "Here is your Word document.", previous })).toBe(previous);
  });

  it("exports the reply when the reply is the document", () => {
    expect(pickArtifactContent({ format: "pdf", reply: previous, previous: ack })).toBe(previous);
    expect(pickArtifactContent({ format: "markdown", reply: "# Notes\n\n- one\n- two", previous: null })).toBe("# Notes\n\n- one\n- two");
  });

  it("takes tabular data from whichever message actually has it", () => {
    expect(pickArtifactContent({ format: "csv", reply: table, previous })).toBe(table);
    expect(pickArtifactContent({ format: "csv", reply: "Here is the CSV you asked for.", previous: table })).toBe(table);
    expect(pickArtifactContent({ format: "xlsx", reply: table, previous: table })).toBe(table);
  });

  it("takes JSON from whichever message actually has it", () => {
    const jsonReply = '```json\n{"ok": true}\n```';
    expect(pickArtifactContent({ format: "json", reply: jsonReply, previous })).toBe(jsonReply);
    expect(pickArtifactContent({ format: "json", reply: "Here is the JSON.", previous: jsonReply })).toBe(jsonReply);
  });

  it("falls back to the reply when there is nothing previous", () => {
    expect(pickArtifactContent({ format: "pdf", reply: ack, previous: null })).toBe(ack);
    expect(pickArtifactContent({ format: "csv", reply: ack, previous: undefined })).toBe(ack);
  });
});
