"use client";

// =============================================================================
// Universal "Work Done" + Native Tauri / Desktop Notification Bridge.
//
// Whenever a task finishes in MATRIX — screenshot analysis, Agent build/deploy,
// automation run, family mirror/lock event, ESP32 alert, or an AI reply while
// the window is in the background — this module delivers:
//   1. A native OS notification through the Tauri v2 bridge when running as
//      the desktop/companion app (`matrix_notify`);
//   2. A standard Web Notification when running in a browser with permission;
//   3. An immediate cache invalidation on `notifications:list` so the in-app
//      NotificationsBell updates without waiting for the next poll.
// =============================================================================

import { invalidate } from "@/lib/client/cache";

export type TauriInvoke = <T = unknown>(cmd: string, args?: Record<string, unknown>) => Promise<T>;

declare global {
  interface Window {
    __TAURI_INTERNALS__?: {
      invoke?: TauriInvoke;
    };
    __TAURI__?: {
      core?: { invoke?: TauriInvoke };
    };
  }
}

const PREF_KEY = "matrix-desktop-notifications";

export function isTauriApp(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.__TAURI_INTERNALS__?.invoke || window.__TAURI__?.core?.invoke);
}

export async function invokeTauri<T = unknown>(cmd: string, args: Record<string, unknown> = {}): Promise<T | null> {
  if (typeof window === "undefined") return null;
  const fn = window.__TAURI_INTERNALS__?.invoke ?? window.__TAURI__?.core?.invoke;
  if (!fn) return null;
  try {
    return await fn<T>(cmd, args);
  } catch {
    return null;
  }
}

export function desktopNotificationsEnabled(): boolean {
  if (typeof window === "undefined") return false;
  if (isTauriApp()) return true;
  if (!("Notification" in window)) return false;
  try {
    if (window.localStorage.getItem(PREF_KEY) === "off") return false;
  } catch {
    /* private mode */
  }
  return Notification.permission === "granted";
}

export async function requestDesktopNotificationPermission(): Promise<"granted" | "denied" | "unsupported"> {
  if (typeof window === "undefined") return "unsupported";
  try {
    window.localStorage.setItem(PREF_KEY, "on");
  } catch {
    /* private mode */
  }
  if (isTauriApp()) {
    await invokeTauri("matrix_notify", {
      title: "MATRIX notifications enabled",
      body: "You will be notified whenever builds, scans, automations or device events finish.",
    });
    return "granted";
  }
  if (!("Notification" in window)) return "unsupported";
  const result = await Notification.requestPermission();
  if (result === "granted") {
    try {
      new Notification("MATRIX notifications enabled", {
        body: "You will get a notification whenever work completes.",
      });
    } catch {
      /* ignore */
    }
  }
  return result === "granted" ? "granted" : "denied";
}

export function disableDesktopNotifications(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(PREF_KEY, "off");
  } catch {
    /* private mode */
  }
}

export async function notifyWorkDone(input: {
  title: string;
  body: string;
  link?: string;
  /** When true, only fires OS/browser popup if tab is hidden or running in Tauri. */
  onlyWhenBackgrounded?: boolean;
  /** Set false when called from NotificationsBell itself to avoid loop. */
  refreshBell?: boolean;
}): Promise<void> {
  if (input.refreshBell !== false) invalidate("notifications:list");
  if (typeof window === "undefined") return;

  const shouldPop = !input.onlyWhenBackgrounded || document.hidden || isTauriApp();
  if (!shouldPop) return;

  if (isTauriApp()) {
    await invokeTauri("matrix_notify", { title: input.title, body: input.body });
    return;
  }

  if (desktopNotificationsEnabled() && "Notification" in window && Notification.permission === "granted") {
    try {
      const n = new Notification(input.title, {
        body: input.body,
        tag: `matrix-${Date.now()}`,
      });
      if (input.link) {
        n.onclick = () => {
          window.focus();
          window.location.href = input.link!;
        };
      }
    } catch {
      /* service-worker-only mobile browsers */
    }
  }
}
