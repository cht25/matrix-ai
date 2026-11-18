// =============================================================================
// /api/voice/transcribe — real request/response, mocked ONLY at the edges
//
// The route itself runs unmodified: multipart parsing, container sniffing, the
// provider multipart request, `verbose_json` parsing, hallucination rejection,
// usage logging and the response the chat client reads. Only the things this
// sandbox cannot have are replaced:
//
//   • Firebase (no service account here) — session + admin DB;
//   • Cloudinary (private storage) — nothing is stored in these tests;
//   • the speech provider — a real HTTP server on 127.0.0.1 answering
//     `/v1/audio/transcriptions`, reached through OPENAI_BASE_URL.
//
// So the bytes really travel: browser-shaped FormData → route → provider.
// =============================================================================
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/firebase/session", () => ({
  getSessionUser: async () => ({ uid: "user-voice-1", email: "v@example.com" }),
}));

const usageLogs: Array<Record<string, unknown>> = [];
vi.mock("@/lib/firebase/admin", () => ({
  adminDb: () => ({
    collection: (name: string) => ({
      add: async (doc: Record<string, unknown>) => {
        usageLogs.push({ collection: name, ...doc });
        return { id: "log" };
      },
      doc: () => ({
        create: async () => undefined,
        set: async () => undefined,
        get: async () => ({ exists: false, data: () => undefined }),
      }),
    }),
  }),
  nowTs: () => ({ __ts: true }),
}));

vi.mock("@/lib/env", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/env")>("../src/lib/env");
  return { ...actual, isCloudinaryConfigured: () => false };
});

vi.mock("@/lib/server/voice-cleanup", () => ({ cleanupStaleVoiceDrafts: async () => {} }));
vi.mock("@/lib/server/cloudinary", () => ({
  uploadPrivateAudio: async () => {
    throw new Error("storage must not be used in these tests");
  },
  downloadPrivateAudio: async () => null,
  deletePrivateAudio: async () => undefined,
}));

type ProviderReply = { status: number; body: unknown; raw?: string };

const provider: {
  reply: ProviderReply;
  requests: Array<{ headers: IncomingMessage["headers"]; body: string }>;
} = {
  reply: { status: 200, body: { text: "hello", language: "en" } },
  requests: [],
};

let server: Server;
let baseUrl = "";

