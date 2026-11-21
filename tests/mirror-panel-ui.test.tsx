// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const rpcMock = vi.fn();

class MockRpcCallError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
    readonly requestId?: string,
  ) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = "RpcCallError";
  }
}

vi.mock("@/lib/client/api", () => ({
  rpc: (...args: unknown[]) => rpcMock(...args),
  RpcCallError: MockRpcCallError,
}));

const { MirrorPanel } = await import("../src/components/devices/mirror-panel");

describe("MirrorPanel (/mirror) UI integration", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    rpcMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    vi.useRealTimers();
    container.remove();
  });

  it("renders empty-device guidance for a new user when device_list=[] and mirror_sessions_list={ sessions: [] }", async () => {
    rpcMock.mockImplementation(async (action: string) => {
      if (action === "device_list") return [];
      if (action === "mirror_sessions_list") return { sessions: [] };
      throw new Error(`unexpected action ${action}`);
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<MirrorPanel />);
    });

    expect(rpcMock).toHaveBeenCalledWith("device_list");
    expect(rpcMock).toHaveBeenCalledWith("mirror_sessions_list");
    expect(container.textContent).toContain("No paired devices yet");
    expect(container.textContent).toContain("Pair two or more devices under Devices first");

    await act(async () => {
      root.unmount();
    });
  });

  it("renders active mirror sessions from { sessions }, skips revoked devices for default source selection, and clears transient poll errors on recovery", async () => {
    let failFirstLoad = true;
    rpcMock.mockImplementation(async (action: string) => {
      if (failFirstLoad) {
        throw new MockRpcCallError("SERVICE_UNAVAILABLE", 503, undefined, "req-transient-503");
      }
      if (action === "device_list") {
        return [
          {
            id: "dev-revoked",
            device_name: "Revoked Tablet",
            device_type: "android",
            platform: "Android",
            status: "revoked",
            role: "child",
          },
          {
            id: "dev-active",
            device_name: "Pixel 9 Pro",
            device_type: "android",
            platform: "Android 15",
            status: "online",
            role: "child",
          },
        ];
      }
      if (action === "mirror_sessions_list") {
        return {
          sessions: [
            {
              session_id: "sess-42",
              source_device_id: "dev-active",
              source_device_name: "Pixel 9 Pro",
              viewer_device_id: "web",
              status: "awaiting_source_consent",
              mode: "view_only",
              remote_control_requested: false,
              remote_control_enabled: false,
              started_at: "2026-11-21T12:00:00.000Z",
              expires_at: "2026-11-21T12:15:00.000Z",
            },
          ],
        };
      }
      throw new Error(`unexpected action ${action}`);
    });

    const root = createRoot(container);
    await act(async () => {
      root.render(<MirrorPanel />);
    });

    expect(container.textContent).toContain("SERVICE_UNAVAILABLE (ref: req-transient-503)");

    // Next 5s poll succeeds: error clears, active device is selected, session renders.
    failFirstLoad = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect(container.textContent).not.toContain("SERVICE_UNAVAILABLE");
    expect(container.textContent).toContain("Pixel 9 Pro");
    expect(container.textContent).toContain("Incoming Mirror Consent Requests");
    const select = container.querySelector("select") as HTMLSelectElement | null;
    expect(select?.value).toBe("dev-active");

    await act(async () => {
      root.unmount();
    });
  });
});
