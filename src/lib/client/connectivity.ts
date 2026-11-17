"use client";

import { useCallback, useEffect, useState } from "react";

export type ConnectivityState = "online" | "offline" | "reconnecting";

export type ConnectivitySnapshot = {
  status: ConnectivityState;
  latencyMs: number | null;
  lastCheckedAt: number | null;
};

let currentSnapshot: ConnectivitySnapshot = {
  status: "online",
  latencyMs: null,
  lastCheckedAt: null,
};

const listeners = new Set<(snap: ConnectivitySnapshot) => void>();
let inFlightProbe: Promise<ConnectivitySnapshot> | null = null;

function publish(next: ConnectivitySnapshot) {
  currentSnapshot = next;
  for (const fn of listeners) fn(next);
}

/**
 * Active reachability probe against `/api/ping`.
 * Never trusts `navigator.onLine` alone — a phone on captive Wi-Fi or dead
 * cellular reports `navigator.onLine === true` while `/api/ping` fails.
 */
export async function probeConnectivity(timeoutMs = 4500): Promise<ConnectivitySnapshot> {
  if (typeof window === "undefined") return currentSnapshot;
  if (inFlightProbe) return inFlightProbe;

  if (navigator.onLine === false) {
    const offlineSnap: ConnectivitySnapshot = {
      status: "offline",
      latencyMs: null,
      lastCheckedAt: Date.now(),
    };
    publish(offlineSnap);
    return offlineSnap;
  }

  const run = (async (): Promise<ConnectivitySnapshot> => {
    const started = performance.now();
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`/api/ping?t=${Date.now()}`, {
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: controller.signal,
      });
      await res.text().catch(() => "");
      const latencyMs = Math.max(1, Math.round(performance.now() - started));
      const snap: ConnectivitySnapshot = res.ok
        ? { status: "online", latencyMs, lastCheckedAt: Date.now() }
        : { status: "offline", latencyMs: null, lastCheckedAt: Date.now() };
      publish(snap);
      return snap;
    } catch {
      const snap: ConnectivitySnapshot = {
        status: "offline",
        latencyMs: null,
        lastCheckedAt: Date.now(),
      };
      publish(snap);
      return snap;
    } finally {
      window.clearTimeout(timer);
      inFlightProbe = null;
    }
  })();

  inFlightProbe = run;
  return run;
}

export function useConnectivity() {
  const [snap, setSnap] = useState<ConnectivitySnapshot>(() => currentSnapshot);

  const retry = useCallback(async () => {
    publish({ ...currentSnapshot, status: "reconnecting" });
    return probeConnectivity();
  }, []);

  useEffect(() => {
    listeners.add(setSnap);
    if (navigator.onLine === false) {
      publish({ status: "offline", latencyMs: null, lastCheckedAt: Date.now() });
    } else {
      void probeConnectivity();
    }

    const onOnline = () => {
      publish({ ...currentSnapshot, status: "reconnecting" });
      void probeConnectivity();
    };
    const onOffline = () => {
      publish({ status: "offline", latencyMs: null, lastCheckedAt: Date.now() });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") void probeConnectivity();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisible);

    // When offline, periodically check for network recovery cleanly.
    const interval = window.setInterval(() => {
      if (currentSnapshot.status !== "online" || document.visibilityState === "visible") {
        void probeConnectivity();
      }
    }, 25_000);

    return () => {
      listeners.delete(setSnap);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisible);
      window.clearInterval(interval);
    };
  }, []);

  return {
    ...snap,
    online: snap.status === "online",
    reconnecting: snap.status === "reconnecting",
    retry,
  };
}
