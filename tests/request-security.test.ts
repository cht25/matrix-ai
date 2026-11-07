import { afterEach, describe, expect, it, vi } from "vitest";
import { mutationOriginAllowed } from "@/lib/server/request-security";
import { ensureUserDocuments } from "@/lib/server/rpc";
import { PRIMARY_NAV, MOBILE_NAV, navigationActive } from "@/lib/navigation";
import { existsSync } from "node:fs";

afterEach(() => vi.unstubAllEnvs());
function request(headers: Record<string, string>, method = "POST") { return new Request("https://matrix.example/api/rpc", { method, headers }); }
describe("central mutation CSRF boundary", () => {
  it("requires exact scheme/host/port for browser mutations", () => {
    expect(mutationOriginAllowed(request({ Origin: "https://matrix.example" }))).toBe(true);
    for (const origin of ["https://attacker.example", "http://matrix.example", "https://matrix.example:8443", "null"]) expect(mutationOriginAllowed(request({ Origin: origin }))).toBe(false);
    expect(mutationOriginAllowed(request({}))).toBe(false);
  });
  it("allows native bearer without Origin but never cross-site fetch", () => {
    expect(mutationOriginAllowed(request({ Authorization: "Bearer native-token" }))).toBe(true);
    expect(mutationOriginAllowed(request({ Authorization: "Bearer native-token", "Sec-Fetch-Site": "cross-site" }))).toBe(false);
  });
  it("does not trust forwarded headers unless explicitly configured", () => {
    const headers = { Origin: "https://preview.example", "x-forwarded-host": "preview.example", "x-forwarded-proto": "https" };
    expect(mutationOriginAllowed(request(headers))).toBe(false);
    vi.stubEnv("MATRIX_TRUST_PROXY_HEADERS", "true");
    expect(mutationOriginAllowed(request(headers))).toBe(true);
  });
});

describe("privacy preferences and navigation", () => {
  it("does not reset existing privacy settings when refreshing a session", async () => {
    const settings = { memory_enabled: false, notifications_email: false, chat_history_enabled: false };
    let writes = 0;
    const db = { collection: (name: string) => ({ doc: () => ({ get: async () => ({ exists: true, data: () => name === "profiles" ? { full_name: "Existing", avatar_url: "keep" } : settings }), set: async () => { if (name === "user_security_settings") writes++; } }), add: async () => ({ id: "session" }) }) };
    await ensureUserDocuments({ getUser: async () => ({ displayName: "New", photoURL: "" }) } as never, db as never, "user", "user@example.com");
    expect(writes).toBe(0);
    expect(settings).toEqual({ memory_enabled: false, notifications_email: false, chat_history_enabled: false });
  });
  it("exposes the requested primary order and five mobile destinations", () => {
    expect(PRIMARY_NAV.map((item) => item.label)).toEqual(["New Chat", "Chat", "Agent", "Workspace", "Canvas", "Automations", "Devices", "Family", "Projects", "Models", "Settings"]);
    expect(MOBILE_NAV.map((item) => item.label)).toEqual(["Chat", "Agent", "Automations", "Devices"]);
    for (const item of PRIMARY_NAV) expect(existsSync(`src/app/(app)${item.href.split("?")[0]}/page.tsx`), item.href).toBe(true);
    expect(navigationActive("/chat", new URLSearchParams("mode=agent"), "/chat?mode=agent")).toBe(true);
    expect(navigationActive("/chat", new URLSearchParams("mode=agent"), "/chat")).toBe(false);
    expect(navigationActive("/chat/id", new URLSearchParams(), "/chat")).toBe(true);
  });
});
