"use client";

// =============================================================================
// QORVYNA native bridge — the ONE place the shared frontend talks to Tauri.
//
// Security model (mirrors src-tauri/capabilities/default.json):
//   • the frontend can only call commands that are explicitly registered in
//     `invoke_handler` AND allowed by the window capability;
//   • every command is allowlisted inside Rust — no command takes a shell
//     string, a path outside the app's data dir, or an arbitrary URL;
//   • nothing here runs in a browser: every function degrades to a documented
//     "unsupported" result, so the same components keep working on the web.
//
// The bridge is intentionally small. Chat, models, devices, automations and
// settings all use the HTTP API (same as the website); only OS capabilities
// that a browser cannot provide are routed natively.
// =============================================================================

export type NativePlatform = "android" | "ios" | "windows" | "macos" | "linux" | "web";

export type NativeInfo = {
  platform: NativePlatform;
  appVersion: string;
  osVersion: string;
  deviceName: string;
  isDesktop: boolean;
  isMobile: boolean;
};

export type PermissionId =
  | "microphone"
  | "notifications"
  | "notification_access"
  | "screen_capture"
  | "overlay"
  | "background_microphone"
  | "bluetooth"
  | "assistant_role";

export type PermissionState = "granted" | "denied" | "not_requested" | "unsupported" | "restricted";

export type PermissionStatus = {
  id: PermissionId;
  state: PermissionState;
  /** What the OS reported (for the setup checklist detail line). */
  detail: string;
};

type Invoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: { invoke?: Invoke };
    __TAURI__?: { core?: { invoke?: Invoke } };
  }
}

/** True inside the QORVYNA desktop/mobile shell (Tauri v2). */
export function isNativeShell(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);
}

async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  if (typeof window === "undefined") return null;
  const fn = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!fn) return null;
  try {
    return await fn<T>(cmd, args);
  } catch (error) {
    // A denied capability, a missing permission or a platform that cannot do
    // this is a normal outcome — the caller renders the honest state.
    if (process.env.NODE_ENV !== "production") {
      console.warn(`[QORVYNA native] ${cmd} failed`, error);
    }
    return null;
  }
}

/** Best-effort platform detection when the shell cannot report it. */
function platformFromUserAgent(): NativePlatform {
  if (typeof navigator === "undefined") return "web";
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X/i.test(ua)) return "macos";
  if (/Linux/i.test(ua)) return "linux";
  return "web";
}

export async function nativeInfo(): Promise<NativeInfo> {
  const reported = await invoke<Omit<NativeInfo, "isDesktop" | "isMobile">>("qorvyna_native_info");
  const platform = reported?.platform ?? (isNativeShell() ? platformFromUserAgent() : "web");
  return {
    platform,
    appVersion: reported?.appVersion ?? "",
    osVersion: reported?.osVersion ?? "",
    deviceName: reported?.deviceName ?? (typeof navigator !== "undefined" ? navigator.platform : ""),
    isDesktop: platform === "windows" || platform === "macos" || platform === "linux",
    isMobile: platform === "android" || platform === "ios",
  };
}

// ---------------------------------------------------------------------------
// Permissions (Phase 3 setup checklist)
// ---------------------------------------------------------------------------

