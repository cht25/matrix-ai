"use client";

// =============================================================================
// QORVYNA — guardian approval for device inspections (Phase 8).
//
// Shown to a VERIFIED guardian. An inspection of a guardian-protected account
// cannot reach the device until the guardian approves here, in addition to the
// device owner confirming on-device.
//
// The backend re-verifies the guardian relationship on the decision itself, so
// nothing here is trusted: this component only renders what the server returns.
// =============================================================================

import { useCallback, useEffect, useState } from "react";
import { Check, Loader2, ShieldQuestion, X } from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { SCOPE_LABELS, type InspectionRequest } from "@/lib/inspection";

export function GuardianInspections() {
  const toast = useToast();
  const [rows, setRows] = useState<InspectionRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await rpc<InspectionRequest[]>("inspection_guardian_queue");
      setRows(Array.isArray(result) ? result : []);
      setError(null);
    } catch (cause) {
      setRows([]);
      setError(cause instanceof RpcCallError ? "Approval requests could not be loaded." : "Network error.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function decide(request: InspectionRequest, approve: boolean) {
    setBusy(request.id);
    try {
      await rpc("inspection_guardian_decide", { inspection_id: request.id, approve, note: note.trim() });
      toast(
        approve
          ? "Approved. The device owner is shown the notice and decides whether to allow it."
          : "Declined. Nothing will be inspected.",
      );
      setNote("");
      await load();
    } catch (cause) {
      toast(
        cause instanceof RpcCallError && cause.code === "FORBIDDEN"
          ? "Only a verified guardian can decide this."
          : "The decision could not be saved — nothing was changed.",
      );
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-ink">
          <ShieldQuestion size={16} /> Inspection approvals
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">
          A QORVYNA administrator has asked to inspect diagnostics on a device you protect. Approval is needed{" "}
          <strong>before</strong> the device is even asked; the person using it still gets the final say and can stop it
          at any time. Messages, passwords and tokens are never in scope.
        </p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      {rows === null ? (
        <div className="flex items-center gap-2 py-3 text-sm text-ink-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading requests…
        </div>
      ) : rows.length === 0 ? (
        <EmptyState title="Nothing waiting" body="Approval requests for devices you protect will appear here." />
      ) : (
        <ul className="space-y-3">
          {rows.map((request) => (
            <li key={request.id} className="rounded-xl border border-border p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-ink">
                    {request.admin_name || request.admin_email || "Administrator"} · {request.minutes} minutes
                  </p>
                  <p className="mt-0.5 text-[12.5px] leading-relaxed text-ink-2">{request.reason}</p>
                </div>
                <Badge>Waiting for you</Badge>
              </div>
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {request.scopes.map((scope) => (
                  <li key={scope} className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-ink-2">
                    {SCOPE_LABELS[scope] ?? scope}
                  </li>
                ))}
              </ul>
              <Textarea
                className="mt-2"
                rows={2}
                value={note}
                onChange={(event) => setNote(event.target.value)}
                placeholder="Optional note for the audit trail"
                maxLength={300}
              />
              <div className="mt-2 flex justify-end gap-2">
                <Button type="button" variant="ghost" disabled={busy === request.id} onClick={() => void decide(request, false)}>
                  <X className="mr-1.5 h-4 w-4" /> Decline
                </Button>
                <Button type="button" disabled={busy === request.id} onClick={() => void decide(request, true)}>
                  {busy === request.id ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Check className="mr-1.5 h-4 w-4" />} Approve
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
