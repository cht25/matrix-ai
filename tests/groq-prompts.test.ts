import { afterEach, describe, expect, it, vi } from "vitest";
import { GroqProvider } from "../src/lib/ai/groq";
import { buildSystemMessages, validateOutput, buildSummaryPrompt } from "../src/lib/ai/prompts";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("GroqProvider (spec §15)", () => {
  it("calls the Groq API with the right shape and returns content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Stay safe online!" } }],
        model: "llama-3.3-70b-versatile",
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }) as unknown as typeof fetch;

    const provider = new GroqProvider("gsk-test");
    const res = await provider.chat({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: "Is this email a scam?" }],
    });

    expect(res.content).toBe("Stay safe online!");
    expect(res.usage.totalTokens).toBe(15);

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toContain("api.groq.com");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("llama-3.3-70b-versatile");
  });

  it("throws on API errors", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 429, text: async () => "rate limited" }) as unknown as typeof fetch;
    const provider = new GroqProvider("gsk-test");
    await expect(provider.chat({ model: "m", messages: [] })).rejects.toThrow(/429/);
  });

  it("attaches images for vision models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Risk: high" } }], model: "m", usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
    }) as unknown as typeof fetch;

    const provider = new GroqProvider("gsk-test");
    await provider.chat({ model: "llama-3.2-11b-vision-preview", messages: [{ role: "user", content: "analyze" }], imageDataUrl: "data:image/png;base64,abc" });

    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "analyze" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
  });
});

describe("Prompt construction (spec §24, §60)", () => {
  it("builds system + RAG context messages", () => {
    const msgs = buildSystemMessages("[scam_article] Prize scams: never pay fees", false);
    expect(msgs[0].role).toBe("system");
    expect(msgs[1].content).toContain("Verified knowledge retrieved");
    expect(msgs[1].content).toContain("Prize scams");
  });

  it("summary prompt strips personal data instruction", () => {
    const prompt = buildSummaryPrompt([{ role: "user", content: "hi" }]);
    expect(prompt).toContain("Do not include personal data");
  });
});

describe("Output safety validation (spec §24)", () => {
  it("blocks harmful output", () => {
    expect(validateOutput("here is how to create malware").ok).toBe(false);
    expect(validateOutput("here is how to ddos a site").ok).toBe(false);
  });

  it("allows defensive output", () => {
    expect(validateOutput("Turn on 2FA and use a passphrase").ok).toBe(true);
  });
});
