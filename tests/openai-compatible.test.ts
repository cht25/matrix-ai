import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, normalizeCompatibleBaseUrl, isCompatibleBaseUrl } from "../src/lib/ai/openai";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("OpenAI-compatible endpoint parsing", () => {
  it("accepts a base URL and a full chat/completions URL", () => {
    expect(normalizeCompatibleBaseUrl("https://api.openai.com/v1")).toBe("https://api.openai.com/v1");
    expect(normalizeCompatibleBaseUrl("https://api.openai.com/v1/")).toBe("https://api.openai.com/v1");
    expect(normalizeCompatibleBaseUrl("https://api.openai.com/v1/chat/completions")).toBe("https://api.openai.com/v1");
    expect(isCompatibleBaseUrl("https://api.openai.com/v1")).toBe(true);
    expect(isCompatibleBaseUrl("file:///etc/passwd")).toBe(false);
    expect(isCompatibleBaseUrl("not a url")).toBe(false);
  });
});

describe("OpenAICompatibleProvider", () => {
  it("calls the configured endpoint with Bearer auth and returns content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "hello from provider" }, finish_reason: "stop" }],
        model: "my-model",
        usage: { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 },
      }),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    const result = await provider.chat({ model: "my-model", messages: [{ role: "user", content: "hi" }] });

    expect(result.content).toBe("hello from provider");
    expect(result.model).toBe("my-model");
    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(String(url)).toBe("https://provider.example/v1/chat/completions");
    expect(init.headers.Authorization).toBe("Bearer sk-private");
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("my-model");
    expect(body.messages[0].content).toBe("hi");
    expect(body.max_tokens).toBe(1024);
  });

  it("sends images as OpenAI-compatible message content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "seen" } }], model: "vision-model", usage: { total_tokens: 7 } }),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    await provider.chat({
      model: "vision-model",
      messages: [{ role: "user", content: "describe" }],
      imageDataUrl: "data:image/png;base64,abc",
    });

    const [url, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse(String(init.body));
    expect(body.messages[0].content).toHaveLength(2);
    expect(body.messages[0].content[0]).toMatchObject({ type: "text", text: "describe" });
    expect(body.messages[0].content[1]).toMatchObject({ type: "image_url", image_url: { url: "data:image/png;base64,abc" } });
  });
});

describe("OpenAICompatibleProvider.streamChat reasoning scrubbing", () => {
  function sseResponse(deltas: string[]): Response {
    const encoder = new TextEncoder();
    const events = deltas.map((d) => `data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
    events.push("data: [DONE]\n\n");
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encoder.encode(event));
        controller.close();
      },
    });
    return { ok: true, body } as unknown as Response;
  }

  it("emits a Qwen-style reply with spaces intact and no <think> chain-of-thought", async () => {
    // Exact shape of the reported bug: the reasoning block (with <think> split
    // across deltas) streamed through verbatim, and every leading-space token
    // was trimmed away so the words arrived glued together.
    globalThis.fetch = vi.fn().mockResolvedValue(
      sseResponse([
        "<th",
        "ink>Here's a thinking process: 1. Analyze user input.</th",
        "ink>",
        "\n\nHere's",
        " a",
        " lean,",
        " repeatable",
        " framework",
        " you",
        " can",
        " apply",
        " to",
        " any",
        " idea",
        " right",
        " now.",
      ]),
    ) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    let out = "";
    for await (const delta of provider.streamChat({ model: "qwen/qwen3.6-27b", messages: [{ role: "user", content: "hi" }] })) {
      out += delta;
    }

    expect(out).toBe("Here's a lean, repeatable framework you can apply to any idea right now.");
    expect(out).not.toContain("<think>");
    expect(out).not.toContain("thinking process");
  });

  it("drops reasoning sent in a separate reasoning_content field", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: "private", content: null } }] })}\n\n`));
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: " visible" } }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, body }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    let out = "";
    for await (const delta of provider.streamChat({ model: "qwen/qwen3.6-27b", messages: [{ role: "user", content: "hi" }] })) {
      out += delta;
    }
    expect(out).toBe("visible");
  });

  it("also strips <think> blocks from non-streaming chat content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "<think>hidden</think>Visible answer." } }] }),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    const result = await provider.chat({ model: "qwen/qwen3.6-27b", messages: [{ role: "user", content: "hi" }] });
    expect(result.content).toBe("Visible answer.");
  });
});
