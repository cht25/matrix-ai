import { describe, expect, it } from "vitest";
import { isOwnedChatAudioPath, pcm16ToWav } from "@/lib/ai/audio";

describe("AI speech audio framing", () => {
  it("only permits playback paths beneath the authenticated owner's audio folder", () => {
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/123-abc-recording")).toBe(true);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-2/123-recording")).toBe(false);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/../other/file")).toBe(false);
    expect(isOwnedChatAudioPath("uid-1", "chat-audio/uid-1/")).toBe(false);
  });
  it("wraps provider PCM bytes in a WAV header using the provider-declared rate", () => {
    const wav = pcm16ToWav(Buffer.from([1, 2, 3, 4]), "audio/L16;rate=24000");
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.subarray(8, 12).toString()).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24_000);
    expect(wav.readUInt32LE(40)).toBe(4);
    expect(wav.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects malformed PCM and missing provider sample-rate metadata", () => {
    expect(() => pcm16ToWav(Buffer.from([1]), "audio/L16;rate=24000")).toThrow("GEMINI_AUDIO_FORMAT_UNSUPPORTED");
    expect(() => pcm16ToWav(Buffer.from([1, 2]), "audio/L16")).toThrow("GEMINI_AUDIO_FORMAT_UNSUPPORTED");
    expect(() => pcm16ToWav(Buffer.from([1, 2]), "audio/mpeg")).toThrow("GEMINI_AUDIO_FORMAT_UNSUPPORTED");
  });
});
