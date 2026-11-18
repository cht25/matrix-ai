// =============================================================================
// Stored voice audio can be attached to a message only when the text the user
// sees IS the transcript the speech service produced for that exact audio.
//
// This is the rule /api/build applies through `sendableVoiceAsset`, exercised
// here against a fake Firestore so the ownership, one-message and transcript
// checks are real code paths rather than a source grep.
// =============================================================================
import { describe, expect, it } from "vitest";
import { sendableVoiceAsset, VOICE_ASSET_ID } from "../src/lib/server/voice-assets";
import type { Db } from "../src/lib/firebase/admin";

const ASSET_ID = "8d1f6b4e-1f2a-4c3d-9e8f-0a1b2c3d4e5f";

function fakeDb(records: Record<string, Record<string, unknown> | undefined>): Db {
  return {
    collection: (name: string) => ({
      doc: (id: string) => ({
        get: async () => {
          const data = name === "chat_audio_assets" ? records[id] : undefined;
          return { exists: Boolean(data), data: () => data };
        },
      }),
    }),
  } as unknown as Db;
}

const asset = (overrides: Record<string, unknown> = {}) => ({
  user_id: "user-1",
  storage_public_id: `chat-audio/user-1/${ASSET_ID}`,
  transcription_status: "complete",
  transcript: "turn on the lights in the kitchen",
  duration_ms: 4200,
  waveform: [3, 40, 55, 21],
  detected_language: "en",
  ...overrides,
});

describe("voice asset → message attachment", () => {
  it("accepts the owner's completed transcript and returns playback metadata", async () => {
    const result = await sendableVoiceAsset(
      fakeDb({ [ASSET_ID]: asset() }),
      "user-1",
      ASSET_ID,
      "turn on the lights in the kitchen",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.metadata.audio_asset_id).toBe(ASSET_ID);
    expect(result.metadata.audio_duration_ms).toBe(4200);
    expect(result.metadata.audio_waveform).toEqual([3, 40, 55, 21]);
    expect(result.metadata.audio_language).toBe("en");
  });

  it("tolerates surrounding whitespace, never different words", async () => {
    const db = fakeDb({ [ASSET_ID]: asset() });
    await expect(
      sendableVoiceAsset(db, "user-1", ASSET_ID, "  turn on the lights in the kitchen \n"),
    ).resolves.toMatchObject({ ok: true });
    await expect(
      sendableVoiceAsset(db, "user-1", ASSET_ID, "turn on the lights in the bedroom"),
    ).resolves.toMatchObject({ ok: false, code: "AUDIO_TRANSCRIPT_MISMATCH" });
  });

  it("rejects audio that was never transcribed, or transcribed as something else", async () => {
    await expect(
      sendableVoiceAsset(fakeDb({ [ASSET_ID]: asset({ transcription_status: "processing" }) }), "user-1", ASSET_ID, "turn on the lights in the kitchen"),
    ).resolves.toMatchObject({ ok: false, code: "AUDIO_TRANSCRIPT_MISMATCH" });
    await expect(
      sendableVoiceAsset(fakeDb({ [ASSET_ID]: asset({ transcript: "" }) }), "user-1", ASSET_ID, ""),
    ).resolves.toMatchObject({ ok: false, code: "AUDIO_TRANSCRIPT_MISMATCH" });
  });

  it("never lets another account attach someone else's recording", async () => {
    await expect(
      sendableVoiceAsset(fakeDb({ [ASSET_ID]: asset() }), "user-2", ASSET_ID, "turn on the lights in the kitchen"),
    ).resolves.toMatchObject({ ok: false, code: "AUDIO_NOT_FOUND" });
    await expect(sendableVoiceAsset(fakeDb({}), "user-1", ASSET_ID, "x")).resolves.toMatchObject({
      ok: false,
      code: "AUDIO_NOT_FOUND",
    });
  });

  it("binds one recording to one message", async () => {
    await expect(
      sendableVoiceAsset(fakeDb({ [ASSET_ID]: asset({ conversation_id: "conv-1" }) }), "user-1", ASSET_ID, "turn on the lights in the kitchen"),
    ).resolves.toMatchObject({ ok: false, code: "AUDIO_ALREADY_SENT" });
  });

  it("rejects anything that is not a 36-character asset id", () => {
    expect(VOICE_ASSET_ID.test(ASSET_ID)).toBe(true);
    expect(VOICE_ASSET_ID.test("../../chat_audio_assets")).toBe(false);
    expect(VOICE_ASSET_ID.test("short")).toBe(false);
  });
});
