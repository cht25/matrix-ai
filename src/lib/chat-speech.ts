// Browser speech for Chat mode (never Agent). Uses the Web Speech API so
// replies can be read aloud without a server TTS key. Chrome historically
// cuts utterances after ~15s — we chunk and keep the synth alive.

export const AUTO_SPEAK_STORAGE_KEY = "matrix.chat.autoSpeak";

export function speechTextFromMarkdown(md: string): string {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*>\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/~~(.*?)~~/g, "$1")
    .replace(/\|/g, " ")
    .replace(/\n{2,}/g, ". ")
    .replace(/\n/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function preferredSpeechLang(text: string, uiLocale = "en"): string {
  if (/[\u0980-\u09FF]/.test(text)) return "bn-BD";
  if (uiLocale === "bn") return "bn-BD";
  return "en-US";
}

export function readAutoSpeakPreference(defaultValue = true): boolean {
  if (typeof window === "undefined") return defaultValue;
  try {
    const raw = window.localStorage.getItem(AUTO_SPEAK_STORAGE_KEY);
    if (raw === "0" || raw === "false") return false;
    if (raw === "1" || raw === "true") return true;
  } catch {
    /* private mode */
  }
  return defaultValue;
}

export function writeAutoSpeakPreference(on: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(AUTO_SPEAK_STORAGE_KEY, on ? "1" : "0");
  } catch {
    /* private mode */
  }
}

export function isSpeechSupported(): boolean {
  return typeof window !== "undefined" && "speechSynthesis" in window && typeof window.SpeechSynthesisUtterance === "function";
}

let speakToken = 0;
let keepAliveTimer: ReturnType<typeof setInterval> | null = null;

function clearKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

export function stopSpeech(): void {
  speakToken += 1;
  clearKeepAlive();
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      /* ignore */
    }
  }
}

/** Call during a user gesture (Send / Listen) so later auto-read is allowed. */
export function primeSpeech(): void {
  if (!isSpeechSupported()) return;
  try {
    const silent = new SpeechSynthesisUtterance(" ");
    silent.volume = 0;
    silent.rate = 1;
    window.speechSynthesis.speak(silent);
    window.speechSynthesis.cancel();
  } catch {
    /* ignore */
  }
}

function pickVoice(lang: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices();
  if (!voices.length) return null;
  const exact = voices.find((v) => v.lang === lang);
  if (exact) return exact;
  const prefix = lang.slice(0, 2).toLowerCase();
  return voices.find((v) => v.lang.toLowerCase().startsWith(prefix)) ?? voices.find((v) => v.default) ?? voices[0] ?? null;
}

function chunkText(text: string, max = 220): string[] {
  const parts: string[] = [];
  let remaining = text.trim();
  while (remaining.length > max) {
    const slice = remaining.slice(0, max);
    const breakAt = Math.max(
      slice.lastIndexOf(". "),
      slice.lastIndexOf("? "),
      slice.lastIndexOf("! "),
      slice.lastIndexOf("; "),
      slice.lastIndexOf(", "),
      slice.lastIndexOf(" "),
    );
    const take = breakAt > 40 ? breakAt + 1 : max;
    parts.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining) parts.push(remaining);
  return parts;
}

export function speakPlainText(
  text: string,
  opts: { lang?: string; onend?: () => void; onerror?: () => void } = {},
): boolean {
  if (!isSpeechSupported()) {
    opts.onerror?.();
    return false;
  }
  const cleaned = text.trim();
  if (!cleaned) {
    opts.onend?.();
    return false;
  }

  stopSpeech();
  const token = speakToken;
  const lang = opts.lang ?? "en-US";
  const chunks = chunkText(cleaned);
  let index = 0;
  let started = false;

  keepAliveTimer = setInterval(() => {
    if (token !== speakToken || !window.speechSynthesis.speaking) {
      clearKeepAlive();
      return;
    }
    try {
      window.speechSynthesis.pause();
      window.speechSynthesis.resume();
    } catch {
      /* ignore */
    }
  }, 8000);

  const finishOk = () => {
    if (token !== speakToken) return;
    clearKeepAlive();
    opts.onend?.();
  };
  const finishErr = () => {
    if (token !== speakToken) return;
    clearKeepAlive();
    opts.onerror?.();
  };

  const speakNext = () => {
    if (token !== speakToken) return;
    if (index >= chunks.length) {
      finishOk();
      return;
    }
    const utterance = new SpeechSynthesisUtterance(chunks[index++]);
    utterance.lang = lang;
    const voice = pickVoice(lang);
    if (voice) utterance.voice = voice;
    utterance.rate = 1.02;
    utterance.pitch = 1;
    utterance.onend = speakNext;
    utterance.onerror = finishErr;
    try {
      window.speechSynthesis.speak(utterance);
    } catch {
      finishErr();
    }
  };

  const start = () => {
    if (started || token !== speakToken) return;
    started = true;
    speakNext();
  };

  if (window.speechSynthesis.getVoices().length === 0) {
    window.speechSynthesis.addEventListener("voiceschanged", start, { once: true });
    setTimeout(start, 300);
  } else {
    start();
  }
  return true;
}

export function speakMarkdown(
  md: string,
  opts: { locale?: string; onend?: () => void; onerror?: () => void } = {},
): boolean {
  const text = speechTextFromMarkdown(md);
  const lang = preferredSpeechLang(text, opts.locale ?? "en");
  return speakPlainText(text, { lang, onend: opts.onend, onerror: opts.onerror });
}
