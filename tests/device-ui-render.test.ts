// @vitest-environment jsdom
// =============================================================================
// Render smoke tests for the Phase 6/7/8 UI.
//
// `tsc` proves the props type-check; it cannot prove a component renders
// without throwing. These mount the real components with the RPC layer stubbed
// and assert on the accessible output — the words a user (and a reviewer)
// will actually see.
// =============================================================================
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

// The components call rpc() on mount; keep it pending so we assert the
// loading/empty states deterministically.
vi.mock("@/lib/client/api", () => ({
  rpc: vi.fn(() => new Promise(() => {})),
  RpcCallError: class RpcCallError extends Error {
    constructor(readonly code: string, readonly status: number, readonly detail?: string) {
      super(detail ?? code);
    }
  },
}));
vi.mock("@/components/toast", () => ({ useToast: () => () => {} }));

import { CrossAccountLinks } from "../src/components/devices/cross-account-links";
import { DevicesAdmin } from "../src/components/admin/devices-admin";
import { InspectionPanel } from "../src/components/admin/inspection-panel";
import { GuardianInspections } from "../src/components/family/guardian-inspections";

afterEach(() => vi.clearAllMocks());

describe("Phase 6 — cross-account links UI", () => {
  it("renders the create and join affordances", () => {
    const html = renderToStaticMarkup(createElement(CrossAccountLinks));
    expect(html).toContain("Cross-Account Device Links");
    expect(html).toContain("Create invitation");
    expect(html).toContain("Enter a code from another device");
    // The privacy promise is on screen, not just in the backend.
    expect(html).toContain("single-use");
    expect(html).toContain("only their hashes are stored");
  });
});

describe("Phase 7 — admin devices UI", () => {
  it("refuses to render device data without security.view", () => {
    const html = renderToStaticMarkup(createElement(DevicesAdmin, { codes: [] }));
    expect(html).toContain("security.view");
    expect(html).not.toContain("Cross-account pairing history");
  });

  it("explains read-only access when users.view is missing", () => {
    const html = renderToStaticMarkup(createElement(DevicesAdmin, { codes: ["security.view"] }));
    expect(html).toContain("Read-only");
    expect(html).toContain("users.view");
  });

  it("shows the summary and filters for a full admin", () => {
    const html = renderToStaticMarkup(createElement(DevicesAdmin, { codes: ["security.view", "users.view"] }));
    for (const label of ["Devices", "Online", "Offline", "Pending", "Revoked", "Online only"]) {
      expect(html).toContain(label);
    }
    expect(html).toContain("Pairing history");
  });
});

describe("Phase 8 — inspection UI", () => {
  it("previews the exact notice before sending", () => {
    const html = renderToStaticMarkup(createElement(InspectionPanel, { deviceId: "dev-1", targetUid: "owner-1", targetName: "Rumana" }));
    expect(html).toContain("Request an inspection");
    expect(html).toContain("Shown to the user");
    // Forbidden scopes are never offered as options.
    expect(html).not.toContain(">Messages<");
    expect(html).not.toContain(">Passwords<");
    // But the scope list is real.
    expect(html).toContain("App version, crash reports and error logs");
  });

  it("tells the guardian exactly what approving means", () => {
    const html = renderToStaticMarkup(createElement(GuardianInspections));
    expect(html).toContain("Inspection approvals");
    expect(html).toContain("before");
    expect(html).toContain("still gets the final say");
  });
});
