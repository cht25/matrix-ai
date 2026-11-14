import { afterEach, describe, expect, it, vi } from "vitest";
import { matchesAudioContainer } from "@/lib/ai/audio";
import { revealReceived } from "@/lib/stream-reveal";

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
