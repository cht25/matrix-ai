import { describe, expect, it } from "vitest";
import {
  VOICE_LANGUAGES, chooseVoiceEngine, formatClock, isRtlText, languageLabel, mergeTranscript,
  normalizeDetectedLanguage, voiceErrorMessage, voiceLanguage, whisperLanguageHint,
} from "@/lib/voice-input";

const env = { speechRecognition: true, mediaRecorder: true, mobile: false, online: true };

describe("voice input helpers", () => {
  it("offers auto-detect plus Bangla, English, Hindi, Arabic and Urdu", () => {
    const codes = VOICE_LANGUAGES.map((language) => language.code);
    expect(codes[0]).toBe("auto");
    for (const prefix of ["bn", "en", "hi", "ar", "ur"]) expect(codes.some((code) => code.startsWith(prefix))).toBe(true);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it("falls back to auto-detect for unknown or missing language codes", () => {
    expect(voiceLanguage("xx-YY").code).toBe("auto");
    expect(voiceLanguage(null).code).toBe("auto");
  });

  it("derives an ISO-639-1 Whisper hint, and none for auto-detect", () => {
    expect(whisperLanguageHint("auto")).toBe("");
    expect(whisperLanguageHint("")).toBe("");
    expect(whisperLanguageHint("bn-BD")).toBe("bn");
    expect(whisperLanguageHint("en-US")).toBe("en");
    expect(whisperLanguageHint("../../etc")).toBe("");
  });

  it("normalises provider language names to codes", () => {
    expect(normalizeDetectedLanguage("bengali")).toBe("bn");
    expect(normalizeDetectedLanguage("English")).toBe("en");
    expect(normalizeDetectedLanguage("bn")).toBe("bn");
    expect(normalizeDetectedLanguage("")).toBeNull();
    expect(languageLabel("bn")).toMatch(/Bangla|বাংলা/);
  });

  it("detects right-to-left text for Arabic and Urdu but not Bangla or English", () => {
    expect(isRtlText("مرحبا بالعالم")).toBe(true);
    expect(isRtlText("آپ کیسے ہیں")).toBe(true);
    expect(isRtlText("আমি বাংলায় কথা বলি")).toBe(false);
    expect(isRtlText("Hello world")).toBe(false);
  });

  it("always records audio when it can, so server transcription remains available", () => {
    expect(chooseVoiceEngine("auto", env)).toMatchObject({ engine: "server", live: false });
    expect(chooseVoiceEngine("en-US", { ...env, speechRecognition: false })).toMatchObject({ engine: "server", live: false });
    expect(chooseVoiceEngine("en-US", { ...env, mediaRecorder: false }).engine).toBe("browser");
    expect(chooseVoiceEngine("en-US", { ...env, mediaRecorder: false, speechRecognition: false }).engine).toBeNull();
    expect(chooseVoiceEngine("en-US", { ...env, online: false }).live).toBe(false);
  });

  it("appends dictated text to what is already typed without duplicating spaces", () => {
    expect(mergeTranscript("", "  hello  ")).toBe("hello");
    expect(mergeTranscript("Build a site", "with a blue header")).toBe("Build a site with a blue header");
    expect(mergeTranscript("Line one\n", "line two")).toBe("Line one\nline two");
    expect(mergeTranscript("kept", "   ")).toBe("kept");
  });

  it("formats the recording clock", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(-4)).toBe("0:00");
  });

  it("explains failures in plain language without leaking raw codes", () => {
    expect(voiceErrorMessage("NotAllowedError")).toMatch(/microphone/i);
    expect(voiceErrorMessage("not-allowed")).toMatch(/microphone/i);
    expect(voiceErrorMessage("NotFoundError")).toMatch(/microphone/i);
    expect(voiceErrorMessage("SPEECH_PROVIDER_NOT_CONFIGURED")).not.toContain("SPEECH_PROVIDER_NOT_CONFIGURED");
    expect(voiceErrorMessage("something-new").length).toBeGreaterThan(10);
  });
});
