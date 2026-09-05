import { describe, expect, it, vi, afterEach } from "vitest";
import { ImageProviderError, isRealSecret } from "../src/lib/ai/image/provider";
import { togetherImageProvider } from "../src/lib/ai/image/together-provider";

const KEY = "2f9c1a77b0e4d5316a8c9f0e1b2d3c4a";
const CREDS = { apiKey: KEY, model: "black-forest-labs/FLUX.1-schnell-Free" };

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(impl: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const spy = vi.fn((url: RequestInfo | URL, init?: RequestInit) => Promise.resolve(impl(String(url), init)));
  vi.stubGlobal("fetch", spy);
  return spy;
}

describe("image provider abstraction", () => {
  it("exposes a stable interface so other providers can be added", () => {
    expect(togetherImageProvider.id).toBe("together");
    expect(togetherImageProvider.label).toBe("Together AI");
    expect(typeof togetherImageProvider.generate).toBe("function");
    expect(typeof togetherImageProvider.getStatus).toBe("function");
    expect(typeof togetherImageProvider.validate).toBe("function");
    expect(togetherImageProvider.models.length).toBeGreaterThan(0);
  });

  it("rejects placeholder and empty keys during validation", () => {
    expect(togetherImageProvider.validate({ apiKey: "", model: "m" }).ok).toBe(false);
    expect(togetherImageProvider.validate({ apiKey: "YOUR-KEY-HERE", model: "m" }).ok).toBe(false);
    expect(togetherImageProvider.validate({ apiKey: KEY, model: "" }).ok).toBe(false);
    expect(togetherImageProvider.validate(CREDS).ok).toBe(true);
  });
});

describe("no fake Together AI status", () => {
  it("reports NOT_CONFIGURED without ever calling the network", async () => {
    const spy = stubFetch(() => new Response("{}", { status: 200 }));
    const status = await togetherImageProvider.getStatus({ apiKey: "", model: "m" });
    expect(status).toMatchObject({ ok: false, code: "NOT_CONFIGURED" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("only reports ok after a real successful probe", async () => {
    stubFetch(() => new Response(JSON.stringify([{ id: CREDS.model }]), { status: 200 }));
    const status = await togetherImageProvider.getStatus(CREDS);
    expect(status.ok).toBe(true);
    expect(status.code).toBe("OK");
  });

  it("maps auth, rate-limit and unreachable failures to honest codes", async () => {
    stubFetch(() => new Response("nope", { status: 401 }));
    expect((await togetherImageProvider.getStatus(CREDS)).code).toBe("AUTH_FAILED");

    stubFetch(() => new Response("slow down", { status: 429 }));
    expect((await togetherImageProvider.getStatus(CREDS)).code).toBe("RATE_LIMITED");

    stubFetch(() => {
      throw new Error("network down");
    });
    expect((await togetherImageProvider.getStatus(CREDS)).code).toBe("UNREACHABLE");
  });

  it("flags a model the account cannot actually use", async () => {
    stubFetch(() => new Response(JSON.stringify([{ id: "some/other-model" }]), { status: 200 }));
    const status = await togetherImageProvider.getStatus(CREDS);
    expect(status.ok).toBe(false);
    expect(status.code).toBe("MODEL_INVALID");
  });
});

describe("image generation", () => {
  it("sends the key as a bearer header and returns the decoded result", async () => {
    const spy = stubFetch(() => new Response(JSON.stringify({ data: [{ b64_json: "aGk=" }] }), { status: 200 }));
    const result = await togetherImageProvider.generate(CREDS, "a cyberpunk city");

    expect(result.b64).toBe("aGk=");
    expect(result.provider).toBe("together");
    expect(result.mime).toBe("image/png");

    const init = spy.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    // The key must travel ONLY in the Authorization header, never the body.
    expect(String(init.body)).not.toContain(KEY);
  });

  it("throws a typed error instead of leaking the provider response", async () => {
    stubFetch(() => new Response("upstream stack trace with secrets", { status: 500 }));
    await expect(togetherImageProvider.generate(CREDS, "x")).rejects.toBeInstanceOf(ImageProviderError);
    await expect(togetherImageProvider.generate(CREDS, "x")).rejects.toMatchObject({ code: "UNREACHABLE" });
  });

  it("refuses to call the API when no key is configured", async () => {
    const spy = stubFetch(() => new Response("{}", { status: 200 }));
    await expect(togetherImageProvider.generate({ apiKey: "", model: "m" }, "x")).rejects.toMatchObject({
      code: "NOT_CONFIGURED",
    });
    expect(spy).not.toHaveBeenCalled();
  });

  it("treats an empty provider payload as a failure, not a success", async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [] }), { status: 200 }));
    await expect(togetherImageProvider.generate(CREDS, "x")).rejects.toMatchObject({ code: "EMPTY_RESULT" });
  });
});

describe("secret detection", () => {
  it("never treats placeholders as real secrets", () => {
    for (const value of ["", "   ", "sk-...", "YOUR-KEY", "replace-with-key", "tiny"]) {
      expect(isRealSecret(value)).toBe(false);
    }
    expect(isRealSecret(KEY)).toBe(true);
  });
});
