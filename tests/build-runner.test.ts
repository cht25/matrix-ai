import { afterEach, describe, expect, it, vi } from "vitest";
import { streamBuildRun } from "@/lib/client/build-runner";

afterEach(() => vi.unstubAllGlobals());

describe("build stream request contract", () => {
  it("sends Code-mode workspace persistence flags to the authenticated build endpoint", async () => {
    let requestBody: Record<string, unknown> | null = null;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      return new Response('data: {"type":"done","reply":"Files saved"}\n\n', {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      });
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    await streamBuildRun({
      prompt: "Create a Python function that sorts a list",
      mode: "code",
      workspaceOnly: true,
      projectId: "project-1",
      actions: { build: true, publish: false, preview: false, fix: false },
    });

    expect(fetchMock).toHaveBeenCalledWith("/api/build", expect.objectContaining({ credentials: "same-origin" }));
    expect(requestBody).toMatchObject({
      mode: "code",
      workspace_only: true,
      project_id: "project-1",
      actions: { build: true, publish: false, preview: false, fix: false },
    });
  });
});
