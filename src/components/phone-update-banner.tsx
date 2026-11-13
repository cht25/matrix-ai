"use client";

// =============================================================================
// Phone-First OTA Update Banner (Mobile Web / Installed Phone PWA)
//
// Polls `/api/app/version?platform=web` on mobile viewports & standalone PWAs
// (on mount and when returning to foreground). Never renders on initial paint
// so desktop and SSR stay completely clean; surfaces a compact one-tap update
// bar when a newer MATRIX build is published.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { Download, RefreshCw, Smartphone, X } from "lucide-react";

const STORAGE_SEEN_KEY = "matrix:seen_app_release";
const SHIPPED_CLIENT_VERSION = "1.1.0";
const SHIPPED_CLIENT_BUILD = 2;

type UpdateCheckPayload = {
  latest_version?: string;
  latest_build?: number;
  update_available?: boolean;
  force_update?: boolean;
  apk_url?: string;
  chat_url?: string;
  release_notes?: string;
};

export function PhoneUpdateBanner() {
  const [update, setUpdate] = useState<UpdateCheckPayload | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [isAndroidBrowser, setIsAndroidBrowser] = useState(false);

  const check = useCallback(async () => {
    if (typeof window === "undefined") return;
    const ua = navigator.userAgent || "";
    const mobile = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || window.matchMedia?.("(display-mode: standalone)")?.matches;
    if (!mobile) return;
    setIsAndroidBrowser(/Android/i.test(ua));

    try {
      const res = await fetch(
        `/api/app/version?platform=web&current_version=${encodeURIComponent(SHIPPED_CLIENT_VERSION)}&build=${SHIPPED_CLIENT_BUILD}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as UpdateCheckPayload;
      if (!data.update_available || !data.latest_version) return;
      const tag = `${data.latest_version}+${data.latest_build ?? 0}`;
      if (!data.force_update) {
        try {
          if (window.localStorage.getItem(STORAGE_SEEN_KEY) === tag) return;
        } catch { /* private mode */ }
      }
      setUpdate(data);
    } catch {
      // Offline / transient network state.
    }
  }, []);

  useEffect(() => {
    void check();
    const onVis = () => {
      if (document.visibilityState === "visible") void check();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [check]);

  if (!update || (dismissed && !update.force_update)) return null;

  const applyWebRefresh = async () => {
    const tag = `${update.latest_version ?? ""}+${update.latest_build ?? 0}`;
    try {
      window.localStorage.setItem(STORAGE_SEEN_KEY, tag);
      if ("caches" in window) {
        const names = await window.caches.keys();
        await Promise.all(names.map((n) => window.caches.delete(n)));
      }
    } catch { /* ignore */ }
    window.location.reload();
  };

  const dismiss = () => {
    const tag = `${update.latest_version ?? ""}+${update.latest_build ?? 0}`;
    try {
      window.localStorage.setItem(STORAGE_SEEN_KEY, tag);
    } catch { /* ignore */ }
    setDismissed(true);
  };

  return (
    <div
      role="region"
      aria-label="MATRIX phone update available"
      className="border-b border-accent/30 bg-accent-soft px-3 py-2 text-xs text-ink"
    >
      <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <Smartphone size={14} className="shrink-0 text-accent" aria-hidden="true" />
          <span className="truncate font-medium">
            MATRIX v{update.latest_version} is available{update.force_update ? " (required update)" : ""}
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void applyWebRefresh()}
            className="inline-flex items-center gap-1 rounded-md bg-accent px-2.5 py-1 text-[11px] font-semibold text-white hover:bg-accent-hover"
          >
            <RefreshCw size={11} /> Update now
          </button>
          {isAndroidBrowser && update.apk_url ? (
            <a
              href={update.apk_url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-md border border-border bg-surface px-2 py-1 text-[11px] font-medium text-ink-2 hover:text-ink"
            >
              <Download size={11} /> APK
            </a>
          ) : null}
          {!update.force_update ? (
            <button
              type="button"
              onClick={dismiss}
              aria-label="Dismiss update notice"
              className="grid h-6 w-6 place-items-center rounded-md text-ink-3 hover:bg-surface hover:text-ink"
            >
              <X size={13} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
