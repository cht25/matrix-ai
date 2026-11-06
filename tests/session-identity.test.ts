import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorization: null as string | null,
  verifyIdToken: vi.fn(), verifySessionCookie: vi.fn(), cookies: vi.fn(),
}));
vi.mock("next/headers", () => ({
  headers: async () => new Headers(mocks.authorization === null ? {} : { authorization: mocks.authorization }),
  cookies: mocks.cookies,
}));
vi.mock("@/lib/firebase/admin", () => ({
  adminConfigured: () => true,
  adminAuth: () => ({ verifyIdToken: mocks.verifyIdToken, verifySessionCookie: mocks.verifySessionCookie }),
}));
import { getSessionUser } from "@/lib/firebase/session";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authorization = null;
  mocks.cookies.mockResolvedValue({ get: () => ({ value: "valid-cookie" }) });
  mocks.verifySessionCookie.mockResolvedValue({ uid: "cookie-user", email: "cookie@example.com" });
});
describe("explicit authentication identity", () => {
  it("uses cookie authentication when no authorization header is present", async () => {
    expect((await getSessionUser())?.uid).toBe("cookie-user");
  });
  it("does not downgrade an invalid bearer to an unrelated cookie identity", async () => {
    mocks.authorization = "Bearer revoked";
    mocks.verifyIdToken.mockRejectedValue(new Error("revoked"));
    expect(await getSessionUser()).toBeNull();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it("rejects malformed explicit credentials without a cookie fallback", async () => {
    mocks.authorization = "Basic x";
    expect(await getSessionUser()).toBeNull();
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
  it("uses verified native identity rather than cookie identity", async () => {
    mocks.authorization = "Bearer valid";
    mocks.verifyIdToken.mockResolvedValue({ uid: "native-user", email_verified: true });
    expect((await getSessionUser())?.uid).toBe("native-user");
    expect(mocks.verifyIdToken).toHaveBeenCalledWith("valid", true);
    expect(mocks.cookies).not.toHaveBeenCalled();
  });
});
