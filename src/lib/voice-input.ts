// =============================================================================
// MATRIX voice input — shared, framework-free helpers
//
// Voice input lives inside the chat composer (all modes, including Agent):
//
//   mic → live waveform + timer → stop → transcript appears in the composer
//   as editable text → the user reviews/edits → Send.
//
// Two engines produce the transcript:
//   • browser  — the Web Speech API (`SpeechRecognition`), where the browser
//                has it and a specific language is selected. Instant, free,
//                shows words while the user is still talking.
//   • server   — the recorded audio is sent to /api/voice/transcribe
//                (Whisper via Groq → OpenAI). Detects the spoken
//                language automatically and works on every browser that can
//                record audio (Safari iOS, Firefox, Android WebViews).
//
// `chooseVoiceEngine` decides; whichever engine fails, the other is the
// fallback. Pure module: unit tested without a DOM.
// =============================================================================

export type VoiceLanguage = {
  /** "auto" or a BCP-47 tag used by the Web Speech API. */
  code: string;
  label: string;
  /** Name in the language itself. */
  native: string;
  /** ISO-639-1 hint for Whisper ("" = let the model detect). */
  whisper: string;
  rtl?: boolean;
};

export const VOICE_LANGUAGES: VoiceLanguage[] = [
  { code: "auto", label: "Auto-detect", native: "Auto", whisper: "" },
  { code: "bn-BD", label: "Bangla", native: "বাংলা", whisper: "bn" },
  { code: "en-US", label: "English", native: "English", whisper: "en" },
  { code: "hi-IN", label: "Hindi", native: "हिन्दी", whisper: "hi" },
  { code: "ar-SA", label: "Arabic", native: "العربية", whisper: "ar", rtl: true },
  { code: "ur-PK", label: "Urdu", native: "اردو", whisper: "ur", rtl: true },
  { code: "es-ES", label: "Spanish", native: "Español", whisper: "es" },
  { code: "fr-FR", label: "French", native: "Français", whisper: "fr" },
  { code: "de-DE", label: "German", native: "Deutsch", whisper: "de" },
  { code: "pt-BR", label: "Portuguese", native: "Português", whisper: "pt" },
  { code: "ru-RU", label: "Russian", native: "Русский", whisper: "ru" },
  { code: "tr-TR", label: "Turkish", native: "Türkçe", whisper: "tr" },
  { code: "id-ID", label: "Indonesian", native: "Indonesia", whisper: "id" },
  { code: "ta-IN", label: "Tamil", native: "தமிழ்", whisper: "ta" },
  { code: "ja-JP", label: "Japanese", native: "日本語", whisper: "ja" },
  { code: "ko-KR", label: "Korean", native: "한국어", whisper: "ko" },
  { code: "zh-CN", label: "Chinese", native: "中文", whisper: "zh" },
];

const WHISPER_CODES = new Set([
  "af", "ar", "hy", "az", "be", "bs", "bg", "ca", "zh", "hr", "cs", "da", "nl", "en", "et", "fi", "fr", "gl", "de", "el", "he", "hi", "hu",
  "is", "id", "it", "ja", "kn", "kk", "ko", "lv", "lt", "mk", "ms", "mr", "mi", "ne", "no", "fa", "pl", "pt", "ro", "ru", "sr", "sk", "sl",
  "es", "sw", "sv", "tl", "ta", "th", "tr", "uk", "ur", "vi", "cy", "bn", "gu", "pa", "te", "ml", "si", "my", "am", "ps", "sd", "so", "uz",
]);

export const VOICE_LANGUAGE_STORAGE_KEY = "matrix.voice.language";

export function voiceLanguage(code: string | null | undefined): VoiceLanguage {
  return VOICE_LANGUAGES.find((language) => language.code === code) ?? VOICE_LANGUAGES[0];
}

/**
 * ISO-639-1 hint for the speech model. Returns "" for "auto", unknown or
 * malformed input — a wrong hint makes Whisper transliterate the audio into
 * the hinted language, which is worse than detecting.
 */
export function whisperLanguageHint(value: string | null | undefined): string {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw || raw === "auto") return "";
  const base = raw.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) && WHISPER_CODES.has(base) ? base : "";
}

const LANGUAGE_NAMES: Record<string, string> = {
  bengali: "bn", bangla: "bn", english: "en", hindi: "hi", arabic: "ar", urdu: "ur", spanish: "es", french: "fr", german: "de",
  portuguese: "pt", russian: "ru", turkish: "tr", indonesian: "id", tamil: "ta", japanese: "ja", korean: "ko", chinese: "zh", mandarin: "zh",
};

