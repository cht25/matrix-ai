import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { GeminiProvider, parseGeminiModelCatalog } from "@/lib/ai/gemini";

let server: Server | undefined;
let baseUrl = "";
let calls: { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];

async function listen(handler: (req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse) => void) {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      calls.push({ url: req.url ?? "", method: req.method ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") });
      handler(req, res);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1beta`;
  calls = [];
}

afterEach(async () => {
  if (server) {
    server.close();
    await once(server, "close");
    server = undefined;
  }
});

describe("Gemini native REST provider", () => {
  it("only offers models the authenticated catalog says support generateContent", () => {
    expect(parseGeminiModelCatalog({ models: [
      { name: "models/available", displayName: "Available", supportedGenerationMethods: ["generateContent"] },
      { name: "models/embeddings", supportedGenerationMethods: ["embedContent"] },
      { name: "models/no-methods" },
    ] })).toEqual([{ id: "available", label: "Available" }]);
  });

  it("uses the native generateContent REST API, sends keys only as headers, and reports actual token usage", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ modelVersion: "catalog-model", candidates: [{ content: { parts: [{ text: "Hello" }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 2, totalTokenCount: 9 } }));
    });
    const provider = new GeminiProvider("private-gemini-key", baseUrl);
    const result = await provider.chat({ model: "catalog-model", messages: [{ role: "system", content: "be brief" }, { role: "user", content: "hi" }] });
    expect(result).toMatchObject({ content: "Hello", model: "catalog-model", finishReason: "STOP", usage: { promptTokens: 7, completionTokens: 2, totalTokens: 9 } });
    expect(calls[0].url).toBe("/v1beta/models/catalog-model:generateContent");
    expect(calls[0].headers["x-goog-api-key"]).toBe("private-gemini-key");
    expect(calls[0].url).not.toContain("private-gemini-key");
    expect(JSON.parse(calls[0].body)).toMatchObject({ systemInstruction: { parts: [{ text: "be brief" }] }, contents: [{ role: "user", parts: [{ text: "hi" }] }] });
  });

  it("supports native Gemini function calls and formats tool responses on the next turn", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      const call = calls.length === 1;
      res.end(JSON.stringify(call
        ? { candidates: [{ content: { parts: [{ functionCall: { name: "projects_list", args: {} } }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 1, totalTokenCount: 4 } }
        : { candidates: [{ content: { parts: [{ text: "Project list received." }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 2, totalTokenCount: 7 } }));
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    const tools = [{ type: "function" as const, function: { name: "projects.list", description: "List projects", parameters: { type: "object", properties: { limit: { type: "integer", minimum: 1 } } } } }];
    const selected = await provider.chat({ model: "model-now", messages: [{ role: "user", content: "List projects" }], tools });
    expect(provider.supportsToolCalls).toBe(true);
    expect(selected.toolCalls).toEqual([{ id: "gemini-0", type: "function", function: { name: "projects.list", arguments: "{}" } }]);
    expect(JSON.parse(calls[0].body).tools).toEqual([{ functionDeclarations: [{ name: "projects_list", description: "List projects", parameters: { type: "OBJECT", properties: { limit: { type: "INTEGER" } } } }] }]);
    const final = await provider.chat({
      model: "model-now",
      messages: [
        { role: "user", content: "List projects" },
        { role: "assistant", content: "", tool_calls: selected.toolCalls },
        { role: "tool", name: "projects.list", tool_call_id: "gemini-0", content: JSON.stringify({ ok: true, data: { projects: [] } }) },
      ],
      tools,
    });
    expect(final.content).toBe("Project list received.");
    expect(JSON.parse(calls[1].body).contents).toEqual([
      { role: "user", parts: [{ text: "List projects" }] },
      { role: "model", parts: [{ functionCall: { name: "projects_list", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "projects_list", response: { ok: true, data: { projects: [] } } } }] },
    ]);
  });

  it("discovers models and streams actual text deltas from the native SSE endpoint", async () => {
    await listen((req, res) => {
      if (req.url === "/v1beta/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "models/model-now", supportedGenerationMethods: ["generateContent"] }] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "one " }] } }] })}\n\ndata: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: "two" }] } }], usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 } })}\n\n`);
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    expect(await provider.listModels()).toEqual([{ id: "model-now", label: "model-now" }]);
    const deltas: string[] = [];
    let reportedUsage: { promptTokens: number; completionTokens: number; totalTokens: number } | undefined;
    for await (const delta of provider.streamChat({ model: "model-now", messages: [{ role: "user", content: "hi" }], onUsage: (usage) => { reportedUsage = usage; } })) deltas.push(delta);
    expect(deltas.join("")).toBe("one two");
    expect(reportedUsage).toEqual({ promptTokens: 3, completionTokens: 2, totalTokens: 5 });
    expect(calls[1].url).toBe("/v1beta/models/model-now:streamGenerateContent?alt=sse");
  });

  it("probes only the selected model and invokes real generation instead of trusting key presence", async () => {
    await listen((req, res) => {
      if (req.url === "/v1beta/models") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ models: [{ name: "models/chosen-model", supportedGenerationMethods: ["generateContent"] }] }));
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "ok" }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } }));
      }
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    expect(await provider.healthCheck("chosen-model")).toBe(true);
    expect(await provider.healthCheck("chosen-model")).toBe(true);
    expect(calls.map((call) => call.url)).toEqual(["/v1beta/models", "/v1beta/models/chosen-model:generateContent"]);
  });

  it("sends recorded audio through Gemini generateContent and returns the provider transcript", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: "spoken words" }] } }], usageMetadata: { promptTokenCount: 4, candidatesTokenCount: 2, totalTokenCount: 6 } }));
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    const result = await provider.transcribeAudio({ model: "operator-model", mimeType: "audio/webm", base64: "AQID", language: "bn-BD" });
    expect(result.content).toBe("spoken words");
    const payload = JSON.parse(calls[0].body);
    expect(payload.contents[0].parts).toEqual([
      { text: "Transcribe the user's speech faithfully. Return only the spoken words, without commentary or markdown. The speaker's preferred language is bn-BD." },
      { inlineData: { mimeType: "audio/webm", data: "AQID" } },
    ]);
  });

  it("requests provider-generated speech from the explicitly selected model and voice", async () => {
    await listen((_req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ candidates: [{ content: { parts: [{ inlineData: { mimeType: "audio/L16;rate=24000", data: "AQIDBA==" } }] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 } }));
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    const result = await provider.synthesizeSpeech({ model: "operator-tts-model", text: "Hello", voice: "operator-voice" });
    expect(result).toMatchObject({ mimeType: "audio/L16;rate=24000", bytes: Buffer.from([1, 2, 3, 4]), usage: { promptTokens: 2, completionTokens: 3, totalTokens: 5 } });
    expect(JSON.parse(calls[0].body).generationConfig).toEqual({ responseModalities: ["AUDIO"], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: "operator-voice" } } } });
  });

  it("returns provider rejection as a typed failure instead of a fabricated answer", async () => {
    await listen((_req, res) => {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "quota/availability is controlled by the account", status: "RESOURCE_EXHAUSTED" } }));
    });
    const provider = new GeminiProvider("test-key", baseUrl);
    await expect(provider.chat({ model: "operator-selected-model", messages: [{ role: "user", content: "hi" }] })).rejects.toMatchObject({ provider: "Gemini", type: "rate_limit", status: 429 });
  });
});
