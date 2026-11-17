"use client";

// =============================================================================
// QORVYNA PWA Service Worker & Cross-Platform In-App Update Manager
//
// 1. Registers `/sw.js` cleanly for real offline shell caching & updates.
// 2. Detects both waiting Service Worker updates AND newer server versions via
//    `/api/app/version` (supporting Web, installed PWA, and Tauri Desktop).
// 3. Offers an unobtrusive "Update now" / "Later" bar (never loops, never
//    breaks active forms or streaming) unless `force_update` is true.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Download, RefreshCw, Sparkles, X } from "lucide-react";
import { APP_BUILD_NUMBER, APP_VERSION } from "@/lib/version";

const SEEN_UPDATE_KEY = "qorvyna:seen_update_tag";

type VersionResponse = {
  latest_version?: string;
  latest_build?: number;
  update_available?: boolean;
  force_update?: boolean;
  download_url?: string;
  release_notes?: string;
};

type UpdateBannerState = {
  source: "sw" | "version";
  version: string;
  build: number;
  force: boolean;
  downloadUrl?: string;
  notes?: string;
  isDesktop: boolean;
};

export function PwaManager() {
  const [banner, setBanner] = useState<UpdateBannerState | null>(null);
  const [applying, setApplying] = useState(false);
  const waitingWorkerRef = useRef<ServiceWorker | null>(null);
  const reloadingRef = useRef(false);
  const userRequestedUpdateRef = useRef(false);

  const checkServerVersion = useCallback(async () => {
    if (typeof window === "undefined") return;
    if (navigator.onLine === false) return;
    const isDesktop = "__TAURI_INTERNALS__" in window || "__TAURI__" in window;
    const platform = isDesktop ? "desktop" : "web";
    try {
      const res = await fetch(
        `/api/app/version?platform=${platform}&current_version=${encodeURIComponent(APP_VERSION)}&build=${APP_BUILD_NUMBER}`,
        { cache: "no-store", credentials: "same-origin" },
      );
      if (!res.ok) return;
      const data = (await res.json()) as VersionResponse;
      if (!data.update_available || !data.latest_version) return;
      const tag = `${data.latest_version}+${data.latest_build ?? 0}`;
      if (!data.force_update) {
        try {
          if (window.sessionStorage.getItem(SEEN_UPDATE_KEY) === tag) return;
        } catch { /* ignore */ }
      }
      setBanner({
        source: "version",
        version: data.latest_version,
        build: data.latest_build ?? APP_BUILD_NUMBER,
        force: data.force_update === true,
        downloadUrl: data.download_url,
        notes: data.release_notes,
        isDesktop,
      });
    } catch {
      /* offline or unreachable */
    }
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") return;

    // Register Service Worker on supporting browsers.
    let regRef: ServiceWorkerRegistration | null = null;
    let cleanupSw: (() => void) | null = null;
    if ("serviceWorker" in navigator) {
      const hadController = Boolean(navigator.serviceWorker.controller);
      navigator.serviceWorker
        .register("/sw.js", { scope: "/" })
        .then((reg) => {
          regRef = reg;
          if (reg.waiting && navigator.serviceWorker.controller) {
            waitingWorkerRef.current = reg.waiting;
            setBanner((prev) =>
              prev ?? {
                source: "sw",
                version: APP_VERSION,
                build: APP_BUILD_NUMBER,
                force: false,
                isDesktop: "__TAURI_INTERNALS__" in window,
              },
            );
          }
          reg.addEventListener("updatefound", () => {
            const installing = reg.installing;
            if (!installing) return;
            installing.addEventListener("statechange", () => {
              if (installing.state === "installed" && navigator.serviceWorker.controller) {
                waitingWorkerRef.current = installing;
                setBanner({
                  source: "sw",
                  version: APP_VERSION,
                  build: APP_BUILD_NUMBER,
                  force: false,
                  isDesktop: "__TAURI_INTERNALS__" in window,
                });
              }
            });
          });
        })
        .catch(() => { /* SW disabled or insecure origin */ });

      const onControllerChange = () => {
        if (!hadController || !userRequestedUpdateRef.current) return;
        if (reloadingRef.current) return;
        reloadingRef.current = true;
        window.location.reload();
      };
      navigator.serviceWorker.addEventListener("controllerchange", onControllerChange);
      cleanupSw = () => navigator.serviceWorker.removeEventListener("controllerchange", onControllerChange);
    }

    void checkServerVersion();

    const onVisible = () => {
      if (document.visibilityState === "visible") {
        void regRef?.update().catch(() => {});
        void checkServerVersion();
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    const interval = window.setInterval(() => {
      void regRef?.update().catch(() => {});
      void checkServerVersion();
    }, 10 * 60_000);

    return () => {
      cleanupSw?.();
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, [checkServerVersion]);

  if (!banner) return null;

  const dismiss = () => {
    if (banner.force) return;
    try {
      window.sessionStorage.setItem(SEEN_UPDATE_KEY, `${banner.version}+${banner.build}`);
    } catch { /* ignore */ }
    setBanner(null);
  };

  const applyUpdate = async () => {
    setApplying(true);
    try {
      window.sessionStorage.setItem(SEEN_UPDATE_KEY, `${banner.version}+${banner.build}`);
    } catch { /* ignore */ }
    if (waitingWorkerRef.current) {
      userRequestedUpdateRef.current = true;
      waitingWorkerRef.current.postMessage({ type: "SKIP_WAITING" });
      window.setTimeout(() => {
        if (!reloadingRef.current) {
          reloadingRef.current = true;
          window.location.reload();
        }
      }, 1200);
      return;
    }
    try {
      if ("caches" in window) {
        const names = await window.caches.keys();
        await Promise.all(names.map((n) => window.caches.delete(n)));
      }
    } catch { /* ignore */ }
    window.location.reload();
  };

  return (
    <div
      role="region"
      aria-label="QORVYNA update notification"
      className="fixed bottom-4 right-4 z-[70] w-[calc(100vw-2rem)] max-w-sm rounded-2xl border border-accent/40 bg-surface p-3.5 text-sm shadow-[var(--shadow-pop)]"
    >
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-accent-soft text-accent">
          <Sparkles size={16} aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">
            {banner.source === "sw"
              ? "A new QORVYNA update is ready"
              : `${banner.isDesktop ? "Desktop" : "QORVYNA"} v${banner.version} is available`}
          </p>
          <p className="mt-0.5 text-xs text-ink-2">
            {banner.force
              ? "Please update now to keep using QORVYNA safely."
              : "Reload smoothly when you're ready to get the latest improvements."}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() => void applyUpdate()}
              disabled={applying}
              className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-accent-solid px-3 text-xs font-semibold text-accent-ink hover:bg-accent-solid-hover disabled:opacity-60"
            >
              <RefreshCw size={12} className={applying ? "animate-spin" : undefined} aria-hidden="true" />
              {applying ? "Updating…" : "Update now"}
            </button>
            {banner.isDesktop && banner.downloadUrl ? (
              <a
                href={banner.downloadUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-8 items-center gap-1 rounded-lg border border-border px-2.5 text-xs font-medium text-ink-2 hover:bg-surface-2 hover:text-ink"
              >
                <Download size={12} aria-hidden="true" /> Installer
              </a>
            ) : null}
            {!banner.force ? (
              <button
                type="button"
                onClick={dismiss}
                className="h-8 rounded-lg px-2 text-xs font-medium text-ink-3 hover:bg-surface-2 hover:text-ink"
              >
                Later
              </button>
            ) : null}
          </div>
        </div>
        {!banner.force ? (
          <button
            type="button"
            onClick={dismiss}
            aria-label="Dismiss update notification"
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-ink-3 hover:bg-surface-2 hover:text-ink"
          >
            <X size={14} aria-hidden="true" />
          </button>
        ) : null}
      </div>
    </div>
  );
}