/** Every permission QORVYNA can ask for, and whether it is required. */
export const PERMISSION_CATALOG: Array<{
  id: PermissionId;
  label: string;
  why: string;
  required: boolean;
  /** Platforms where the item is meaningful. */
  platforms: NativePlatform[];
}> = [
  {
    id: "microphone",
    label: "Microphone",
    why: "Speak to QORVYNA and dictate messages. Audio is transcribed and the recording is never used as a chat message.",
    required: false,
    platforms: ["android", "ios", "windows", "macos", "linux"],
  },
  {
    id: "notifications",
    label: "Notifications",
    why: "Tells you when an answer, build or automation has finished.",
    required: false,
    platforms: ["android", "ios", "windows", "macos", "linux"],
  },
  {
    id: "notification_access",
    label: "Notification access",
    why: "Forwards notifications from other apps to your QORVYNA notification feed. Off unless you grant it, and per-app exclusions are supported.",
    required: false,
    platforms: ["android"],
  },
  {
    id: "screen_capture",
    label: "Screen sharing",
    why: "Shares your screen during a consented mirroring session. Android always shows its own capture indicator and stops when you revoke it.",
    required: false,
    platforms: ["android", "windows", "macos", "linux"],
  },
  {
    id: "overlay",
    label: "Display over other apps",
    why: "Shows the compact QORVYNA assistant bubble over the app you are using. Android decides whether this is permitted.",
    required: false,
    platforms: ["android"],
  },
  {
    id: "background_microphone",
    label: "Background microphone",
    why: "\"Hey QORVYNA\" detection while another app is open. Detection is on-device; audio is only sent after the wake word is heard.",
    required: false,
    platforms: ["android"],
  },
  {
    id: "bluetooth",
    label: "Nearby devices",
    why: "Connects Bluetooth and nearby QORVYNA devices (ESP32 nodes, headphones, wearables).",
    required: false,
    platforms: ["android", "ios"],
  },
  {
    id: "assistant_role",
    label: "Default assistant",
    why: "Lets the system open QORVYNA with the assistant gesture or long-press. Only the OS can grant this.",
    required: false,
    platforms: ["android"],
  },
];

export async function permissionStatus(): Promise<PermissionStatus[]> {
  const reported = await invoke<PermissionStatus[]>("qorvyna_permission_status");
  if (reported && Array.isArray(reported)) return reported;
  return PERMISSION_CATALOG.map((permission) => ({
    id: permission.id,
    state: "unsupported" as PermissionState,
    detail: isNativeShell()
      ? "This build cannot report this permission yet."
      : "Only available in the QORVYNA Android/Windows app.",
  }));
}

export async function requestPermission(id: PermissionId): Promise<PermissionState> {
  const result = await invoke<{ state?: PermissionState }>("qorvyna_permission_request", { permission: id });
  return result?.state ?? "unsupported";
}

/** Opens the exact OS settings screen for a permission (never a fake toggle). */
export async function openPermissionSettings(id: PermissionId): Promise<boolean> {
  const result = await invoke<{ opened?: boolean }>("qorvyna_permission_settings", { permission: id });
  return result?.opened === true;
}

// ---------------------------------------------------------------------------
// Assistant / wake word (Phase 4)
// ---------------------------------------------------------------------------

export type AssistantState = {
  /** Whether this device can run a wake word at all. */
  wakeWordSupported: boolean;
  wakeWordEnabled: boolean;
  /** What the OS supports for the floating assistant. */
  overlaySupported: boolean;
  /** True when QORVYNA is currently the system's default assistant. */
  defaultAssistant: boolean;
  /** Human explanation — shown verbatim, never a promise of more. */
  note: string;
};

export async function assistantState(): Promise<AssistantState | null> {
  return invoke<AssistantState>("qorvyna_assistant_state");
}

export async function setWakeWordEnabled(enabled: boolean): Promise<AssistantState | null> {
  return invoke<AssistantState>("qorvyna_wake_word_set", { enabled });
}

/** Ask the OS to show its "set as default assistant" dialog. */
export async function requestDefaultAssistant(): Promise<boolean> {
  const result = await invoke<{ opened?: boolean }>("qorvyna_assistant_default_request");
  return result?.opened === true;
}

/** Show / hide the compact floating assistant (Android overlay). */
export async function showAssistantPopup(): Promise<boolean> {
  const result = await invoke<{ shown?: boolean }>("qorvyna_assistant_popup", { action: "show" });
  return result?.shown === true;
}

export async function hideAssistantPopup(): Promise<boolean> {
  const result = await invoke<{ shown?: boolean }>("qorvyna_assistant_popup", { action: "hide" });
  return result?.shown === false;
}

// ---------------------------------------------------------------------------
// Device pairing / inspection / notifications
// ---------------------------------------------------------------------------

/** A stable, non-secret identifier for this installation (never a token). */
export async function deviceFingerprint(): Promise<string | null> {
  const result = await invoke<{ fingerprint?: string }>("qorvyna_device_fingerprint");
  return result?.fingerprint ?? null;
}

