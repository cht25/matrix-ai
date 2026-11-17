// =============================================================================
// QORVYNA AI — Jarvis Voice Assistant Engine (pure, DOM-free logic).
//
// Platform honesty:
//   - Web browsers only support foreground wake-word listening while the tab is
//     open, visible, and microphone permission was explicitly granted.
//   - Local wake-word phrase matching runs in-browser without streaming raw
//     continuous audio to the cloud.
//   - Device-control intents classify risk honestly: sensitive/external actions
//     ALWAYS require explicit user confirmation before execution.
// =============================================================================

export type JarvisWakeMatch = {
  matched: boolean;
  wakeVariant: string;
  commandText: string;
};

export type JarvisIntent =
  | {
      kind: "tool";
      toolId: "device.status" | "reminders.list" | "notifications.list_synced";
      args: Record<string, unknown>;
      requiresConfirmation: false;
      summary: string;
    }
  | {
      kind: "tool";
      toolId: "reminders.create";
      args: { title: string };
      requiresConfirmation: false;
      summary: string;
    }
  | {
      kind: "device_action";
      toolId: "device.open_app";
      args: { app_name: string };
      requiresConfirmation: true;
      summary: string;
    }
  | {
      kind: "device_action";
      toolId: "device.media_control";
      args: { action: "play_pause" | "next" | "previous" | "volume_up" | "volume_down" | "mute" };
      requiresConfirmation: true;
      summary: string;
    }
  | {
      kind: "tool";
      toolId: "notifications.clear_history";
      args: Record<string, unknown>;
      requiresConfirmation: true;
      summary: string;
    };

export type JarvisSettings = {
  wakeEnabled: boolean;
  voiceName: string;
  speechRate: number;
  language: string;
};

export const JARVIS_SETTINGS_KEY = "matrix.jarvis.settings.v1";

export const DEFAULT_JARVIS_SETTINGS: JarvisSettings = {
  wakeEnabled: false,
  voiceName: "",
  speechRate: 1.02,
  language: "auto",
};

const WAKE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "hey qorvyna", regex: /(?:^|\b)(?:hey|hi|ok|okay|hello)\s+(?:qorvyna|korvina|corvina|qorvina|corvyna|gorvina|qorveena|qorbina|korbina)(?:\b|[,\s])/i },
  { label: "qorvyna", regex: /^(?:qorvyna|korvina|corvina)\b[,\s:]*/i },
  { label: "হে করভিনা", regex: /(?:^|\s)(?:হে|হেই|ওকে|হ্যালো)\s*(?:করভিনা|কোরভিনা|করবিনা|কোরবিনা|qorvyna)(?:\s|[,\u0964]|$)/i },
];

/**
 * Matches local wake phrase `"Hey QORVYNA"` (plus common ASR phonetic variants
 * in English and Bangla) and strips the wake prefix to return any immediate
 * spoken command.
 */
export function matchWakeWord(rawTranscript: string): JarvisWakeMatch {
  const cleaned = rawTranscript.replace(/\s+/g, " ").trim();
  if (!cleaned) return { matched: false, wakeVariant: "", commandText: "" };

  for (const { label, regex } of WAKE_PATTERNS) {
    const match = regex.exec(cleaned);
    if (!match) continue;
    const afterIndex = match.index + match[0].length;
    const commandText = cleaned
      .slice(afterIndex)
      .replace(/^[,.\-:;!\s\u0964]+/, "")
      .trim();
    return { matched: true, wakeVariant: label, commandText };
  }

  return { matched: false, wakeVariant: "", commandText: "" };
}

/**
 * Detects permission-checked device & assistant commands from natural English
 * or Bangla text. Returns `null` for ordinary conversational questions so they
 * flow straight to QORVYNA AI chat with full context.
 */
