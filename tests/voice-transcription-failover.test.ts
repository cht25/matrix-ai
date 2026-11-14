import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ upload: vi.fn(), cloudinary: false }));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: async () => ({ uid: "voice-user-2" }) }));
vi.mock("@/lib/env", () => ({ isCloudinaryConfigured: () => mocks.cloudinary }));
vi.mock("@/lib/server/cloudinary", () => ({ uploadPrivateAudio: mocks.upload, downloadPrivateAudio: vi.fn(), deletePrivateAudio: vi.fn() }));

import { POST } from "@/app/api/voice/transcribe/route";

const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
function recording(extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(webm)], { type: "audio/webm" }), "test.webm");
  form.append("duration_ms", "1500");
  for (const [key, value] of Object.entries(extra)) form.append(key, value);
  return form;
}
async function post(form: FormData) {
  const response = await POST(new NextRequest("http://localhost/api/voice/transcribe", { method: "POST", headers: { Authorization: "Bearer t" }, body: form }));
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}

beforeEach(() => {
  mocks.cloudinary = false;
  mocks.upload.mockReset().mockResolvedValue({ publicId: "chat-audio/voice-user-2/clip", format: "webm", version: 1, bytes: webm.length });
  vi.stubEnv("GROQ_API_KEY", "gsk-test");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GEMINI_API_KEY", "");
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("voice transcription for the composer", () => {
  it("transcribes without audio storage configured (dictation works in Agent mode)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "একটি রেস্টুরেন্ট ওয়েবসাইট বানাও", language: "bengali" })));
    const result = await post(recording());
    expect(result.status).toBe(200);
    expect(result.data.transcript).toBe("একটি রেস্টুরেন্ট ওয়েবসাইট বানাও");
    expect(result.data.detected_language).toBe("bn");
    expect(result.data.audio_asset_id).toBeNull();
    expect(result.data.stored).toBe(false);
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("does not store audio when the client asks for transcription only", async () => {
    mocks.cloudinary = true;
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ text: "hello", language: "en" })));
    const result = await post(recording({ store: "0" }));
    expect(result.status).toBe(200);
    expect(result.data.audio_asset_id).toBeNull();
    expect(mocks.upload).not.toHaveBeenCalled();
  });

  it("passes the chosen language to the speech model, and nothing for auto-detect", async () => {
    const forms: FormData[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: string, opts: RequestInit) => { forms.push(opts.body as FormData); return Response.json({ text: "ঠিক আছে", language: "bn" }); }));
    expect((await post(recording({ language: "bn-BD" }))).data.requested_language).toBe("bn");
    expect(forms[0].get("language")).toBe("bn");
    await post(recording({ language: "auto" }));
    expect(forms[1].get("language")).toBeNull();
  });

  it("falls back to the next speech provider when the first one fails", async () => {
    vi.stubEnv("OPENAI_API_KEY", "sk-test-openai");
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes("groq.com")) return Response.json({ error: { message: "rate limited" } }, { status: 429 });
      return Response.json({ text: "fallback worked", language: "english" });
    }));
    const result = await post(recording());
    expect(result.status).toBe(200);
    expect(result.data.transcript).toBe("fallback worked");
    expect(urls.some((url) => url.includes("groq.com"))).toBe(true);
    expect(urls.some((url) => url.includes("api.openai.com"))).toBe(true);
  });

  it("reports a clear error when no speech provider is configured", async () => {
    vi.stubEnv("GROQ_API_KEY", "");
    const result = await post(recording());
    expect(result.status).toBe(503);
    expect(String(result.data.error)).toMatch(/NOT_CONFIGURED/);
  });
});