beforeAll(async () => {
  server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(chunk as Buffer));
    req.on("end", () => {
      provider.requests.push({ headers: req.headers, body: Buffer.concat(chunks).toString("latin1") });
      res.writeHead(provider.reply.status, { "Content-Type": "application/json" });
      res.end(provider.reply.raw ?? JSON.stringify(provider.reply.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  baseUrl = `http://127.0.0.1:${address.port}/v1`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  provider.requests = [];
  provider.reply = { status: 200, body: { text: "hello", language: "en" } };
  usageLogs.length = 0;
  vi.unstubAllEnvs();
});

/** Real WebM/EBML header plus payload — what Chrome's MediaRecorder produces. */
function webmAudio(payload = "opus-payload"): ArrayBuffer {
  const bytes = new Uint8Array([
    0x1a, 0x45, 0xdf, 0xa3, 0x9f, 0x42, 0x86, 0x81, 0x01, 0x42, 0xf7, 0x81, 0x01,
    ...Buffer.from(payload),
  ]);
  return bytes.buffer as ArrayBuffer;
}

function mp4Audio(): ArrayBuffer {
  const bytes = new Uint8Array([
    0x00, 0x00, 0x00, 0x18, ...Buffer.from("ftypisom"), 0x00, 0x00, 0x02, 0x00,
    ...Buffer.from("isomiso2mp41"),
  ]);
  return bytes.buffer as ArrayBuffer;
}

async function callRoute(input: {
  file?: ArrayBuffer;
  type?: string;
  name?: string;
  extra?: Record<string, string>;
  origin?: string | null;
}) {
  const form = new FormData();
  if (input.file) {
    form.append(
      "audio",
      new File([input.file], input.name ?? "voice.webm", { type: input.type ?? "audio/webm" }),
    );
  }
  form.append("language", input.extra?.language ?? "auto");
  form.append("store", input.extra?.store ?? "0");
  for (const [key, value] of Object.entries(input.extra ?? {})) {
    if (key !== "language" && key !== "store") form.append(key, value);
  }
  const headers: Record<string, string> = {};
  const origin = input.origin === undefined ? "http://localhost:3000" : input.origin;
  if (origin) headers.origin = origin;
  const { POST } = await import("../src/app/api/voice/transcribe/route");
  const request = new Request("http://localhost:3000/api/voice/transcribe", {
    method: "POST",
    headers,
    body: form,
  });
  // The route's NextRequest type is a Request at runtime for our purposes.
  const response = await POST(request as never);
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: response.status, json };
}

describe("/api/voice/transcribe — a real recording becomes a transcript", () => {
  it("sends the audio to the provider and returns the transcript", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    provider.reply = { status: 200, body: { text: "open the settings page", language: "en" } };

    const { status, json } = await callRoute({ file: webmAudio("real-opus-bytes") });

    expect(status).toBe(200);
    expect(json.transcript).toBe("open the settings page");
    expect(json.provider).toBe("OpenAI");
    expect(json.model).toBe("whisper-1");
    expect(json.detected_language).toBe("en");
    expect(json.stored).toBe(false);
    expect(json.audio_asset_id).toBeNull();

    // The provider really received a multipart body with the audio intact.
    expect(provider.requests).toHaveLength(1);
    const body = provider.requests[0].body;
    expect(body).toContain('name="file"');
    expect(body).toContain('filename="voice.webm"');
    expect(body).toContain("real-opus-bytes");
    expect(body).toContain('name="model"');
    expect(body).toContain("whisper-1");
    expect(body).toContain("verbose_json");
    // Bearer auth is the configured key, never a placeholder.
    expect(provider.requests[0].headers.authorization).toBe("Bearer test-key-not-a-secret");

    // Usage is logged as a transcription, not as chat.
    expect(usageLogs.some((entry) => entry.request_type === "voice_transcription" && entry.status === "ok")).toBe(true);
  });

  it("keeps a Bangla transcript byte-for-byte", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    const bangla = "আমার ভয়েস মেসেজটি বুঝতে পারছো?";
    provider.reply = { status: 200, body: { text: bangla, language: "bn" } };

    const { status, json } = await callRoute({ file: webmAudio(), type: "audio/webm" });
    expect(status).toBe(200);
    expect(json.transcript).toBe(bangla);
    expect(json.detected_language).toBe("bn");
  });

  it("accepts an iOS/macOS MP4 recording", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    provider.reply = { status: 200, body: { text: "hello from safari", language: "en" } };

    const { status, json } = await callRoute({ file: mp4Audio(), type: "audio/mp4", name: "voice.m4a" });
    expect(status).toBe(200);
    expect(json.transcript).toBe("hello from safari");
    expect(provider.requests[0].body).toContain('filename="voice.m4a"');
  });

  it("refuses an audio type it cannot transcribe, before any provider call", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    const { status, json } = await callRoute({ file: webmAudio(), type: "video/x-matroska" });
    expect(status).toBe(415);
    expect(json.error).toBe("AUDIO_TYPE_UNSUPPORTED");
    expect(provider.requests).toHaveLength(0);
  });

  it("refuses a renamed file whose bytes are not that container", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    const { status, json } = await callRoute({
      file: new TextEncoder().encode("this is not audio, it is text").buffer as ArrayBuffer,
      type: "audio/webm",
    });
    expect(status).toBe(415);
    expect(json.error).toBe("AUDIO_CONTENT_INVALID");
    expect(provider.requests).toHaveLength(0);
  });

  it("requires an audio part", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    const { status, json } = await callRoute({});
    expect(status).toBe(400);
    expect(json.error).toBe("AUDIO_REQUIRED");
  });

  it("reports silence as NO_SPEECH_DETECTED instead of inventing words", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    provider.reply = { status: 200, body: { text: "   ", language: "en" } };
    const { status, json } = await callRoute({ file: webmAudio() });
    expect(status).toBe(422);
    expect(json.error).toBe("NO_SPEECH_DETECTED");
  });

  it("drops the classic Whisper silence hallucination", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    provider.reply = {
      status: 200,
      body: {
        text: "Thank you for watching!",
        language: "en",
        segments: [{ no_speech_prob: 0.92, avg_logprob: -1.4, text: "Thank you for watching!" }],
      },
    };
    const { status, json } = await callRoute({ file: webmAudio() });
    expect(status).toBe(422);
    expect(json.error).toBe("NO_SPEECH_DETECTED");
  });

  it("maps a provider outage to a retryable status, never a fake transcript", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    provider.reply = { status: 500, body: { error: { message: "upstream exploded" } } };
    const { status, json } = await callRoute({ file: webmAudio() });
    expect([502, 503]).toContain(status);
    expect(typeof json.error).toBe("string");
    expect(json.error).not.toBe("NO_SPEECH_DETECTED");
    expect(JSON.stringify(json)).not.toContain("upstream exploded");
  });

  it("answers 503 when no speech provider is configured at all", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("GROQ_API_KEY", "");
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const { status, json } = await callRoute({ file: webmAudio() });
    expect(status).toBe(503);
    expect(json.error).toBe("VOICE_TRANSCRIPTION_NOT_CONFIGURED");
    expect(provider.requests).toHaveLength(0);
  });

  it("is a cookie-authenticated mutation: a cross-site POST is refused", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    const { status, json } = await callRoute({ file: webmAudio(), origin: "https://evil.example" });
    expect(status).toBe(403);
    expect(JSON.stringify(json)).toContain("BAD_ORIGIN");
    expect(provider.requests).toHaveLength(0);
  });

  it("accepts a native client that presents a bearer token and no Origin", async () => {
    vi.stubEnv("OPENAI_API_KEY", "test-key-not-a-secret");
    vi.stubEnv("OPENAI_BASE_URL", baseUrl);
    provider.reply = { status: 200, body: { text: "from the desktop app", language: "en" } };
    const form = new FormData();
    form.append("audio", new File([webmAudio()], "voice.webm", { type: "audio/webm" }));
    form.append("language", "auto");
    form.append("store", "0");
    const { POST } = await import("../src/app/api/voice/transcribe/route");
    const request = new Request("http://localhost:3000/api/voice/transcribe", {
      method: "POST",
      headers: { authorization: "Bearer native-id-token" },
      body: form,
    });
    const response = await POST(request as never);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ transcript: "from the desktop app" });
  });
});
