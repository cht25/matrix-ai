// =============================================================================
// Voice message → transcript → AI reply
//
// The production bug: a recorded voice message showed up as a bubble with its
// waveform and playback controls, but no request was ever made, so QORVYNA
// never answered. Cause: `send()` read `recorder.state` from the render closure
// that stopped the recording, where it is still "recording" — the recording had
// already been stopped, but the closure never saw "idle", so the dispatch was
// dropped silently.
//
// These tests pin the guard (unit) and the wiring that makes a dropped dispatch
// impossible to hide (source), plus the audio-format contract the upload route
// enforces, using the real `matchesAudioContainer` implementation.
// =============================================================================
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { voiceDispatchBlocker, VOICE_DISPATCH_BLOCKED_BUSY } from "../src/lib/client/voice-dispatch";
import { matchesAudioContainer } from "../src/lib/ai/audio";
import { extensionForMime, pickRecordingMimeType, sniffAudioMime } from "../src/lib/client/use-voice-recorder";

const ROOT = path.resolve(__dirname, "..");
const CHAT = readFileSync(path.join(ROOT, "src/components/chat-client.tsx"), "utf8");
const TRANSCRIBE_ROUTE = readFileSync(path.join(ROOT, "src/app/api/voice/transcribe/route.ts"), "utf8");
const AI_ROUTE = readFileSync(path.join(ROOT, "src/app/api/ai/route.ts"), "utf8");

const idle = {
  recorderState: "idle",
  voiceTurn: false,
  streaming: false,
  uploadingImage: false,
  requestInFlight: false,
};

describe("a finished voice turn is never blocked by the recorder it already stopped", () => {
  it("dispatches while the stale render still says 'recording'", () => {
    // This is the exact production state: the click handler that stopped the
    // recording still holds recorder.state === "recording".
    expect(voiceDispatchBlocker({ ...idle, recorderState: "recording", voiceTurn: true })).toBeNull();
    expect(voiceDispatchBlocker({ ...idle, recorderState: "requesting", voiceTurn: true })).toBeNull();
    expect(voiceDispatchBlocker({ ...idle, recorderState: "paused", voiceTurn: true })).toBeNull();
  });

  it("still refuses to start a second turn while one is streaming", () => {
    const blocker = voiceDispatchBlocker({ ...idle, voiceTurn: true, streaming: true });
    expect(blocker?.reason).toBe("busy");
    expect(blocker?.message).toBe(VOICE_DISPATCH_BLOCKED_BUSY);
    expect(voiceDispatchBlocker({ ...idle, voiceTurn: true, requestInFlight: true })?.reason).toBe("busy");
  });

  it("refuses typed input while the microphone is still recording", () => {
    expect(voiceDispatchBlocker({ ...idle, recorderState: "recording" })?.reason).toBe("recording");
    expect(voiceDispatchBlocker({ ...idle, recorderState: "paused" })?.reason).toBe("recording");
  });

  it("waits for an attachment upload instead of dropping the message", () => {
    expect(voiceDispatchBlocker({ ...idle, uploadingImage: true })?.reason).toBe("busy");
  });

  it("lets an ordinary idle turn through", () => {
    expect(voiceDispatchBlocker(idle)).toBeNull();
  });

  it("always explains a blocked dispatch in words the UI can show", () => {
    const blocked = [
      voiceDispatchBlocker({ ...idle, streaming: true }),
      voiceDispatchBlocker({ ...idle, uploadingImage: true }),
      voiceDispatchBlocker({ ...idle, recorderState: "recording" }),
    ];
    for (const blocker of blocked) {
      expect(blocker).not.toBeNull();
      expect(blocker!.message.length).toBeGreaterThan(10);
      expect(blocker!.message).toMatch(/[.!]$/);
    }
  });
});

