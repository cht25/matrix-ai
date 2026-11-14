import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAICompatibleProvider, normalizeCompatibleBaseUrl, isCompatibleBaseUrl } from "../src/lib/ai/openai";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
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

  it("sends no third-party router headers", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "hello" } }], model: "my-model", usage: {} }),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://gateway.example/v1");
    await provider.chat({ model: "my-model", messages: [{ role: "user", content: "hi" }] });
    const [, init] = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["HTTP-Referer"]).toBeUndefined();
    expect(init.headers["X-OpenRouter-Title"]).toBeUndefined();
  });

  it("sends function tools and returns model tool calls without requiring text content", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "projects.list", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        model: "my-model",
        usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      }),
    }) as unknown as typeof fetch;
    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    const result = await provider.chat({
      model: "my-model",
      messages: [{ role: "user", content: "list my projects" }],
      tools: [{ type: "function", function: { name: "projects.list", description: "List owned projects", parameters: { type: "object", properties: {} } } }],
    });
    expect(provider.supportsToolCalls).toBe(true);
    expect(result.content).toBe("");
    expect(result.toolCalls).toEqual([{ id: "call-1", type: "function", function: { name: "projects.list", arguments: "{}" } }]);
    const body = JSON.parse(String((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body));
    expect(body.tool_choice).toBe("auto");
    expect(body.tools[0].function.name).toBe("projects.list");
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

describe("OpenAICompatibleProvider streaming", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const sse = (delta: string) => `data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`;

  function sseBody(events: string[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const event of events) controller.enqueue(encode(event));
        controller.close();
      },
    });
  }

  it("keeps spaces between deltas and removes split <think> blocks (regression)", async () => {
    // Regression for the "Here'salean,repeatableframework" bug: every streamed
    // delta used to be .trim()'d, gluing all words together, and Qwen3's
    // <think> chain-of-thought leaked straight into the chat.
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([
        sse("<th"),
        sse("ink>Here's a thinking process: 1. analyse 2. plan</th"),
        sse("ink>Here's a "),
        sse("lean, "),
        sse("repeatable "),
        sse("framework you can use right now.\n\n"),
        sse("1. Step "),
        sse("one.\n"),
        `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 9, completion_tokens: 17, total_tokens: 26 } })}\n\n`,
        "data: [DONE]\n\n",
      ]),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    let out = "";
    let usage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    for await (const delta of provider.streamChat({ model: "qwen/qwen3.6-27b", messages: [{ role: "user", content: "hi" }], onUsage: (reported) => { usage = reported; } })) {
      out += delta;
    }

    expect(out).toBe("Here's a lean, repeatable framework you can use right now.\n\n1. Step one.\n");
    expect(usage).toEqual({ promptTokens: 9, completionTokens: 17, totalTokens: 26 });
  });

  it("yields nothing for a reasoning-only stream", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: sseBody([sse("<think>only private reasoning, never shown</think>"), "data: [DONE]\n\n"]),
    }) as unknown as typeof fetch;

    const provider = new OpenAICompatibleProvider("sk-private", "https://provider.example/v1");
    const chunks: string[] = [];
    for await (const delta of provider.streamChat({ model: "qwen/qwen3.6-27b", messages: [{ role: "user", content: "hi" }] })) {
      chunks.push(delta);
    }
    expect(chunks).toEqual([]);
  });
});