/** True when an admin inspection is active — the app MUST show an indicator. */
export async function activeInspection(): Promise<{ active: boolean; adminName?: string; reason?: string; startedAt?: string } | null> {
  return invoke("qorvyna_inspection_state");
}

/** Stop an inspection immediately from the target device. */
export async function stopInspection(): Promise<boolean> {
  const result = await invoke<{ stopped?: boolean }>("qorvyna_inspection_stop");
  return result?.stopped === true;
}

export { invoke as invokeNative };

// ---------------------------------------------------------------------------
// Deep links
// ---------------------------------------------------------------------------

/** How a `qorvyna://` URL should be handled by the app. */
export type DeepLinkIntent =
  | { kind: "pair"; token: string }
  | { kind: "voice" }
  | { kind: "navigate"; path: string }
  | { kind: "unknown"; url: string };

/**
 * Parse a deep link into something the router can act on.
 *
 * Supported forms:
 *   qorvyna://link?code=ABCD-EFGH   → pair (cross-account device link)
 *   qorvyna://voice                 → activate Jarvis
 *   qorvyna://chat/<id>             → navigate
 *   https://qorvyna.thamjj13.top/x  → navigate (universal link)
 *
 * Anything else returns `unknown` rather than guessing — an unrecognised link
 * must never be silently turned into a navigation to an attacker-chosen path.
 */
export function parseDeepLink(raw: string | null | undefined): DeepLinkIntent {
  const input = String(raw ?? "").trim();
  if (!input) return { kind: "unknown", url: "" };

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { kind: "unknown", url: input };
  }

  const host = url.hostname.toLowerCase();
  const isAppScheme = url.protocol === "qorvyna:";
  const isWebOrigin = /(^|\.)qorvyna\.thamjj13\.top$/.test(host);
  if (!isAppScheme && !isWebOrigin) return { kind: "unknown", url: input };

  if (isAppScheme) {
    // qorvyna://link?code=… parses with hostname "link" and an empty path.
    const action = (url.hostname || url.pathname.replace(/^\/+/, "")).toLowerCase();
    if (action === "link" || action === "pair") {
      const token = url.searchParams.get("code") ?? url.searchParams.get("token") ?? "";
      return token ? { kind: "pair", token } : { kind: "unknown", url: input };
    }
    if (action === "voice" || action === "assistant") return { kind: "voice" };
    // `qorvyna://chat/abc123` parses as hostname "chat", pathname "/abc123".
    // Re-assemble the host as the first segment or the route would lose "chat".
    const rest = url.pathname.replace(/^\/+/, "");
    const hasRouteHost = Boolean(action) && action !== "link";
    if (rest) return { kind: "navigate", path: `/${hasRouteHost ? `${action}/` : ""}${rest}${url.search}` };
    if (hasRouteHost) return { kind: "navigate", path: `/${action}${url.search}` };
    return { kind: "unknown", url: input };
  }

  // Universal link: keep the path and query exactly as the site would see it.
  return { kind: "navigate", path: `${url.pathname || "/"}${url.search}` };
}

type UnlistenFn = () => void;

/**
 * Subscribe to deep links delivered by the Rust side as `qorvyna://deep-link`.
 * Returns an unsubscribe function; a no-op when not running in the shell.
 */
export function onDeepLink(handler: (intent: DeepLinkIntent, raw: string) => void): UnlistenFn {
  if (typeof window === "undefined" || !isNativeShell()) return () => {};
  const internals = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string, args?: Record<string, unknown>) => Promise<unknown> } }).__TAURI_INTERNALS__;
  const invoke = internals?.invoke;
  if (!invoke) return () => {};

  let disposed = false;
  void (async () => {
    try {
      await invoke("plugin:event|listen", {
        event: "qorvyna://deep-link",
        target: { kind: "Any" },
        handler: (event: unknown) => {
          const payload = (event as { payload?: unknown })?.payload;
          if (typeof payload !== "string" || disposed) return;
          handler(parseDeepLink(payload), payload);
        },
      });
    } catch {
      // Event plugin unavailable: deep links are best-effort, never required.
    }
  })();

  return () => {
    disposed = true;
  };
}