/** Whisper reports the language as an English name ("bengali"); normalise to a code. */
export function normalizeDetectedLanguage(value: string | null | undefined): string | null {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (LANGUAGE_NAMES[raw]) return LANGUAGE_NAMES[raw];
  const base = raw.split(/[-_]/)[0];
  return /^[a-z]{2,3}$/.test(base) ? base : null;
}

export function languageLabel(code: string | null | undefined): string {
  const base = normalizeDetectedLanguage(code);
  if (!base) return "";
  const match = VOICE_LANGUAGES.find((language) => language.whisper === base);
  return match ? `${match.label}${match.native !== match.label ? ` · ${match.native}` : ""}` : base.toUpperCase();
}

/** Script-based guess so an edited transcript still gets the right direction. */
export function isRtlText(text: string): boolean {
  const letters = text.replace(/[\s\d\p{P}\p{S}]/gu, "");
  if (!letters) return false;
  const rtl = (letters.match(/[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/g) ?? []).length;
  return rtl / letters.length > 0.5;
}

export type VoiceEngine = "browser" | "server";

export type VoiceEnvironment = {
  /** `window.SpeechRecognition || window.webkitSpeechRecognition` exists. */
  speechRecognition: boolean;
  /** `MediaRecorder` + `getUserMedia` exist. */
  mediaRecorder: boolean;
  /** Phones/tablets: the recogniser and the recorder cannot share the mic. */
  mobile: boolean;
  online: boolean;
};

/**
 * Which engine captures this recording?
 *
 *  • Auto-detect needs the server: the Web Speech API cannot detect a
 *    language, it only transcribes the one it is told to expect.
 *  • On phones the recogniser takes the microphone exclusively, so recording
 *    (waveform + server fallback) and recognising at once is unreliable.
 *  • No recorder at all (old WebViews) → browser recognition is all there is.
 *
 * `live` means browser recognition runs alongside the recorder to show words
 * as they are spoken; the recording is still kept as the fallback.
 */
export function chooseVoiceEngine(language: string, env: VoiceEnvironment): { engine: VoiceEngine | null; live: boolean; reason: string } {
  if (!env.mediaRecorder && !env.speechRecognition) return { engine: null, live: false, reason: "This browser can neither record audio nor recognise speech." };
  if (!env.mediaRecorder) return { engine: "browser", live: true, reason: "Recording is unavailable; using the browser's speech recognition." };
  const specific = language !== "auto";
  if (!env.speechRecognition || !env.online) return { engine: "server", live: false, reason: "Speech is transcribed on the server." };
  if (!specific) return { engine: "server", live: false, reason: "Auto-detect is transcribed on the server." };
  if (env.mobile) return { engine: "server", live: false, reason: "On mobile the recording is transcribed on the server." };
  return { engine: "browser", live: true, reason: "Live transcription in the browser; the recording is kept as a fallback." };
}

/** Insert dictated text into what is already typed, without mangling spacing. */
export function mergeTranscript(existing: string, addition: string): string {
  const add = addition.replace(/\s+/g, " ").trim();
  if (!add) return existing;
  const base = existing.replace(/\s+$/, "");
  if (!base) return add;
  return `${base}${/[\n]$/.test(existing) ? "\n" : " "}${add}`;
}

export function formatClock(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** User-facing copy for capture/transcription failures. */
export function voiceErrorMessage(code: string): string {
  switch (code) {
    case "not-allowed":
    case "service-not-allowed":
    case "NotAllowedError":
      return "Microphone access is blocked. Allow the microphone for this site in your browser settings, then try again.";
    case "NotFoundError":
    case "audio-capture":
      return "No microphone was found. Connect one and try again.";
    case "NotReadableError":
      return "The microphone is in use by another app. Close it and try again.";
    case "no-speech":
    case "EMPTY_TRANSCRIPT":
      return "No speech was detected. Speak a little closer to the microphone and try again.";
    case "network":
      return "Speech recognition needs a connection. Check your network and try again.";
    case "language-not-supported":
      return "This browser cannot recognise that language. Choose Auto-detect to transcribe on the server.";
    case "VOICE_TRANSCRIPTION_NOT_CONFIGURED":
      return "Server transcription is not configured on this deployment. Choose a specific language to use your browser's speech recognition instead.";
    case "AUDIO_SIZE_INVALID":
      return "That recording is too long to transcribe. Record a shorter message.";
    case "UNAUTHENTICATED":
      return "Your session expired. Sign in again to use voice input.";
    default:
      return "Voice input could not be transcribed. Your recording is kept — try again.";
  }
}
