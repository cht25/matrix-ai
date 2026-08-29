// A real local TCP server that speaks the OpenAI chat-completions contract so
// the REAL provider clients (real fetch, real streaming, real status codes)
// can be exercised end-to-end without external network access.
import { createServer, type Server } from "node:http";

export type StubBehavior =
  | { kind: "ok"; content: string; reasoningField?: string }
  | { kind: "ok_empty" }
  | { kind: "status"; status: number; body?: string; contentType?: string }
  | { kind: "stream"; deltas: string[]; endWithDone?: boolean }
  | { kind: "stream_then_die"; deltas: string[] }
  | { kind: "hang" };

export type StubCall = { method: string; url: string; auth: string; body: Record<string, unknown> | null };

export function startProviderStub(behaviorHolder: { current: StubBehavior }): Promise<{ server: Server; port: number; calls: StubCall[] }> {
  const calls: StubCall[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const behavior = behaviorHolder.current;
      calls.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: String(req.headers.authorization ?? ""),
        body: raw ? (JSON.parse(raw) as Record<string, unknown>) : null,
      });

      if ((req.url ?? "").includes("/models")) {
        // Deliberately succeeds WITHOUT requiring valid auth — exactly how
        // OpenRouter and most OpenAI-compatible proxies behave, which is what
        // makes a GET /models health check lie.
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "stub-model-1" }] }));
        return;
      }

      if (behavior.kind === "hang") return; // never respond — caller times out

      if (behavior.kind === "status") {        res.writeHead(behavior.status, { "Content-Type": behavior.contentType ?? "application/json" });
        res.end(behavior.body ?? JSON.stringify({ error: { message: `stub ${behavior.status}` } }));
        return;
      }
      if (behavior.kind === "ok" || behavior.kind === "ok_empty") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            model: "stub-model-1",
            choices: [{
              message: {
                content: behavior.kind === "ok" ? behavior.content : null,
                ...(behavior.kind === "ok" && behavior.reasoningField ? { reasoning: behavior.reasoningField } : {}),
              },
              finish_reason: "stop",
            }],
            usage: { prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 },
          }),
        );
        return;
      }
      if (behavior.kind === "stream" || behavior.kind === "stream_then_die") {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        for (const delta of behavior.deltas) {
          res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta } }] })}\n\n`);
        }
        if (behavior.kind === "stream" && behavior.endWithDone !== false) {
          res.write("data: [DONE]\n\n");
        }
        res.end();
        return;
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({ server, port: (server.address() as { port: number }).port, calls });
    });
  });
}
