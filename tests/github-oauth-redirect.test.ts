import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { GET as connect } from "@/app/api/github/connect/route";
import { GET as callback } from "@/app/api/github/callback/route";
import { getSessionUser } from "@/lib/firebase/session";
import { saveGithubConnection } from "@/lib/server/github";
import { isGithubConfigured } from "@/lib/env";

vi.mock("@/lib/firebase/session", () => ({ getSessionUser: vi.fn() }));
vi.mock("@/lib/server/github", () => ({ saveGithubConnection: vi.fn() }));
vi.mock("@/lib/env", () => ({ env: { github: { clientId: "client-id", clientSecret: "secret", tokenEncryptionKey: "a".repeat(40) } }, isGithubConfigured: vi.fn() }));
const user = { uid: "user-1", email: "u@example.com", emailVerified: true };
const production = "https://matrix.thamjj13.top";
const upstream = "http://localhost:10000";
const request = (path: string, cookies = "") => new NextRequest(`${upstream}${path}`, { headers: { host: "localhost:10000", "x-forwarded-host": "matrix.thamjj13.top", "x-forwarded-proto": "https", ...(cookies ? { cookie: cookies } : {}) } });
const url = (response: Response) => response.headers.get("location") ?? "";

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("NEXT_PUBLIC_APP_URL", production);
  vi.stubEnv("GITHUB_OAUTH_CALLBACK_URL", `${production}/api/github/callback`);
  vi.mocked(getSessionUser).mockResolvedValue(user);
  vi.mocked(isGithubConfigured).mockReturnValue(true);
  vi.mocked(saveGithubConnection).mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

async function begin(next = "/chat/thread-1") {
  const response = await connect(request(`/api/github/connect?next=${encodeURIComponent(next)}`));
  const authorization = new URL(url(response));
  const state = authorization.searchParams.get("state")!;
  const cookies = ["matrix_github_oauth", "matrix_github_oauth_return", "matrix_github_oauth_owner"]
    .map((name) => `${name}=${encodeURIComponent(response.cookies.get(name)?.value ?? "")}`).join("; ");
  return { response, authorization, state, cookies };
}

describe("GitHub OAuth behind an internal production proxy", () => {
  it("manual callback does not try OAuth or redirect to localhost", async () => {
    vi.mocked(isGithubConfigured).mockReturnValue(false);
    const response = await callback(request("/api/github/callback"));
    expect(response.status).toBe(303);
    expect(url(response)).toBe(`${production}/chat?mode=agent&github=invalid_callback`);
    expect(saveGithubConnection).not.toHaveBeenCalled();
  });
  it("starts OAuth with the exact public callback, random state and secure cookies", async () => {
    const { response, authorization, state } = await begin();
    expect(authorization.origin).toBe("https://github.com");
    expect(authorization.searchParams.get("redirect_uri")).toBe(`${production}/api/github/callback`);
    expect(state.length).toBeGreaterThan(20);
    expect(response.cookies.get("matrix_github_oauth")?.secure).toBe(true);
    expect(response.cookies.get("matrix_github_oauth_return")?.value).toBe("/chat/thread-1?mode=agent");
  });
  it("exchanges the code with the same redirect URI, saves once, and restores the Agent thread", async () => {
    const { state, cookies } = await begin();
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "private-token" }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ login: "octocat" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const response = await callback(request(`/api/github/callback?code=code-1&state=${state}`, cookies));
    expect(response.status).toBe(303);
    expect(url(response)).toBe(`${production}/chat/thread-1?mode=agent&github=connected`);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).redirect_uri).toBe(`${production}/api/github/callback`);
    expect(saveGithubConnection).toHaveBeenCalledOnce();
    expect(saveGithubConnection).toHaveBeenCalledWith("user-1", "private-token", expect.objectContaining({ login: "octocat" }));
    expect(response.cookies.get("matrix_github_oauth")?.maxAge).toBe(0);
  });
  it("denied consent, invalid state and changed session never save a connection", async () => {
    const { state, cookies } = await begin();
    const denied = await callback(request(`/api/github/callback?error=access_denied&state=${state}`, cookies));
    expect(url(denied)).toBe(`${production}/chat/thread-1?mode=agent&github=denied`);
    const invalid = await callback(request("/api/github/callback?code=code-1&state=wrong", cookies));
    expect(url(invalid)).toBe(`${production}/chat?mode=agent&github=invalid-state`);
    vi.mocked(getSessionUser).mockResolvedValueOnce({ ...user, uid: "different-user" });
    const swapped = await callback(request(`/api/github/callback?code=code-1&state=${state}`, cookies));
    expect(url(swapped)).toBe(`${production}/chat/thread-1?mode=agent&github=invalid-state`);
    expect(saveGithubConnection).not.toHaveBeenCalled();
  });
  it("expired state and credentials removed mid-flow fail without exchanging the code", async () => {
    const { state, cookies } = await begin();
    const expired = await callback(request(`/api/github/callback?code=code-1&state=${state}`));
    expect(url(expired)).toBe(`${production}/chat?mode=agent&github=invalid-state`);
    vi.mocked(isGithubConfigured).mockReturnValue(false);
    const missing = await callback(request(`/api/github/callback?code=code-1&state=${state}`, cookies));
    expect(url(missing)).toBe(`${production}/chat/thread-1?mode=agent&github=not-configured`);
    expect(saveGithubConnection).not.toHaveBeenCalled();
  });
  it("missing OAuth credentials and unsafe return destinations never redirect to localhost", async () => {
    vi.mocked(isGithubConfigured).mockReturnValue(false);
    const response = await connect(request("/api/github/connect?next=https%3A%2F%2Fevil.example%2F"));
    expect(url(response)).toBe(`${production}/chat?mode=agent&github=not-configured`);
    expect(url(response)).not.toContain("localhost");
  });
  it("fails closed for missing, private or mismatched production origin settings", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "http://localhost:10000");
    expect((await callback(request("/api/github/callback"))).status).toBe(503);
    expect((await connect(request("/api/github/connect"))).headers.get("location")).toBeNull();
    vi.stubEnv("NEXT_PUBLIC_APP_URL", production);
    vi.stubEnv("GITHUB_OAUTH_CALLBACK_URL", "https://other.example/api/github/callback");
    expect((await connect(request("/api/github/connect"))).status).toBe(503);
  });
  it("allows localhost only in development with matching local callback configuration", async () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("GITHUB_OAUTH_CALLBACK_URL", `${upstream}/api/github/callback`);
    const response = await connect(request("/api/github/connect"));
    expect(new URL(url(response)).searchParams.get("redirect_uri")).toBe(`${upstream}/api/github/callback`);
  });
});
