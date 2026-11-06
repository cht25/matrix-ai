"use client";

// MATRIX Connect — device center. QR pairing uses short-lived, signed,
// one-time challenges; the QR never contains credentials. Only data the
// device itself reports is shown — nothing is monitored silently.

import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, EmptyState, Field, Textarea } from "@/components/ui";
import { useToast } from "@/components/toast";
import { Smartphone } from "lucide-react";

type Device = {
  id: string;
  device_name: string;
  device_type: string;
  platform: string;
  scopes: string[];
  paired_at: string;
  revoked_at: string | null;
};

type Challenge = { challenge_id: string; qr_payload: string; qr_data_url: string; expires_at: string };

function detectPlatform(): { device_type: string; platform: string } {
  const ua = navigator.userAgent;
  if (/Android/i.test(ua)) return { device_type: "phone", platform: "android" };
  if (/Windows/i.test(ua)) return { device_type: "desktop", platform: "windows" };
  if (/Mac/i.test(ua)) return { device_type: "desktop", platform: "macos" };
  return { device_type: "browser", platform: "web" };
}

export function DevicesClient() {
  const toast = useToast();
  const [devices, setDevices] = useState<Device[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [payload, setPayload] = useState("");
  const [deviceName, setDeviceName] = useState("");
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/devices", { credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      setDevices(((await res.json()) as { devices: Device[] }).devices);
    } catch {
      setError("Could not load devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function createChallenge() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/devices/pairing/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ device_label: deviceName || undefined }),
      });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      const ch = (await res.json()) as Challenge;
      setChallenge(ch);
      toast("Pairing challenge created — scan it from the new device within 5 minutes.");
    } catch {
      toast("Could not create a pairing challenge.");
    } finally {
      setBusy(false);
    }
  }

  async function completePairing() {
    if (!payload.trim()) return;
    setBusy(true);
    try {
      const { device_type, platform } = detectPlatform();
      const res = await fetch("/api/devices/pairing/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          qr_payload: payload.trim(),
          device_name: deviceName.trim() || `${platform} device`,
          device_type,
          platform,
        }),
      });
      const body = (await res.json()) as { device?: Device; error?: string };
      if (!res.ok) throw new Error(body.error ?? "HTTP_" + res.status);
      setPayload("");
      setChallenge(null);
      toast(`Device "${body.device?.device_name}" linked.`);
      await load();
    } catch (err) {
      toast(err instanceof Error ? err.message.replace(/_/g, " ").toLowerCase() : "Pairing failed.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    setBusy(true);
    try {
      const res = await fetch(`/api/devices?id=${encodeURIComponent(id)}`, { method: "DELETE", credentials: "same-origin" });
      if (!res.ok) throw new Error("HTTP_" + res.status);
      toast("Device access revoked.");
      await load();
    } catch {
      toast("Could not revoke the device.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Connected Devices</h1>
        <p className="mt-1 text-ink-2">
          Link phones, desktops and watches to your account with a one-time QR code. Pairing is explicit, short-lived and
          revocable — no device is ever monitored silently.
        </p>
      </div>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="space-y-3 p-4">
          <h2 className="font-semibold text-ink">Add a device (show QR)</h2>
          <Field label="Device label (optional)" htmlFor="device-label">
            <input
              id="device-label"
              className="input-base"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="e.g. Shahriar's Pixel"
              maxLength={80}
            />
          </Field>
          <Button onClick={createChallenge} disabled={busy}>Generate pairing QR</Button>
          {challenge ? (
            <div className="space-y-2 border-t border-border pt-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={challenge.qr_data_url} alt="MATRIX pairing QR code" className="h-56 w-56 rounded-[12px] bg-white p-2" />
              <p className="text-xs text-ink-3">
                Expires {new Date(challenge.expires_at).toLocaleTimeString()} · single use · contains no credentials.
              </p>
              <details className="text-xs text-ink-3">
                <summary className="cursor-pointer">Show raw payload</summary>
                <code className="mt-1 block break-all rounded-[8px] bg-surface-2 p-2 font-mono">{challenge.qr_payload}</code>
              </details>
            </div>
          ) : null}
        </Card>

        <Card className="space-y-3 p-4">
          <h2 className="font-semibold text-ink">Pair this device</h2>
          <Field label="QR payload from the other device" htmlFor="qr-payload" hint="Paste the matrix-pairing payload shown on the device that generated the QR.">
            <Textarea
              id="qr-payload"
              value={payload}
              onChange={(e) => setPayload(e.target.value)}
              placeholder="matrix-pairing:v1.…"
              rows={4}
            />
          </Field>
          <Button variant="secondary" onClick={completePairing} disabled={busy || !payload.trim()}>
            Complete pairing
          </Button>
        </Card>
      </div>

      {loading ? (
        <Card className="p-4 text-sm text-ink-3">Loading devices…</Card>
      ) : devices.length === 0 ? (
        <EmptyState icon={<Smartphone size={22} />} title="No devices linked" body="Generate a pairing QR above and scan it from another signed-in device." />
      ) : (
        <Card className="p-4">
          <h2 className="mb-3 font-semibold text-ink">Linked devices ({devices.length})</h2>
          <ul className="space-y-2">
            {devices.map((d) => (
              <li key={d.id} className="flex flex-wrap items-center justify-between gap-2 rounded-[10px] bg-surface-2 px-3 py-2">
                <div>
                  <p className="font-medium text-ink">{d.device_name}</p>
                  <p className="text-xs text-ink-3">
                    <Badge>{d.platform}</Badge> <Badge>{d.device_type}</Badge> paired{" "}
                    {d.paired_at ? new Date(d.paired_at).toLocaleString() : "—"} · scopes: {d.scopes.join(", ")}
                  </p>
                </div>
                <Button variant="danger" onClick={() => void revoke(d.id)} disabled={busy}>
                  Unlink
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
    </div>
  );
}