export function detectJarvisDeviceIntent(rawText: string): JarvisIntent | null {
  const text = rawText.trim();
  if (!text) return null;
  const lower = text.toLowerCase();

  // Read device status (LOW risk)
  if (
    /\b(device status|battery status|check (?:my )?(?:devices?|battery)|paired devices?)\b/i.test(lower) ||
    /(?:ডিভাইস|ব্যাটারি)\s*(?:স্ট্যাটাস|অবস্থা)/i.test(text)
  ) {
    return {
      kind: "tool",
      toolId: "device.status",
      args: {},
      requiresConfirmation: false,
      summary: "Read paired device and local hardware status",
    };
  }

  // List reminders (LOW risk)
  if (
    /\b(list|show|check|what are)\s+(?:my\s+)?reminders?\b/i.test(lower) ||
    /রিমাইন্ডার\s*(?:দেখাও|তালিকা)/i.test(text)
  ) {
    return {
      kind: "tool",
      toolId: "reminders.list",
      args: {},
      requiresConfirmation: false,
      summary: "Read saved reminders",
    };
  }

  // Create reminder (LOW risk)
  const remindMatch =
    /^(?:please\s+)?(?:remind me to|set (?:a )?reminder (?:to|for)|remember to)\s+(.{2,140})$/i.exec(text) ||
    /^(?:আমাকে\s+)?(.{2,140})\s*(?:মনে করিয়ে দাও|রিমাইন্ডার সেট করো)$/i.exec(text);
  if (remindMatch) {
    const title = remindMatch[1].trim().replace(/[.!?]+$/, "");
    if (title.length >= 2) {
      return {
        kind: "tool",
        toolId: "reminders.create",
        args: { title },
        requiresConfirmation: false,
        summary: `Save reminder: "${title}"`,
      };
    }
  }

  // Read synced notifications (LOW risk)
  if (
    /\b(read|show|check|list)\s+(?:my\s+)?notifications?\b/i.test(lower) ||
    /নোটিফিকেশন\s*(?:পড়ো|দেখাও|চেক)/i.test(text)
  ) {
    return {
      kind: "tool",
      toolId: "notifications.list_synced",
      args: { limit: 15 },
      requiresConfirmation: false,
      summary: "Read synced notifications",
    };
  }

  // Clear notification history (HIGH risk -> confirmation required)
  if (/\b(clear|delete)\s+(?:all\s+)?notification(?:s|\s+history)\b/i.test(lower)) {
    return {
      kind: "tool",
      toolId: "notifications.clear_history",
      args: {},
      requiresConfirmation: true,
      summary: "Clear synced notification history",
    };
  }

  // Open app (MEDIUM risk -> confirmation required)
  const openAppMatch =
    /^(?:please\s+)?(?:open|launch|start)\s+(?:app\s+)?([a-z0-9._ -]{2,48})$/i.exec(text) ||
    /^(?:ওপেন করো|চালু করো)\s+(.{2,48})$/i.exec(text);
  if (openAppMatch) {
    const appName = openAppMatch[1].trim().replace(/[.!?]+$/, "");
    // Avoid hijacking conversational prompts like "open a new project about X".
    if (appName && !/\b(a|an|the)\s+(project|chat|file|website|page|conversation)\b/i.test(appName)) {
      return {
        kind: "device_action",
        toolId: "device.open_app",
        args: { app_name: appName },
        requiresConfirmation: true,
        summary: `Open app "${appName}"`,
      };
    }
  }

  // Media controls (MEDIUM risk -> confirmation required)
  if (/^(?:please\s+)?(?:pause|play|resume)\s*(?:music|media|audio|song|track)?$/i.test(lower) || /\bplay\/pause\b/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "play_pause" },
      requiresConfirmation: true,
      summary: "Toggle media play / pause",
    };
  }
  if (/^(?:please\s+)?(?:next|skip)\s*(?:song|track|music)?$/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "next" },
      requiresConfirmation: true,
      summary: "Skip to next media track",
    };
  }
  if (/^(?:please\s+)?(?:previous|prev|back)\s*(?:song|track|music)?$/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "previous" },
      requiresConfirmation: true,
      summary: "Return to previous media track",
    };
  }
  if (/^(?:please\s+)?volume\s+up$/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "volume_up" },
      requiresConfirmation: true,
      summary: "Increase device volume",
    };
  }
  if (/^(?:please\s+)?volume\s+down$/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "volume_down" },
      requiresConfirmation: true,
      summary: "Decrease device volume",
    };
  }
  if (/^(?:please\s+)?mute\s*(?:volume|audio|sound)?$/i.test(lower)) {
    return {
      kind: "device_action",
      toolId: "device.media_control",
      args: { action: "mute" },
      requiresConfirmation: true,
      summary: "Mute device audio",
    };
  }

  return null;
}

export function sanitizeJarvisSettings(raw: unknown): JarvisSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_JARVIS_SETTINGS };
  const r = raw as Record<string, unknown>;
  const rate = typeof r.speechRate === "number" && Number.isFinite(r.speechRate) ? Math.min(1.5, Math.max(0.7, r.speechRate)) : DEFAULT_JARVIS_SETTINGS.speechRate;
  return {
    wakeEnabled: r.wakeEnabled === true,
    voiceName: typeof r.voiceName === "string" ? r.voiceName.slice(0, 120) : "",
    speechRate: rate,
    language: typeof r.language === "string" ? r.language.slice(0, 20) : "auto",
  };
}