describe("chat wiring — nothing is dropped silently", () => {
  it("reads the live recorder state, not the stale closure", () => {
    // The ref is refreshed on every render…
    expect(CHAT).toContain("const recorderStateRef = useRef(recorder.state);");
    expect(CHAT).toContain("recorderStateRef.current = recorder.state;");
    // …and the old closure read is gone from the send guard.
    expect(CHAT).not.toContain('if (!message || streaming || uploadingImage || requestInFlightRef.current || recorder.state !== "idle") return;');
    expect(CHAT).toContain("recorderState: recorderStateRef.current");
  });

  it("exempts a voice turn from the recorder guard", () => {
    expect(CHAT).toContain("voiceTurn: Boolean(turn.voice)");
    const sendStart = CHAT.indexOf("async function send(");
    const sendFn = CHAT.slice(sendStart, CHAT.indexOf("async function cancelBuildRun", sendStart));
    expect(sendFn).toContain("voiceDispatchBlocker({");
    // A typed message still says why it did not go out.
    expect(sendFn).toContain("if (!turn.voice) setNotice(blocker.message);");
  });

  it("releases the one-turn ledger when nothing was dispatched, so Retry works", () => {
    const voice = CHAT.slice(CHAT.indexOf("async function sendVoiceMessage"), CHAT.indexOf("function discardVoice"));
    // Claimed before dispatch, exactly once.
    expect(voice).toContain("if (!sentVoiceTurnsRef.current.claim(turnId)) return;");
    // Transcription failure / abort: released, recording kept, bubble explains.
    expect(voice).toMatch(/sentVoiceTurnsRef\.current\.release\(turnId\);\s*\n\s*patchVoice\(turnId, null, \{ voice_status: "failed", voice_error: result\.message \}\);/);
    // Blocked or refused dispatch: released, bubble explains.
    expect(voice).toContain("QORVYNA did not accept this message. Try again.");
    expect(voice).toContain("voice_status: \"failed\", voice_error: blocker.message");
  });

  it("never pairs a fallback transcript with audio the server did not transcribe", () => {
    const voice = CHAT.slice(CHAT.indexOf("async function sendVoiceMessage"), CHAT.indexOf("function discardVoice"));
    // A browser-recognised fallback cannot match the stored Whisper transcript,
    // so the asset is dropped for that turn instead of failing the whole reply.
    expect(voice).toContain("audioMismatch = Boolean(result.assetId);");
    expect(voice).toContain("assetId = null;");
    expect(voice).toContain("AUDIO_TRANSCRIPT_MISMATCH");
    expect(voice).toMatch(/await send\(undefined, transcript, \{ voice: \{ turnId, assetId, attachments: draft\.attachments \} \}\)/);
  });

  it("keeps the existing send path and one-response-per-recording ledger", () => {
    expect(CHAT).toContain('onStopVoice={() => void finishVoice(voiceStopIntent(voiceModeRef.current))}');
    expect(CHAT).toContain('onDictateOnly={() => void finishVoice("transcribe")}');
    expect(CHAT).toContain("voiceDraftsRef.current.has(turn) && !sentVoiceTurnsRef.current.has(turn)");
  });
});

describe("audio formats: what the browser records is what the upload accepts", () => {
  const ALLOWED = new Set([
    "audio/aac", "audio/flac", "audio/mp4", "audio/mpeg", "audio/mpga", "audio/ogg", "audio/opus",
    "audio/wav", "audio/webm", "audio/3gpp", "audio/x-aac", "audio/x-wav",
  ]);

  it("covers every container the recorder can produce", () => {
    const candidates = [
      pickRecordingMimeType(() => true),
      pickRecordingMimeType((type) => !type.includes("webm")),
      pickRecordingMimeType((type) => type.startsWith("audio/mp4")),
      pickRecordingMimeType(() => false),
    ];
    for (const candidate of candidates) {
      const base = (candidate || "audio/webm").split(";")[0];
      expect(ALLOWED.has(base), `recorder produced ${base}, route rejects it`).toBe(true);
      // …and the route really lists it (parsed, not assumed).
      expect(TRANSCRIBE_ROUTE).toContain(`"${base}"`);
    }
  });

  it("sniffs the real container and matches the route's byte checks", () => {
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(8)]);
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(4)]);
    const ogg = Buffer.concat([Buffer.from("OggS"), Buffer.alloc(8)]);
    const wav = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WAVE"), Buffer.alloc(4)]);

    expect(sniffAudioMime(new Uint8Array(webm))).toBe("audio/webm");
    expect(matchesAudioContainer(webm, "audio/webm")).toBe(true);
    expect(sniffAudioMime(new Uint8Array(mp4))).toBe("audio/mp4");
    expect(matchesAudioContainer(mp4, "audio/mp4")).toBe(true);
    expect(sniffAudioMime(new Uint8Array(ogg))).toBe("audio/ogg");
    expect(matchesAudioContainer(ogg, "audio/ogg")).toBe(true);
    expect(sniffAudioMime(new Uint8Array(wav))).toBe("audio/wav");
    expect(matchesAudioContainer(wav, "audio/wav")).toBe(true);

    // A renamed text file is rejected by both sides, never transcribed.
    const fake = Buffer.from("This is not audio at all");
    expect(sniffAudioMime(new Uint8Array(fake))).toBeNull();
    expect(matchesAudioContainer(fake, "audio/webm")).toBe(false);
  });

  it("files the upload under an extension the provider understands", () => {
    expect(extensionForMime("audio/webm")).toBe("webm");
    expect(extensionForMime("audio/mp4")).toBe("m4a");
    expect(extensionForMime("audio/ogg")).toBe("ogg");
    expect(extensionForMime("audio/wav")).toBe("wav");
  });

  it("keeps the route's own limits and error codes honest", () => {
    expect(TRANSCRIBE_ROUTE).toContain("const MAX_AUDIO_BYTES = 24 * 1024 * 1024;");
    expect(TRANSCRIBE_ROUTE).toContain('error: "AUDIO_REQUIRED"');
    expect(TRANSCRIBE_ROUTE).toContain('error: "AUDIO_TYPE_UNSUPPORTED"');
    expect(TRANSCRIBE_ROUTE).toContain('error: "AUDIO_CONTENT_INVALID"');
    expect(TRANSCRIBE_ROUTE).toContain('error: isEmpty ? "NO_SPEECH_DETECTED"');
    // The transcript the client reads back is the one the AI route re-checks.
    expect(TRANSCRIBE_ROUTE).toContain("transcript: out.transcript");
    expect(AI_ROUTE).toContain("saved.transcript.trim() !== message");
  });
});
