import type { AIProvider, AIProviderRequest, AIProviderResponse } from "@/lib/ai/groq";
import { fetchModelCatalog } from "@/lib/ai/model-catalog";
import { providerErrorFromException, providerErrorFromResponse } from "@/lib/ai/provider-error";

export const ANTHROPIC_API_BASE_URL = "https://api.anthropic.com/v1";

/** Native Messages API; Anthropic is not represented as an OpenAI endpoint. */
export class AnthropicProvider implements AIProvider {
  constructor(private readonly apiKey: string, private readonly baseUrl = ANTHROPIC_API_BASE_URL) {}
  private headers() { return { "x-api-key": this.apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" }; }
  async listModels() { return (await fetchModelCatalog({ baseUrl: this.baseUrl, headers: this.headers(), provider: "Anthropic" })).models; }
  async healthCheck(): Promise<boolean> { try { return (await this.listModels()).length > 0; } catch { return false; } }
  private body(req: AIProviderRequest, stream: boolean) {
    if (req.imageDataUrl && !/^data:image\/(png|jpeg|webp|gif);base64,/.test(req.imageDataUrl)) throw new Error("Unsupported image format");
    return {
      model: req.model, max_tokens: Math.min(req.maxTokens ?? 2048, 8192), temperature: Math.min(req.temperature ?? 0.5, 1), stream,
      ...(req.messages.some((m) => m.role === "system") ? { system: req.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n") } : {}),
      messages: req.messages.filter((m) => m.role !== "system").map((m, i, all) => ({ role: m.role, content: i === all.length - 1 && req.imageDataUrl ? [
        { type: "text", text: m.content },
        { type: "image", source: { type: "base64", media_type: req.imageDataUrl.slice(5, req.imageDataUrl.indexOf(";")), data: req.imageDataUrl.slice(req.imageDataUrl.indexOf(",") + 1) } },
      ] : m.content })),
    };
  }
  async chat(req: AIProviderRequest): Promise<AIProviderResponse> {
    try {
      const res = await fetch(`${this.baseUrl}/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify(this.body(req, false)), redirect: "error", signal: req.signal ?? AbortSignal.timeout(60_000) });
      if (!res.ok) throw providerErrorFromResponse("Anthropic", req.model, res, await res.text());
      const data = await res.json() as { content?: { type: string; text?: string }[]; model?: string; stop_reason?: string; usage?: { input_tokens?: number; output_tokens?: number } };
      const promptTokens = data.usage?.input_tokens ?? 0;
      const completionTokens = data.usage?.output_tokens ?? 0;
      return { content: (data.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join(""), model: data.model ?? req.model, finishReason: data.stop_reason, usage: { promptTokens, completionTokens, totalTokens: promptTokens + completionTokens } };
    } catch (error) { throw providerErrorFromException("Anthropic", req.model, error, req.requestId); }
  }
  async *streamChat(req: AIProviderRequest): AsyncGenerator<string> {
    let response: Response;
    try { response = await fetch(`${this.baseUrl}/messages`, { method: "POST", headers: this.headers(), body: JSON.stringify(this.body(req, true)), redirect: "error", signal: req.signal ?? AbortSignal.timeout(120_000) }); }
    catch (error) { throw providerErrorFromException("Anthropic", req.model, error, req.requestId); }
    if (!response.ok) throw providerErrorFromResponse("Anthropic", req.model, response, await response.text());
    if (!response.body) throw new Error("Anthropic returned no stream");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", finished = false;
    try {
      while (!finished) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value, { stream: !done });
        const events = buffer.split(/\r?\n\r?\n/);
        buffer = events.pop() ?? "";
        for (const event of events) {
          const data = event.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
          if (!data) continue;
          const item = JSON.parse(data) as { type: string; delta?: { type: string; text?: string }; error?: { message?: string } };
          if (item.type === "error") throw new Error(item.error?.message ?? "Anthropic stream failed");
          if (item.type === "content_block_delta" && item.delta?.type === "text_delta") yield item.delta.text ?? "";
          if (item.type === "message_stop") { finished = true; break; }
        }
        if (done) break;
      }
      if (!finished) throw new Error("Anthropic stream ended before message_stop");
    } catch (error) { throw providerErrorFromException("Anthropic", req.model, error, req.requestId); }
    finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}
