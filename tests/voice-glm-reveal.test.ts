import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesAudioContainer } from "@/lib/ai/audio";
import { revealReceived } from "@/lib/stream-reveal";
import { createAIRoutesFromDb, resolveSelectedAIRoute } from "@/lib/ai/config";
import { GLMProvider } from "@/lib/ai/glm";
import { completeWithFallback, streamWithFallback } from "@/lib/ai/executor";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe("private voice upload boundaries", () => {
  it("accepts real browser WebM, iOS MP4 and Ogg headers, not renamed text", () => {
    expect(matchesAudioContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]), "audio/webm")).toBe(true);
    expect(matchesAudioContainer(Buffer.from("\0\0\0\x18ftypisom"), "audio/mp4")).toBe(true);
    expect(matchesAudioContainer(Buffer.from("OggSabcdefgh"), "audio/ogg")).toBe(true);
    expect(matchesAudioContainer(Buffer.from("This is not audio"), "audio/webm")).toBe(false);
    expect(matchesAudioContainer(Buffer.from("OggSabcdefgh"), "audio/mp4")).toBe(false);
  });
});

describe("arriving text reveal", () => {
  it("never displays text that has not arrived; supports modes and cumulative deltas", () => {
    expect(revealReceived("অভিবাদন Hello! مرحبا", "", "adaptive")).toBe("অভ");
    expect(revealReceived("Hello world", "", "word")).toBe("Hello ");
    expect(revealReceived("こんにちは 世界", "", "natural")).toBe("こんにちは 世界");
    expect(revealReceived("Привет", "", "reduced")).toBe("Привет");
    let visible = "";
    const incoming = "नमस्ते বাংলা English العربية español français deutsch 中文 日本語 한국어 português Türkçe русский bahasa Indonesia";
    for (let i = 0; i < 300 && visible !== incoming; i++) {
      visible = revealReceived(incoming, visible, "adaptive");
      expect(incoming.startsWith(visible)).toBe(true);
    }
    expect(visible).toBe(incoming);
  });
});

describe("authoritative Z.AI routing", () => {
  it("uses exact default for Chat and Agent, never silently uses configured OSS", async () => {
    vi.stubEnv("GLM_API_KEY", ""); vi.stubEnv("ZAI_API_KEY", "zai-test-key");
    vi.stubEnv("GROQ_API_KEY", "gsk-test-key"); vi.stubEnv("GLM_MODEL", ""); vi.stubEnv("GLM_CODING_MODEL", "");
    for (const coding of [false, true]) {
      const targets = await createAIRoutesFromDb(null, coding);
      expect(targets).toHaveLength(1);
      expect(targets[0]).toMatchObject({ provider: "GLM", model: "glm-5-turbo" });
    }
    vi.stubEnv("ZAI_API_KEY", "");
    expect(await createAIRoutesFromDb(null, false)).toHaveLength(0);
    expect(await createAIRoutesFromDb(null, true)).toHaveLength(0);
  });

  it("posts Bearer-authorized GLM-5-Turbo with real streaming deltas and tool calls", async () => {
    const calls: Array<{ url: string; auth: string; body: Record<string, unknown> }> = [];
    vi.stubEnv("ZAI_API_KEY", "zai-test-key"); vi.stubEnv("GLM_MODEL", ""); vi.stubEnv("GLM_CODING_MODEL", "");
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      const body = JSON.parse(String(opts.body)) as Record<string, unknown>;
      calls.push({ url, auth: (opts.headers as Record<string, string>).Authorization, body });
      if (body.stream) return new Response(new ReadableStream({ start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"مرحبا "}}]}\n\n'));
        controller.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"বাংলা"}}]}\n\n'));
        controller.enqueue(enc.encode("data: [DONE]\n\n")); controller.close();
      } }), { status: 200 });
      return new Response(JSON.stringify({ choices: [{ message: { content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "write_file", arguments: '{"path":"a.ts","content":"ok"}' } }] } }] }), { status: 200 });
    }));
    const [target] = await createAIRoutesFromDb(null, true);
    const completed = await completeWithFallback([target], { messages: [{ role: "user", content: "build" }] });
    expect(completed.response.toolCalls?.[0].function.name).toBe("write_file");
    const received: string[] = [];
    for await (const item of streamWithFallback([target], { messages: [{ role: "user", content: "বাংলা English" }] }, () => {})) received.push(item.delta);
    expect(received.join("")).toBe("مرحبا বাংলা");
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.auth === "Bearer zai-test-key" && call.body.model === "glm-5-turbo" && call.url === "https://api.z.ai/api/paas/v4/chat/completions")).toBe(true);
  });
});
