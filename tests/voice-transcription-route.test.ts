import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  user: { uid: "voice-user-1" } as { uid: string } | null,
  upload: vi.fn(), download: vi.fn(), delete: vi.fn(),
}));
vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});
vi.mock("@/lib/firebase/session", () => ({ getSessionUser: async () => mocks.user }));
vi.mock("@/lib/env", () => ({ isCloudinaryConfigured: () => true }));
vi.mock("@/lib/server/cloudinary", () => ({ uploadPrivateAudio: mocks.upload, downloadPrivateAudio: mocks.download, deletePrivateAudio: mocks.delete }));

import { POST } from "@/app/api/voice/transcribe/route";
import { sharedFirestoreStub } from "./helpers/firestore-stub";

const db = sharedFirestoreStub();
const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
async function post(form: FormData) {
  const response = await POST(new NextRequest("http://localhost/api/voice/transcribe", { method: "POST", headers: { Authorization: "Bearer test-token" }, body: form }));
  return { status: response.status, data: await response.json() as Record<string, unknown> };
}
function recording(data: Buffer = webm, type = "audio/webm") {
  const form = new FormData();
  form.append("audio", new Blob([new Uint8Array(data)], { type }), "test.webm");
  form.append("duration_ms", "2120"); form.append("waveform", "12,22,36,12");
  return form;
}
beforeEach(() => {
  mocks.user = { uid: "voice-user-1" };
  vi.stubEnv("GROQ_API_KEY", "gsk-test-stt");
  mocks.upload.mockReset().mockResolvedValue({ publicId: "chat-audio/voice-user-1/clip", format: "webm", version: 1, bytes: webm.length });
  mocks.download.mockReset().mockResolvedValue({ bytes: webm, contentType: "audio/webm" });
  mocks.delete.mockReset().mockResolvedValue(true);
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("authenticated multilingual STT and private voice retry", () => {
  it("rejects renamed text before upload; requires session", async () => {
    expect((await post(recording(Buffer.from("not a recording")))).status).toBe(415);
    expect(mocks.upload).not.toHaveBeenCalled();
    mocks.user = null;
    expect((await post(recording())).status).toBe(401);
  });

  it.each([
    ["bn", "বাংলা কথার নমুনা"], ["en", "Hello world."], ["bn", "আমি বলছি English words."],
    ["ar", "مرحبا"], ["hi", "नमस्ते"], ["ur", "سلام"], ["es", "Hola"], ["fr", "Bonjour"], ["de", "Hallo"],
    ["zh", "你好"], ["ja", "こんにちは"], ["ko", "안녕하세요"], ["pt", "Olá"], ["tr", "Merhaba"], ["ru", "Привет"], ["id", "Halo"],
  ])("preserves provider transcript and detected language for %s", async (language, transcript) => {
    const calls: { url: string; form: FormData; auth: string }[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string, opts: RequestInit) => {
      calls.push({ url, form: opts.body as FormData, auth: (opts.headers as Record<string, string>).Authorization });
      return Response.json({ text: transcript, language });
    }));
    const result = await post(recording());
    expect(result.status).toBe(200);
    expect(result.data.transcript).toBe(transcript);
    expect(result.data.detected_language).toBe(language);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(calls[0].auth).toBe("Bearer gsk-test-stt");
    expect(calls[0].form.get("language")).toBeNull();
    expect(calls[0].form.get("response_format")).toBe("verbose_json");
    const saved = db.dump()[`chat_audio_assets/${result.data.audio_asset_id}`];
    expect(saved).toMatchObject({ user_id: "voice-user-1", transcript, detected_language: language, transcription_status: "complete", duration_ms: 2120, waveform: [12, 22, 36, 12] });
  });

  it("keeps original asset after provider failure, retries without a second upload and rejects other owners", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(Response.json({ error: { message: "rate limited" } }, { status: 429 }))
      .mockResolvedValueOnce(Response.json({ text: "বাংলা English", language: "bn" })));
    const first = await post(recording());
    expect(first.status).toBe(503);
    expect(first.data.audio_asset_id).toBeTruthy();
    expect(db.dump()[`chat_audio_assets/${first.data.audio_asset_id}`].transcription_status).toBe("failed");
    const retry = new FormData(); retry.append("audio_asset_id", String(first.data.audio_asset_id));
    mocks.user = { uid: "other-user" };
    expect((await post(retry)).status).toBe(404);
    mocks.user = { uid: "voice-user-1" };
    const second = await post(retry);
    expect(second.status).toBe(200);
    expect(second.data.audio_asset_id).toBe(first.data.audio_asset_id);
    expect(mocks.upload).toHaveBeenCalledTimes(1);
    expect(mocks.download).toHaveBeenCalledTimes(1);
  });
});
