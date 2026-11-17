"use client";

// =============================================================================
// QORVYNA — admin side of inspection (Phase 8).
//
// Requesting an inspection from here never starts one. It records a request,
// shows the admin exactly what the user will see, and (on a guardian-protected
// account) waits for the guardian. Only after the device confirms does the
// session become active — and the admin can watch the countdown and stop it.
// =============================================================================

import { useState } from "react";
import { Eye, Loader2 } from "lucide-react";
import { Alert, Badge, Button, Card, Field, Input, Select, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import {
  INSPECTION_DEFAULT_MINUTES,
  INSPECTION_MAX_MINUTES,
  INSPECTION_SCOPES,
  SCOPE_LABELS,
  STATUS_TEXT,
  inspectionNotice,
  type InspectionRequest,
  type InspectionScope,
} from "@/lib/inspection";

export function InspectionPanel({ deviceId, targetUid, targetName }: { deviceId: string; targetUid: string; targetName: string }) {
  const toast = useToast();
  const [reason, setReason] = useState("");
  const [minutes, setMinutes] = useState(String(INSPECTION_DEFAULT_MINUTES));
  const [scopes, setScopes] = useState<InspectionScope[]>(["app_diagnostics"]);
  const [working, setWorking] = useState(false);
  const [created, setCreated] = useState<InspectionRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  const preview =
    reason.trim().length > 0
      ? inspectionNotice({ admin_name: "You", admin_email: "", reason: reason.trim(), scopes, minutes: Number(minutes) || INSPECTION_DEFAULT_MINUTES })
      : "";

  function toggle(scope: InspectionScope) {
    setScopes((current) => (current.includes(scope) ? current.filter((value) => value !== scope) : [...current, scope]));
  }

  async function submit() {
    setWorking(true);
    setError(null);
    try {
      const result = await rpc<InspectionRequest>("inspection_request", {
        target_uid: targetUid,
        device_id: deviceId,
        reason,
        scopes,
        minutes: Number(minutes),
      });
      setCreated(result);
      toast(
        result.status === "awaiting_guardian"
          ? "Request sent — the guardian must approve before the device is asked."
          : "Request sent — nothing is inspected until the device confirms on screen.",
      );
    } catch (cause) {
      // The server's explanation is shown verbatim: it names the offending
      // scope or the missing minimum length.
      setError(
        cause instanceof RpcCallError
          ? cause.code === "INSPECTION_ALREADY_ACTIVE"
            ? "An inspection is already pending or running on this device."
            : cause.detail ?? cause.message
          : "The request failed. Nothing was created.",
      );
    } finally {
      setWorking(false);
    }
  }

  if (created) {
    return (
      <Card className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="flex items-center gap-2 font-semibold text-ink">
            <Eye size={16} /> Inspection {created.id.slice(0, 8)}…
          </h2>
          <Badge>{STATUS_TEXT[created.status]}</Badge>
        </div>
        <Alert tone={created.status === "awaiting_guardian" ? "info" : "success"}>
          {created.status === "awaiting_guardian"
            ? "A verified guardian has been asked to approve. The device is not contacted until they do."
            : "The device will show a full notice. The session starts only after its owner confirms, and they can stop it at any moment."}
        </Alert>
        <div className="rounded-xl bg-surface-2/60 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">What {targetName} will see</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{created.reason}</p>
          <ul className="mt-2 flex flex-wrap gap-1.5">
            {created.scopes.map((scope) => (
              <li key={scope} className="rounded-full border border-border bg-surface px-2 py-0.5 text-[11px] text-ink-2">
                {SCOPE_LABELS[scope]}
              </li>
            ))}
          </ul>
        </div>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={() => { setCreated(null); setReason(""); }}>
            Request another
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={async () => {
              try {
                await rpc("inspection_stop", { inspection_id: created.id, reason: "Cancelled by the requesting admin" });
                toast("Request cancelled.");
                setCreated(null);
              } catch {
                toast("Could not cancel the request.");
              }
            }}
          >
            Cancel request
          </Button>
        </div>
      </Card>
    );
  }

  return (
    <Card className="space-y-3">
      <div>
        <h2 className="flex items-center gap-2 font-semibold text-ink">
          <Eye size={16} /> Request an inspection
        </h2>
        <p className="mt-0.5 text-xs text-ink-3">
          The person holding the device sees your name, the reason, the scopes and the duration — and can stop it.
          Guardian-protected accounts need guardian approval first. Messages, passwords and tokens are never in scope.
        </p>
      </div>

      <Field label="Why is this needed?" htmlFor="inspection-reason" hint="At least 10 characters. Shown to the user, and stored in the audit log.">
        <Textarea id="inspection-reason" value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={400} />
      </Field>

      <Field label="Duration" htmlFor="inspection-minutes" hint={`Up to ${INSPECTION_MAX_MINUTES} minutes; the clock starts when the device confirms.`}>
        <Select id="inspection-minutes" value={minutes} onChange={(event) => setMinutes(event.target.value)}>
          {[5, 10, 15, 30].map((value) => (
            <option key={value} value={value}>
              {value} minutes
            </option>
          ))}
        </Select>
      </Field>

      <fieldset>
        <legend className="text-xs font-medium text-ink-2">What may be inspected</legend>
        <div className="mt-1.5 grid gap-1.5 sm:grid-cols-2">
          {INSPECTION_SCOPES.map((scope) => (
            <label key={scope} className="flex items-start gap-2 rounded-lg border border-border px-2.5 py-1.5 text-[12px] text-ink-2">
              <input type="checkbox" className="mt-0.5" checked={scopes.includes(scope)} onChange={() => toggle(scope)} />
              <span>{SCOPE_LABELS[scope]}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {preview ? (
        <div className="rounded-xl bg-surface-2/60 p-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-ink-3">Preview of the device notice</p>
          <p className="mt-1 text-[12.5px] leading-relaxed text-ink-2">{preview}</p>
        </div>
      ) : null}

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="flex justify-end">
        <Button type="button" disabled={working || reason.trim().length < 10 || scopes.length === 0} onClick={() => void submit()}>
          {working ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : <Eye className="mr-1.5 h-4 w-4" />} Send request
        </Button>
      </div>
    </Card>
  );
}
