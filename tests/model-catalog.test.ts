import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { parseModelCatalog, fetchModelCatalog, verifyCatalogModel, resetModelCatalogCache } from "@/lib/ai/model-catalog";
import { CatalogValidatedProvider, environmentProviders } from "@/lib/ai/provider-registry";
import { createRuntimeAgentRoute } from "@/lib/ai/runtime-config";
import { isProviderEndpointAllowed } from "@/lib/ai/endpoint-policy";
import { AnthropicProvider } from "@/lib/ai/anthropic";
import type { AIProvider } from "@/lib/ai/groq";

let server: Server;
let base: string;
let requests: { url: string; auth?: string; body?: Record<string, unknown> }[] = [];
beforeAll(async () => {
  server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    requests.push({ url: req.url ?? "", auth: req.headers.authorization, body: raw ? JSON.parse(raw) : undefined });
    res.setHeader("content-type", "application/json");
    if (req.url?.endsWith("/models")) { res.end(JSON.stringify({ data: [{ id: "account-chat" }, { id: "account-agent" }] })); return; }
    const body = JSON.parse(raw) as { model: string };
    if (req.url?.endsWith("/messages")) { res.end(JSON.stringify({ model: body.model, content: [{ type: "text", text: "verified response" }], usage: { input_tokens: 2, output_tokens: 2 } })); return; }
    res.end(JSON.stringify({ model: body.model, choices: [{ message: { content: "verified response" } }], usage: { prompt_tokens: 2, completion_tokens: 2, total_tokens: 4 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => { requests = []; resetModelCatalogCache(); });

describe("verified model registry", () => {
  it("parses real provider shapes without inventing model names", () => {
    expect(parseModelCatalog({ data: [{ id: "a" }, { id: "a" }, { id: "bad model" }] })).toEqual([{ id: "a", label: "a" }]);
    expect(parseModelCatalog({ data: [{ id: "models/gemini-example", display_name: "Gemini" }] })[0].id).toBe("gemini-example");
    expect(environmentProviders().length).toBeGreaterThanOrEqual(0);
  });
  it("uses account credentials and rejects the reported invalid Qwen ID before chat", async () => {
    await verifyCatalogModel({ baseUrl: base, apiKey: "test-account-key" }, "account-chat");
    expect(requests[0].auth).toBe("Bearer test-account-key");
    await expect(verifyCatalogModel({ baseUrl: base, apiKey: "test-account-key" }, "qwen/qwen3.6-27b")).rejects.toMatchObject({ type: "invalid_request", model: "qwen/qwen3.6-27b" });
    expect(requests).toHaveLength(1); // verified catalog cached, not guessed
    const inner: AIProvider = { chat: async () => { throw new Error("must not be called"); }, healthCheck: async () => true, listModels: async () => [{ id: "account-chat", label: "Chat" }] };
    await expect(new CatalogValidatedProvider(inner).chat({ model: "qwen/qwen3.6-27b", messages: [] })).rejects.toThrow("not listed");
  });
  it("fixes the Agent health probe to use the Agent model, not the chat model", async () => {
    const route = createRuntimeAgentRoute({ enabled: true, base_url: base, model: "account-chat", agent_model: "account-agent", api_key: "test-key" })!;
    expect(route.model).toBe("account-agent");
    expect(await route.client.healthCheck()).toBe(true);
    const completion = requests.find((item) => item.url.endsWith("/chat/completions"));
    expect(completion?.body?.model).toBe("account-agent");
  });
  it("native Anthropic adapter uses Messages shape and separate system context", async () => {
    const provider = new AnthropicProvider("test-key", base);
    const result = await provider.chat({ model: "account-chat", messages: [{ role: "system", content: "Be concise" }, { role: "user", content: "Hello" }] });
    expect(result.content).toBe("verified response");
    expect(requests[0].url).toBe("/v1/messages");
    expect(requests[0].body?.system).toBe("Be concise");
    expect(requests[0].body?.messages).toEqual([{ role: "user", content: "Hello" }]);
  });
  it("blocks metadata/private targets and requires explicit local HTTP opt-in", () => {
    expect(isProviderEndpointAllowed("https://169.254.169.254/latest")).toBe(false);
    expect(isProviderEndpointAllowed("https://127.0.0.1/v1")).toBe(false);
    expect(isProviderEndpointAllowed("https://[::1]/v1")).toBe(false);
    expect(isProviderEndpointAllowed("http://localhost:11434/v1")).toBe(false);
    process.env.AI_ALLOW_LOCAL_HTTP = "true";
    expect(isProviderEndpointAllowed("http://localhost:11434/v1")).toBe(true);
    delete process.env.AI_ALLOW_LOCAL_HTTP;
    expect(isProviderEndpointAllowed("https://api.openai.com/v1")).toBe(true);
  });
});
