"use client";

// =============================================================================
// QORVYNA — the on-device inspection indicator (Phase 8).
//
// If an admin inspects this device, the person holding it MUST be able to see
// that, who it is, why, what is in scope, how long is left, and how to stop it.
// This component is that surface. It:
//
//   • polls the server for a pending or active session for THIS device;
//   • never hides itself while a session is live (closing it only collapses the
//     detail, the bar and countdown stay);
//   • stops the session for real, not just locally;
//   • renders nothing at all when there is nothing to disclose.
// =============================================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { Eye, Loader2, ShieldAlert, Square } from "lucide-react";
import { Button } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import {
  SCOPE_LABELS,
  STATUS_TEXT,
  formatCountdown,
  inspectionNotice,
  secondsRemaining,
  type InspectionRequest,
  type InspectionScope,
} from "@/lib/inspection";
import { deviceFingerprint } from "@/native/native-bridge";

const POLL_MS = 15_000;

type Ack = { status: string; notice: string; ends_at: string; scopes: InspectionScope[] };

export function InspectionIndicator({ deviceId }: { deviceId?: string | null }) {
  const toast = useToast();
  const [request, setRequest] = useState<InspectionRequest | null>(null);
  const [remaining, setRemaining] = useState(0);
  const [stopping, setStopping] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const resolvedId = useRef<string | null>(null);

  const poll = useCallback(async () => {
    try {
      const id = deviceId ?? (await deviceFingerprint()) ?? "";
      if (!id) {
        setRequest(null);
        return;
      }
      const active = await rpc<InspectionRequest | null>("inspection_active", { device_id: id });
      setRequest(active ?? null);
    } catch (cause) {
      // A session we cannot confirm must not be displayed as if it were active
      // — but it must also not be silently swallowed in the console only.
      if (cause instanceof RpcCallError && cause.status !== 401) {
        console.warn(`[QORVYNA] inspection status unavailable: ${cause.message}`);
      }
    }
  }, [deviceId]);

  useEffect(() => {
    void poll();
    const timer = window.setInterval(() => void poll(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [poll]);

  // Countdown from the server's `ends_at` — the client never decides duration.
  useEffect(() => {
    if (!request?.ends_at) {
      setRemaining(0);
      return;
    }
    const tick = () => setRemaining(secondsRemaining(request.ends_at));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [request?.ends_at]);

  useEffect(() => {
    setExpanded(true);
    resolvedId.current = null;
  }, [request?.id]);

  // A pending request becomes active only when this device confirms it, which
  // is what triggers the visible notice + start time on the server.
  useEffect(() => {
    if (!request || request.status !== "requested" || resolvedId.current === request.id) return;
    resolvedId.current = request.id;
    void (async () => {
      try {
        const id = deviceId ?? (await deviceFingerprint()) ?? "";
        if (!id) return;
        const ack = await rpc<Ack>("inspection_acknowledge", { inspection_id: request.id, device_id: id });
        toast(ack.status === "active" ? "Inspection started — you can stop it at any time." : ack.notice);
        await poll();
      } catch (cause) {
        // Guardian gate, expiry or a race: show the truth instead of pretending.
        toast(
          cause instanceof RpcCallError && cause.code === "GUARDIAN_APPROVAL_REQUIRED"
            ? "A guardian must approve before this inspection can start."
            : "This inspection could not be started.",
        );
        await poll();
      }
    })();
  }, [request, deviceId, poll, toast]);

  async function stop() {
    if (!request) return;
    setStopping(true);
    try {
      await rpc("inspection_stop", { inspection_id: request.id, reason: "Stopped from the device" });
      toast("Inspection stopped. Nothing further is being collected.");
      setRequest(null);
    } catch (cause) {
      toast(cause instanceof RpcCallError ? "The inspection could not be stopped — try again." : "Network error while stopping.");
    } finally {
      setStopping(false);
    }
  }

  if (!request) return null;
  const isActive = request.status === "active";
  const notice = inspectionNotice(request);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed inset-x-0 bottom-0 z-[95] border-t border-amber-500/40 bg-amber-500/10 px-3 py-2 backdrop-blur-sm sm:px-4"
    >
      <div className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-ink">
          <Eye className="h-4 w-4 text-amber-500" aria-hidden="true" />
          {isActive ? "Admin inspection in progress" : request.status === "requested" ? "Inspection requested" : STATUS_TEXT[request.status]}
        </span>
        {isActive && remaining > 0 ? (
          <span className="rounded-full bg-ink/10 px-2 py-0.5 font-mono text-[12px] font-medium text-ink">{formatCountdown(remaining)} left</span>
        ) : null}
        <span className="min-w-0 flex-1 truncate text-[12px] text-ink-2">
          {request.admin_name || request.admin_email || "QORVYNA administrator"} · {request.reason}
        </span>
        <span className="flex items-center gap-1.5">
          <Button type="button" variant="ghost" onClick={() => setExpanded((value) => !value)}>
            {expanded ? "Hide details" : "Details"}
          </Button>
          <Button type="button" disabled={stopping} onClick={() => void stop()}>
            {stopping ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : <Square className="mr-1.5 h-3.5 w-3.5" />} Stop inspection
          </Button>
        </span>
      </div>

      {expanded ? (
        <div className="mx-auto mt-1.5 max-w-5xl space-y-1.5 border-t border-amber-500/20 pt-1.5">
          <p className="flex items-start gap-1.5 text-[12px] leading-relaxed text-ink-2">
            <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-500" aria-hidden="true" />
            {notice}
          </p>
          <ul className="flex flex-wrap gap-1.5">
            {request.scopes.map((scope) => (
              <li key={scope} className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2">
                {SCOPE_LABELS[scope] ?? scope}
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-ink-3">
            Not in scope: your messages, passwords, sign-in tokens and the content of other apps. Those can never be
            inspected.
          </p>
        </div>
      ) : null}
    </div>
  );
}
