"use client";

// MATRIX Connect — unified Device Center:
//  1. Connected Devices: own-account QR pairing + cross-account Family QR
//     pairing (different accounts work out of the box; all QR codes in popups).
//  2. My Device Activity: own screen time, app usage, hidden apps, and browser
//     history synced from MATRIX Desktop (Tauri) / Android Companion / Web.
//  3. ESP32 Hardware Nodes: pair ESP32 / ESP32-S3 / ESP32-C3 / ESP8266 nodes,
//     generate ready-to-flash Arduino .ino firmware, and control lamp + focus.

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity, Check, Clock, Code2, Copy, Cpu, Download, Eye, Globe, Lightbulb,
  Loader2, Monitor, Plus, QrCode, RefreshCw, ShieldAlert, ShieldCheck,
  Smartphone, Sun, Tablet, Trash2, Watch, Wifi, WifiOff,
} from "lucide-react";
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Select } from "@/components/ui";
import { Modal, ConfirmModal } from "@/components/modal";
import { UserAvatar } from "@/components/avatar";
import { useToast } from "@/components/toast";
import { rpc, RpcCallError } from "@/lib/client/api";
import { isTauriApp, notifyWorkDone } from "@/lib/client/work-notifications";
import {
  ESP32_BOARDS,
  ESP32_CAPABILITIES,
  esp32FirmwareSource,
  type Esp32BoardId,
  type Esp32Capability,
} from "@/lib/esp32";
import type { FamilyListRow, FamilyMemberSummary, MirrorState } from "@/lib/family";
import { cn } from "@/lib/utils";
import { DeviceHub } from "@/components/devices/device-hub";

type Device = {
  id: string;
  device_name: string;
  device_type: string;
  platform: string;
  scopes: string[];
  paired_at: string;
  last_seen_at?: string;
  revoked_at: string | null;
};

type FamilyLinkedDevice = {
  id: string;
  user_id: string;
  member_id: string;
  owner_name: string;
  owner_avatar: string;
  device_name: string;
  device_type: string;
  platform: string;
  mirror_state: MirrorState;
  paired_at: string;
  last_seen_at: string;
};

type OwnActivitySnapshot = {
  id: string;
  device_id: string;
  device_name: string;
  platform: string;
  reported_at: string;
  screen_time_minutes: number;
  apps: Array<{ name: string; package: string; minutes: number; hidden: boolean; last_used: string }>;
  hidden_apps: Array<{ name: string; package: string; minutes: number; hidden: boolean; last_used: string }>;
  browser_history: Array<{ url: string; title: string; visited_at: string }>;
};

type Esp32Node = {
  id: string;
  label: string;
  board: Esp32BoardId;
  board_label: string;
  capabilities: Esp32Capability[];
  family_id: string | null;
  lamp: number;
  focus_mode: boolean;
  last_seq: number;
  last_seen_at: string;
  online: boolean;
  last_values: Record<string, number | boolean | string>;
  last_event: { type: string; message: string; at: string } | null;
  paired_at: string;
};

type Esp32PairingGrant = {
  pairing_id: string;
  pairing_code: string;
  qr_payload: string;
  qr_data_url: string;
  expires_at: string;
  label: string;
  board: Esp32BoardId;
  capabilities: Esp32Capability[];
};

type Challenge = { challenge_id: string; qr_payload: string; qr_data_url: string; expires_at: string };
type FamilyPairing = { qr_payload: string; pair_url?: string; qr_data_url: string; expires_at: string; member_id: string; member_name: string };

const CAPABILITY_LABEL: Record<Esp32Capability, string> = {
  check_in_button: "Check-in button",
  presence_sensor: "Presence sensor",
  screen_time_lamp: "Screen-time lamp (PWM)",
  focus_mode: "Focus mode toggle",
  sos_alarm: "SOS hold button",
  display: "Status display",
};

const MIRROR_BADGE: Record<MirrorState, string> = {
  never: "Mirror: not set",
  granted: "Mirror: ready",
  revoked_by_child: "Mirror: disabled by member",
  denied_by_parent: "Mirror: off",
  expired: "Mirror: expired",
};

function platformIcon(platform: string) {
  if (platform === "android" || platform === "ios") return <Smartphone size={16} />;
  if (platform === "wearos" || platform === "watchos") return <Watch size={16} />;
  if (platform === "ipados") return <Tablet size={16} />;
  return <Monitor size={16} />;
}

function detectPlatform(): { device_type: string; platform: string } {
  const ua = navigator.userAgent;
  if (isTauriApp()) {
    if (/Windows/i.test(ua)) return { device_type: "desktop", platform: "windows-tauri" };
    if (/Mac/i.test(ua)) return { device_type: "desktop", platform: "macos-tauri" };
    return { device_type: "desktop", platform: "linux-tauri" };
  }
  if (/Android/i.test(ua)) return { device_type: "phone", platform: "android" };
  if (/iPhone/i.test(ua)) return { device_type: "phone", platform: "ios" };
  if (/iPad/i.test(ua)) return { device_type: "tablet", platform: "ipados" };
  if (/Windows/i.test(ua)) return { device_type: "desktop", platform: "windows" };
  if (/Mac/i.test(ua)) return { device_type: "desktop", platform: "macos" };
  if (/Linux/i.test(ua)) return { device_type: "desktop", platform: "linux" };
  return { device_type: "browser", platform: "web" };
}

function message(err: unknown, fallback: string): string {
  if (err instanceof RpcCallError) {
    const map: Record<string, string> = {
      PAIRING_ACCOUNT_MISMATCH:
        "That QR is an own-account QR. To link a device signed in to a DIFFERENT account, use “Cross-Account Family QR” instead.",
      PAIRING_EXPIRED: "That pairing link expired. Generate a fresh QR.",
      PAIRING_USED: "That pairing link was already used.",
      PAIRING_INVALID: "That pairing code is invalid.",
      NOT_A_MEMBER: "Sign in with the account that belongs to the selected family member.",
      PERMISSION_DENIED: "Your role does not allow that action.",
    };
    return map[err.code] ?? err.code.replace(/_/g, " ").toLowerCase();
  }
  return fallback;
}

function relative(iso?: string): string {
  if (!iso) return "never";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h ago`;
  return new Date(iso).toLocaleDateString();
}

export function DevicesClient() {
  const toast = useToast();
  const [tab, setTab] = useState<"devices" | "activity" | "esp32">("devices");
  const [devices, setDevices] = useState<Device[]>([]);
  const [ownActivity, setOwnActivity] = useState<OwnActivitySnapshot[]>([]);
  const [esp32Nodes, setEsp32Nodes] = useState<Esp32Node[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");

  // Own-account + manual code pairing modals
  const [deviceName, setDeviceName] = useState("");
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [qrOpen, setQrOpen] = useState(false);
  const [pairInput, setPairInput] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [pairOpen, setPairOpen] = useState(false);

  // Cross-account family devices & QR modal
  const [families, setFamilies] = useState<FamilyListRow[]>([]);
  const [familyId, setFamilyId] = useState("");
  const [members, setMembers] = useState<FamilyMemberSummary[]>([]);
  const [familyDevices, setFamilyDevices] = useState<FamilyLinkedDevice[]>([]);
  const [memberId, setMemberId] = useState("");
  const [familyPair, setFamilyPair] = useState<FamilyPairing | null>(null);
  const [familyQrOpen, setFamilyQrOpen] = useState(false);
  const [confirmUnlink, setConfirmUnlink] = useState<{ id: string; name: string; kind: "own" | "family" | "esp32" } | null>(null);

  // Activity sub-view
  const [selectedActivityIdx, setSelectedActivityIdx] = useState(0);
  const [activitySubTab, setActivitySubTab] = useState<"apps" | "hidden" | "history">("apps");

  // ESP32 pairing & firmware builder modals
  const [espModalOpen, setEspModalOpen] = useState(false);
  const [espGrant, setEspGrant] = useState<Esp32PairingGrant | null>(null);
  const [phoneRelease, setPhoneRelease] = useState<{
    latest_version: string;
    latest_build: number;
    apk_url: string;
    chat_url: string;
    release_notes: string;
    force_update: boolean;
  } | null>(null);

  const checkPhoneRelease = useCallback(async (showToast = false) => {
    try {
      const res = await fetch("/api/app/version?platform=android", { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as {
        latest_version?: string;
        latest_build?: number;
        apk_url?: string;
        chat_url?: string;
        release_notes?: string;
        force_update?: boolean;
      };
      if (data.latest_version) {
        setPhoneRelease({
          latest_version: data.latest_version,
          latest_build: data.latest_build ?? 1,
          apk_url: data.apk_url ?? "https://github.com/cht25/matrix-ai/releases/latest/download/matrix-android.apk",
          chat_url: data.chat_url ?? "https://matrix.thamjj13.top/chat",
          release_notes: data.release_notes ?? "",
          force_update: Boolean(data.force_update),
        });
        if (showToast) toast(`Latest MATRIX Phone App: v${data.latest_version} (build ${data.latest_build ?? 1})`);
      }
    } catch {
      if (showToast) toast("Could not reach update server.");
    }
  }, [toast]);

  useEffect(() => {
    void checkPhoneRelease(false);
  }, [checkPhoneRelease]);
  const [espQrOpen, setEspQrOpen] = useState(false);
  const [espFirmwareOpen, setEspFirmwareOpen] = useState(false);
  const [espLabel, setEspLabel] = useState("Desk Guard ESP32");
  const [espBoard, setEspBoard] = useState<Esp32BoardId>("esp32-devkit");
  const [espCaps, setEspCaps] = useState<Esp32Capability[]>([
    "check_in_button",
    "screen_time_lamp",
    "focus_mode",
    "sos_alarm",
  ]);
  const [wifiSsid, setWifiSsid] = useState("");
  const [wifiPassword, setWifiPassword] = useState("");

  const load = useCallback(async () => {
    try {
      const [devRes, actList, nodes] = await Promise.all([
        fetch("/api/devices", { credentials: "same-origin" }),
        rpc<OwnActivitySnapshot[]>("device_activity_latest").catch(() => [] as OwnActivitySnapshot[]),
        rpc<Esp32Node[]>("esp32_list").catch(() => [] as Esp32Node[]),
      ]);
      if (!devRes.ok) throw new Error(`HTTP_${devRes.status}`);
      setDevices(((await devRes.json()) as { devices: Device[] }).devices);
      setOwnActivity(actList);
      setEsp32Nodes(nodes);
      setError("");
    } catch {
      setError("Could not load your devices.");
    } finally {
      setLoading(false);
    }
  }, []);

  const loadFamily = useCallback(async () => {
    try {
      const list = await rpc<FamilyListRow[]>("family_list");
      setFamilies(list);
      setFamilyId((current) => (current && list.some((row) => row.family_id === current) ? current : list[0]?.family_id ?? ""));
    } catch {
      setFamilies([]);
    }
  }, []);

  const loadFamilyDetails = useCallback(async (id: string) => {
    if (!id) {
      setMembers([]);
      setFamilyDevices([]);
      return;
    }
    try {
      const [overview, linked] = await Promise.all([
        rpc<{ members: FamilyMemberSummary[] }>("family_overview", { family_id: id }),
        rpc<FamilyLinkedDevice[]>("family_devices", { family_id: id }).catch(() => [] as FamilyLinkedDevice[]),
      ]);
      setMembers(overview.members);
      setMemberId((prev) => (prev && overview.members.some((m) => m.member_id === prev) ? prev : overview.members[0]?.member_id ?? ""));
      setFamilyDevices(linked);
    } catch {
      setMembers([]);
      setFamilyDevices([]);
    }
  }, []);

  useEffect(() => {
    void load();
    void loadFamily();
    const params = new URLSearchParams(window.location.hash.slice(1));
    const code = params.get("pair");
    if (code) {
      setJoinCode(code);
      setPairOpen(true);
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
    }
    const refresh = () => {
      if (!document.hidden) void load();
    };
    const timer = window.setInterval(refresh, 30_000);
    window.addEventListener("focus", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [load, loadFamily]);

  useEffect(() => {
    void loadFamilyDetails(familyId);
  }, [familyId, loadFamilyDetails]);

  useEffect(() => {
    if (!challenge) return;
    const ms = new Date(challenge.expires_at).getTime() - Date.now();
    if (ms <= 0) return;
    const timer = window.setTimeout(() => {
      setChallenge(null);
      setQrOpen(false);
    }, ms);
    return () => window.clearTimeout(timer);
  }, [challenge]);

  const active = useMemo(() => devices.filter((device) => !device.revoked_at), [devices]);
  const currentActivity = ownActivity[selectedActivityIdx] ?? ownActivity[0] ?? null;

  const generatedSketch = useMemo(() => {
    const origin = typeof window !== "undefined" ? window.location.origin : "https://matrix-ai.example.com";
    return esp32FirmwareSource({
      endpoint: origin,
      pairingCode: espGrant?.pairing_code || "PASTE_PAIRING_CODE_HERE",
      wifiSsid: wifiSsid || "YOUR_WIFI_SSID",
      wifiPassword: wifiPassword || "YOUR_WIFI_PASSWORD",
      board: espBoard,
      label: espLabel || "MATRIX ESP32",
      capabilities: espCaps,
    });
  }, [espGrant, wifiSsid, wifiPassword, espBoard, espLabel, espCaps]);

  async function createChallenge() {
    setBusy("challenge");
    try {
      const res = await fetch("/api/devices/pairing/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ device_label: deviceName || undefined }),
      });
      if (!res.ok) throw new Error(`HTTP_${res.status}`);
      setChallenge((await res.json()) as Challenge);
      setQrOpen(true);
    } catch {
      toast("Could not create a pairing QR. Try again.");
    } finally {
      setBusy("");
    }
  }

  async function completePairing() {
    if (!pairInput.trim()) return;
    setBusy("pair");
    try {
      const { device_type, platform } = detectPlatform();
      const res = await fetch("/api/devices/pairing/complete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          qr_payload: pairInput.trim(),
          device_name: deviceName.trim() || `${platform} device`,
          device_type,
          platform,
        }),
      });
      const body = (await res.json()) as { device?: Device; error?: string };
      if (!res.ok) throw new RpcCallError(body.error ?? `HTTP_${res.status}`, res.status);
      setPairInput("");
      setPairOpen(false);
      toast(`Device “${body.device?.device_name}” linked.`);
      void notifyWorkDone({
        title: "Device paired",
        body: `${body.device?.device_name ?? "Device"} is now linked to your MATRIX account.`,
        link: "/devices",
      });
      await load();
    } catch (err) {
      setError(message(err, "Pairing failed."));
    } finally {
      setBusy("");
    }
  }

  async function createFamilyPairing() {
    if (!familyId) return;
    setBusy("family-pair");
    setError("");
    try {
      const result = await rpc<FamilyPairing>("family_pairing_create", {
        family_id: familyId,
        member_id: memberId || undefined,
        device_label: deviceName || undefined,
      });
      setFamilyPair(result);
      setFamilyQrOpen(true);
    } catch (err) {
      setError(message(err, "Could not create a cross-account family QR."));
    } finally {
      setBusy("");
    }
  }

  async function completeFamilyPairing() {
    if (!joinCode.trim()) return;
    setBusy("family-join");
    setError("");
    try {
      const { device_type, platform } = detectPlatform();
      const raw = joinCode.trim();
      const urlMatch = /[?&#]pair=([A-Za-z0-9_-]+)/.exec(raw);
      const token = urlMatch ? urlMatch[1] : raw.includes(".") ? raw.split(".").pop()! : raw;
      await rpc("family_pairing_complete", {
        pair_token: token,
        device_name: deviceName.trim() || `${platform} device`,
        device_type,
        platform,
      });
      setJoinCode("");
      setPairOpen(false);
      toast("This device is now linked to your family (cross-account).");
      void notifyWorkDone({
        title: "Family device linked",
        body: "This device is now connected to your MATRIX Family.",
        link: "/devices",
      });
      await Promise.all([load(), loadFamily(), familyId ? loadFamilyDetails(familyId) : Promise.resolve()]);
    } catch (err) {
      setError(message(err, "Linking this device to the family failed."));
    } finally {
      setBusy("");
    }
  }

  async function handleUnlink(target: { id: string; name: string; kind: "own" | "family" | "esp32" }) {
    setBusy(`revoke-${target.id}`);
    try {
      if (target.kind === "own") {
        const res = await fetch(`/api/devices?id=${encodeURIComponent(target.id)}`, {
          method: "DELETE",
          credentials: "same-origin",
        });
        if (!res.ok) throw new Error(`HTTP_${res.status}`);
      } else if (target.kind === "family") {
        await rpc("family_device_revoke", { device_id: target.id });
      } else {
        await rpc("esp32_revoke", { id: target.id });
      }
      toast(`Unlinked ${target.name}.`);
      await Promise.all([load(), familyId ? loadFamilyDetails(familyId) : Promise.resolve()]);
    } catch (err) {
      toast(message(err, "Could not unlink device."));
    } finally {
      setBusy("");
    }
  }

  async function syncThisDeviceActivity() {
    setBusy("sync-activity");
    try {
      const { platform } = detectPlatform();
      let payload: Record<string, unknown> | null = null;
      if (isTauriApp()) {
        const invoke = (window as unknown as { __TAURI_INTERNALS__?: { invoke?: (cmd: string) => Promise<unknown> } })
          .__TAURI_INTERNALS__?.invoke;
        if (typeof invoke === "function") {
          try {
            const nativeSnap = (await invoke("matrix_collect_device_activity")) as Record<string, unknown> | null;
            if (nativeSnap && typeof nativeSnap === "object") payload = nativeSnap;
          } catch {
            // No native report available; handled below.
          }
        }
      }

      if (!payload) {
        // A web page cannot see app usage or screen time, and MATRIX never
        // substitutes made-up figures for a real device report.
        setError("Activity reports come from the MATRIX desktop app. A browser can't measure app usage or screen time, so there is nothing to sync from here.");
        return;
      }

      await rpc("device_activity_report", payload);
      await load();
      toast("Synced this device's activity report.");
      void notifyWorkDone({
        title: "Device activity synced",
        body: "App usage, hidden apps, and browser history are up to date.",
        link: "/devices",
      });
    } catch (err) {
      setError(message(err, "Could not sync device activity."));
    } finally {
      setBusy("");
    }
  }

  async function createEsp32Grant() {
    setBusy("esp-pair");
    setError("");
    try {
      const grant = await rpc<Esp32PairingGrant>("esp32_pairing_create", {
        label: espLabel.trim() || "MATRIX ESP32",
        board: espBoard,
        capabilities: espCaps,
        family_id: familyId || null,
      });
      setEspGrant(grant);
      setEspModalOpen(false);
      setEspQrOpen(true);
    } catch (err) {
      setError(message(err, "Could not generate ESP32 pairing code."));
    } finally {
      setBusy("");
    }
  }

  async function updateEspNode(id: string, patch: { lamp?: number; focus_mode?: boolean }) {
    setBusy(`esp-${id}`);
    try {
      await rpc("esp32_update", { id, ...patch });
      await load();
    } catch (err) {
      toast(message(err, "Could not update ESP32 node."));
    } finally {
      setBusy("");
    }
  }

  function toggleEspCap(cap: Esp32Capability) {
    setEspCaps((prev) => (prev.includes(cap) ? prev.filter((c) => c !== cap) : [...prev, cap]));
  }

  function downloadSketch() {
    const blob = new Blob([generatedSketch], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${(espLabel || "matrix_esp32").toLowerCase().replace(/[^a-z0-9]+/g, "_")}.ino`;
    a.click();
    URL.revokeObjectURL(url);
    toast("Downloaded Arduino .ino firmware.");
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="eyebrow">MATRIX Connect &amp; Hardware</p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Devices</h1>
          <p className="mt-1 max-w-2xl text-sm text-ink-2">
            Register this device as a Parent or a Child, approve new devices, and manage what each one can do.
            Family devices and ESP32 hardware are below.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" onClick={() => void load()}>
            <RefreshCw size={15} /> Refresh
          </Button>
          <Button variant="secondary" onClick={() => setPairOpen(true)}>
            Enter Family code
          </Button>
        </div>
      </header>

      {error ? <Alert tone="danger">{error}</Alert> : null}

      <Card className="flex flex-wrap items-center justify-between gap-4 border-accent/25 bg-surface-2/50">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-sm font-semibold text-ink">
              <Smartphone size={16} className="text-accent" /> MATRIX Phone App &amp; OTA Updates
            </span>
            <Badge className="!border-accent/40 !text-accent">
              v{phoneRelease?.latest_version ?? "1.1.0"} · build {phoneRelease?.latest_build ?? 2}
            </Badge>
            {phoneRelease?.force_update ? <Badge className="!border-warning/40 !text-warning">Mandatory update</Badge> : null}
          </div>
          <p className="mt-1 text-xs text-ink-2">
            Official Android companion app with automatic over-the-air version checks, QR pairing, Family screen supervision, and instant sync with{" "}
            <span className="mono text-ink">{phoneRelease?.chat_url ?? "https://matrix.thamjj13.top/chat"}</span>.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" onClick={() => void checkPhoneRelease(true)}>
            <RefreshCw size={14} /> Check update
          </Button>
          <a
            href={phoneRelease?.apk_url ?? "https://github.com/cht25/matrix-ai/releases/latest/download/matrix-android.apk"}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex min-h-9 items-center gap-1.5 rounded-xl bg-accent px-3.5 text-xs font-semibold text-accent-ink hover:bg-accent-hover"
          >
            <Download size={14} /> Download Android APK
          </a>
        </div>
      </Card>

      {/* Top section tabs */}
      <div className="flex flex-wrap gap-2 border-b border-border pb-3">
        <button
          type="button"
          onClick={() => setTab("devices")}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors",
            tab === "devices" ? "bg-accent text-accent-ink" : "bg-surface-2/70 text-ink-2 hover:text-ink",
          )}
        >
          <Smartphone size={15} /> Devices
        </button>
        <button
          type="button"
          onClick={() => setTab("activity")}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors",
            tab === "activity" ? "bg-accent text-accent-ink" : "bg-surface-2/70 text-ink-2 hover:text-ink",
          )}
        >
          <Activity size={15} /> App Usage, Hidden Apps &amp; History
        </button>
        <button
          type="button"
          onClick={() => setTab("esp32")}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2 text-sm font-medium transition-colors",
            tab === "esp32" ? "bg-accent text-accent-ink" : "bg-surface-2/70 text-ink-2 hover:text-ink",
          )}
        >
          <Cpu size={15} /> ESP32 Hardware ({esp32Nodes.length})
        </button>
      </div>

      {/* =================================================================== */}
      {/* TAB 1: CONNECTED DEVICES (OWN + CROSS-ACCOUNT FAMILY)               */}
      {/* =================================================================== */}
      {tab === "devices" ? (
        <div className="space-y-5">
          <DeviceHub />
          <div className="grid gap-4">
            {/* Cross-account family devices */}
            <Card className="space-y-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <h2 className="font-semibold text-ink">Cross-Account Family Devices</h2>
                  <p className="mt-0.5 text-xs text-ink-3">
                    No same-account login needed! Generate a QR popup for any family member — they scan it while signed
                    in to <strong>their own account</strong>.
                  </p>
                </div>
                <Badge>{familyDevices.length} linked</Badge>
              </div>

              {families.length > 0 ? (
                <div className="grid gap-2 sm:grid-cols-2">
                  <Field label="Family" htmlFor="device-family">
                    <Select id="device-family" value={familyId} onChange={(e) => setFamilyId(e.target.value)}>
                      {families.map((f) => (
                        <option key={f.family_id} value={f.family_id}>
                          {f.name || "Family"}
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <Field label="Family member" htmlFor="device-member">
                    <Select id="device-member" value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                      {members.map((m) => (
                        <option key={m.member_id} value={m.member_id}>
                          {m.display_name || m.email || "Member"} ({m.role})
                        </option>
                      ))}
                    </Select>
                  </Field>
                  <div className="sm:col-span-2">
                    <Button
                      className="w-full justify-center"
                      onClick={() => void createFamilyPairing()}
                      disabled={busy === "family-pair" || !familyId}
                    >
                      {busy === "family-pair" ? (
                        <Loader2 size={15} className="animate-spin" />
                      ) : (
                        <QrCode size={15} />
                      )}{" "}
                      Open Cross-Account Family QR Popup
                    </Button>
                  </div>
                </div>
              ) : (
                <p className="rounded-xl border border-dashed border-border p-3 text-xs text-ink-3">
                  Create or join a family on the <strong>Family</strong> page first to pair cross-account member
                  devices.
                </p>
              )}

              {familyDevices.length > 0 ? (
                <ul className="space-y-2 border-t border-border pt-3">
                  {familyDevices.map((fd) => (
                    <li
                      key={fd.id}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-surface-2/60 p-3"
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <UserAvatar src={fd.owner_avatar} name={fd.owner_name} size={32} />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-ink">
                            {fd.device_name}{" "}
                            <span className="text-xs font-normal text-ink-3">· {fd.owner_name || "Member"}</span>
                          </span>
                          <span className="block text-[11px] text-ink-3">
                            {fd.platform} · seen {relative(fd.last_seen_at)} · {MIRROR_BADGE[fd.mirror_state]}
                          </span>
                        </span>
                      </span>
                      <Button
                        variant="ghost"
                        className="!min-h-8 !px-2 text-danger"
                        onClick={() => setConfirmUnlink({ id: fd.id, name: fd.device_name, kind: "family" })}
                      >
                        <Trash2 size={14} /> Unlink
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </Card>
          </div>
        </div>
      ) : null}

      {/* =================================================================== */}
      {/* TAB 2: OWN DEVICE APP USAGE, HIDDEN APPS & BROWSER HISTORY          */}
      {/* =================================================================== */}
      {tab === "activity" ? (
        <Card className="space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="font-semibold text-ink">My Device App Usage, Hidden Apps &amp; Browser History</h2>
              <p className="mt-1 max-w-2xl text-xs text-ink-3">
                Inspect your own screen time, installed/foreground apps, launcher-hidden apps, and browser visits across
                MATRIX Desktop (Tauri), MATRIX Android Companion, and Web. (To view a child&apos;s device reports, open{" "}
                <strong>Family → click member</strong>.)
              </p>
            </div>
            <Button onClick={() => void syncThisDeviceActivity()} disabled={busy === "sync-activity"}>
              {busy === "sync-activity" ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />} Sync
              this device now
            </Button>
          </div>

          {ownActivity.length > 1 ? (
            <div className="flex flex-wrap gap-1.5">
              {ownActivity.map((snap, idx) => (
                <button
                  key={snap.id}
                  type="button"
                  onClick={() => setSelectedActivityIdx(idx)}
                  className={cn(
                    "rounded-lg border px-3 py-1.5 text-xs font-medium",
                    selectedActivityIdx === idx
                      ? "border-accent bg-accent-soft text-accent"
                      : "border-border text-ink-2 hover:text-ink",
                  )}
                >
                  {snap.device_name} ({snap.platform})
                </button>
              ))}
            </div>
          ) : null}

          {!currentActivity ? (
            <EmptyState
              icon={<Activity size={22} />}
              title="No device activity synced yet"
              body="Activity appears here once the MATRIX desktop app reports it. Browsers and the current Android app do not collect app usage."
              action={
                <Button onClick={() => void syncThisDeviceActivity()} disabled={busy === "sync-activity"}>
                  Sync this device now
                </Button>
              }
            />
          ) : (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-4">
                <div className="rounded-xl border border-border p-3">
                  <p className="flex items-center gap-1 text-xs text-ink-3">
                    <Clock size={12} /> Screen time
                  </p>
                  <p className="mt-1 text-xl font-semibold text-ink">
                    {Math.floor(currentActivity.screen_time_minutes / 60)}h{" "}
                    {currentActivity.screen_time_minutes % 60}m
                  </p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="text-xs text-ink-3">Apps used</p>
                  <p className="mt-1 text-xl font-semibold text-ink">{currentActivity.apps.length}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="flex items-center gap-1 text-xs text-ink-3">
                    <ShieldAlert size={12} className="text-warning" /> Hidden apps
                  </p>
                  <p className="mt-1 text-xl font-semibold text-ink">{currentActivity.hidden_apps.length}</p>
                </div>
                <div className="rounded-xl border border-border p-3">
                  <p className="flex items-center gap-1 text-xs text-ink-3">
                    <Globe size={12} /> Browser visits
                  </p>
                  <p className="mt-1 text-xl font-semibold text-ink">{currentActivity.browser_history.length}</p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border pb-2">
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => setActivitySubTab("apps")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activitySubTab === "apps" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    App Usage ({currentActivity.apps.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivitySubTab("hidden")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activitySubTab === "hidden" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    Hidden Apps ({currentActivity.hidden_apps.length})
                  </button>
                  <button
                    type="button"
                    onClick={() => setActivitySubTab("history")}
                    className={cn(
                      "rounded-lg px-3 py-1.5 text-xs font-medium",
                      activitySubTab === "history" ? "bg-accent-soft text-accent" : "text-ink-3 hover:text-ink",
                    )}
                  >
                    Browser History ({currentActivity.browser_history.length})
                  </button>
                </div>
                <span className="text-[11px] text-ink-3">
                  {currentActivity.device_name} · synced {relative(currentActivity.reported_at)}
                </span>
              </div>

              {activitySubTab === "apps" ? (
                currentActivity.apps.length === 0 ? (
                  <p className="py-4 text-xs text-ink-3">No foreground app records in this snapshot.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-border">
                    {currentActivity.apps.map((app, i) => (
                      <li key={`${app.name}-${i}`} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                        <span className="min-w-0 truncate text-ink">
                          <span className="font-medium">{app.name}</span>
                          {app.package ? <span className="ml-2 font-mono text-[11px] text-ink-3">{app.package}</span> : null}
                          {app.hidden ? <Badge className="ml-2 !border-warning/40 !text-warning">hidden</Badge> : null}
                        </span>
                        <span className="shrink-0 font-mono text-ink-2">{app.minutes}m</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : activitySubTab === "hidden" ? (
                currentActivity.hidden_apps.length === 0 ? (
                  <p className="py-4 text-xs text-ink-3">No hidden or cloaked apps detected on this device.</p>
                ) : (
                  <ul className="divide-y divide-border rounded-xl border border-warning/30 bg-warn-soft/15">
                    {currentActivity.hidden_apps.map((app, i) => (
                      <li key={`${app.name}-${i}`} className="flex items-center justify-between gap-2 px-3.5 py-2.5 text-xs">
                        <span className="min-w-0 truncate text-ink">
                          <span className="font-medium">{app.name}</span>
                          {app.package ? <span className="ml-2 font-mono text-[11px] text-ink-3">{app.package}</span> : null}
                        </span>
                        <span className="shrink-0 font-mono text-warning">{app.minutes}m</span>
                      </li>
                    ))}
                  </ul>
                )
              ) : currentActivity.browser_history.length === 0 ? (
                <p className="py-4 text-xs text-ink-3">No browser history entries in this snapshot.</p>
              ) : (
                <ul className="divide-y divide-border rounded-xl border border-border">
                  {currentActivity.browser_history.map((visit, i) => (
                    <li key={`${visit.url}-${i}`} className="px-3.5 py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="truncate font-medium text-ink">{visit.title || visit.url}</span>
                        <span className="shrink-0 text-[11px] text-ink-3">{relative(visit.visited_at)}</span>
                      </div>
                      <p className="truncate font-mono text-[11px] text-ink-3">{visit.url}</p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
        </Card>
      ) : null}

      {/* =================================================================== */}
      {/* TAB 3: ESP32 HARDWARE NODES                                         */}
      {/* =================================================================== */}
      {tab === "esp32" ? (
        <div className="space-y-4">
          <Card className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="flex items-center gap-2 font-semibold text-ink">
                <Cpu size={17} className="text-accent" /> ESP32 &amp; ESP8266 Hardware Bridge
              </h2>
              <p className="mt-1 max-w-2xl text-xs text-ink-3">
                Pair desk check-in buttons, SOS alarms, presence sensors, and PWM screen-time lamps. Generate a
                ready-to-flash Arduino <code>.ino</code> sketch in one click.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" onClick={() => setEspFirmwareOpen(true)}>
                <Code2 size={15} /> Firmware generator (.ino)
              </Button>
              <Button onClick={() => setEspModalOpen(true)}>
                <Plus size={15} /> Pair ESP32 node
              </Button>
            </div>
          </Card>

          {esp32Nodes.length === 0 ? (
            <EmptyState
              icon={<Cpu size={22} />}
              title="No ESP32 nodes paired yet"
              body="Click “Pair ESP32 node” to create a single-use pairing code & QR popup, then download the pre-filled Arduino .ino firmware."
              action={
                <Button onClick={() => setEspModalOpen(true)}>
                  <Plus size={15} /> Pair ESP32 node
                </Button>
              }
            />
          ) : (
            <div className="grid gap-4 md:grid-cols-2">
              {esp32Nodes.map((node) => (
                <Card key={node.id} className="space-y-3.5">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-ink">{node.label}</h3>
                        <Badge className={node.online ? "!border-success/40 !text-success" : ""}>
                          {node.online ? <Wifi size={11} /> : <WifiOff size={11} />} {node.online ? "online" : "offline"}
                        </Badge>
                      </div>
                      <p className="mt-0.5 text-xs text-ink-3">
                        {node.board_label} · seq #{node.last_seq} · last beat {relative(node.last_seen_at)}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      className="!min-h-8 !px-2 text-danger"
                      onClick={() => setConfirmUnlink({ id: node.id, name: node.label, kind: "esp32" })}
                    >
                      <Trash2 size={14} />
                    </Button>
                  </div>

                  <div className="flex flex-wrap gap-1.5">
                    {node.capabilities.map((cap) => (
                      <Badge key={cap}>{CAPABILITY_LABEL[cap] ?? cap}</Badge>
                    ))}
                  </div>

                  {node.last_event ? (
                    <div className="rounded-xl border border-accent/25 bg-accent-soft/20 px-3 py-2 text-xs">
                      <span className="font-semibold uppercase text-accent">{node.last_event.type}</span>
                      {node.last_event.message ? <span className="ml-1.5 text-ink">{node.last_event.message}</span> : null}
                      <span className="ml-2 text-ink-3">· {relative(node.last_event.at)}</span>
                    </div>
                  ) : null}

                  <div className="space-y-2 border-t border-border pt-3">
                    <div className="flex items-center justify-between gap-3 text-xs">
                      <span className="flex items-center gap-1.5 text-ink-2">
                        <Lightbulb size={14} className="text-accent" /> Lamp brightness ({node.lamp}/255)
                      </span>
                      <input
                        type="range"
                        min={0}
                        max={255}
                        defaultValue={node.lamp}
                        onMouseUp={(e) => void updateEspNode(node.id, { lamp: Number((e.target as HTMLInputElement).value) })}
                        onTouchEnd={(e) => void updateEspNode(node.id, { lamp: Number((e.target as HTMLInputElement).value) })}
                        className="w-36 accent-[var(--accent)]"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="flex items-center gap-1.5 text-ink-2">
                        <Sun size={14} className="text-accent" /> Focus mode
                      </span>
                      <Button
                        variant={node.focus_mode ? "secondary" : "outline"}
                        className="!min-h-8 !px-3 !text-xs"
                        disabled={busy === `esp-${node.id}`}
                        onClick={() => void updateEspNode(node.id, { focus_mode: !node.focus_mode })}
                      >
                        {node.focus_mode ? "Focus ON" : "Focus OFF"}
                      </Button>
                    </div>
                  </div>
                </Card>
              ))}
            </div>
          )}
        </div>
      ) : null}

      {/* --- Modal 1: Own-Account Pairing QR Popup ------------------------- */}
      <Modal
        open={qrOpen && Boolean(challenge)}
        onClose={() => setQrOpen(false)}
        title="Pair Your Own Device (QR)"
        description="Scan from another device signed in to YOUR account. Expires in 5 minutes · single use."
        size="sm"
      >
        {challenge ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={challenge.qr_data_url}
              alt="MATRIX own-account pairing QR code"
              className="mx-auto h-60 w-60 rounded-xl bg-white p-2 shadow"
            />
            <p className="text-xs text-ink-3">
              Expires {new Date(challenge.expires_at).toLocaleTimeString()} · Contains no credentials.
            </p>
            <code className="block break-all rounded-lg bg-surface-2 p-2 text-left font-mono text-[11px] text-ink-2">
              {challenge.qr_payload}
            </code>
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard
                  .writeText(challenge.qr_payload)
                  .then(() => toast("Pairing payload copied."))
                  .catch(() => toast("Copy failed."))
              }
            >
              <Copy size={14} /> Copy pairing code
            </Button>
          </div>
        ) : null}
      </Modal>

      {/* --- Modal 2: Cross-Account Family Device QR Popup ----------------- */}
      <Modal
        open={familyQrOpen && Boolean(familyPair)}
        onClose={() => setFamilyQrOpen(false)}
        title={`Cross-Account QR for ${familyPair?.member_name || "Family Member"}`}
        description="Have the member scan this QR on their own phone or desktop while signed in to THEIR account — not yours."
        size="sm"
      >
        {familyPair ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={familyPair.qr_data_url}
              alt="Cross-account family device QR code"
              className="mx-auto h-60 w-60 rounded-xl bg-white p-2 shadow"
            />
            <p className="text-xs text-ink-3">
              Valid for 1 hour · Single use · Works across different accounts.
            </p>
            <code className="block break-all rounded-lg bg-surface-2 p-2 text-left font-mono text-[11px] text-ink-2">
              {familyPair.qr_payload}
            </code>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(familyPair.qr_payload)
                    .then(() => toast("Family pairing code copied."))
                    .catch(() => toast("Copy failed."))
                }
              >
                <Copy size={14} /> Copy code
              </Button>
              {familyPair.pair_url ? (
                <Button
                  variant="outline"
                  onClick={() =>
                    void navigator.clipboard
                      .writeText(familyPair.pair_url!)
                      .then(() => toast("Pairing link copied."))
                      .catch(() => toast("Copy failed."))
                  }
                >
                  Copy direct link
                </Button>
              ) : null}
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --- Modal 3: Enter Pairing Code on This Device -------------------- */}
      <Modal
        open={pairOpen}
        onClose={() => setPairOpen(false)}
        title="Link This Device"
        description="Paste either a Cross-Account Family code (works with your own separate account!) or an Own-Account QR payload."
      >
        <div className="space-y-3">
          <Field label="Name for this device" htmlFor="pair-name" hint="Shown in Devices and Family.">
            <Input
              id="pair-name"
              value={deviceName}
              onChange={(event) => setDeviceName(event.target.value)}
              placeholder="e.g. Ayesha's Pixel 8 / Living Room PC"
              maxLength={80}
            />
          </Field>
          <Field
            label="Cross-Account Family code or URL"
            htmlFor="pair-family"
            hint="Starts with matrix-family-pair:v1. — works with your own account (no same-account login required)."
          >
            <Input
              id="pair-family"
              value={joinCode}
              onChange={(event) => setJoinCode(event.target.value)}
              placeholder="matrix-family-pair:v1.… or https://…/devices#pair=…"
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label="Or Own-Account QR payload"
            htmlFor="pair-code"
            hint="Starts with matrix-pairing:v1. — for a second device on the same account."
          >
            <Input
              id="pair-code"
              value={pairInput}
              onChange={(event) => setPairInput(event.target.value)}
              placeholder="matrix-pairing:v1.…"
              className="font-mono text-xs"
            />
          </Field>
          <div className="flex flex-wrap justify-end gap-2 pt-1">
            <Button variant="outline" onClick={() => setPairOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="secondary"
              onClick={() => void completeFamilyPairing()}
              disabled={busy === "family-join" || !joinCode.trim()}
            >
              {busy === "family-join" ? <Loader2 size={14} className="animate-spin" /> : <ShieldCheck size={14} />}{" "}
              Link to Family
            </Button>
            <Button onClick={() => void completePairing()} disabled={busy === "pair" || !pairInput.trim()}>
              {busy === "pair" ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />} Pair Own Account
            </Button>
          </div>
        </div>
      </Modal>

      {/* --- Modal 4: Create ESP32 Pairing --------------------------------- */}
      <Modal
        open={espModalOpen}
        onClose={() => setEspModalOpen(false)}
        title="Pair an ESP32 / ESP8266 Node"
        description="Choose your board and hardware features to generate a single-use pairing QR & ready-to-flash Arduino firmware."
        footer={
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => setEspModalOpen(false)}>
              Cancel
            </Button>
            <Button onClick={() => void createEsp32Grant()} disabled={busy === "esp-pair" || espCaps.length === 0}>
              {busy === "esp-pair" ? <Loader2 size={14} className="animate-spin" /> : <QrCode size={14} />} Generate QR
              &amp; Code
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <Field label="Node label" htmlFor="esp-label">
            <Input
              id="esp-label"
              value={espLabel}
              onChange={(e) => setEspLabel(e.target.value)}
              placeholder="Desk Lamp & Check-in Button"
              maxLength={64}
            />
          </Field>
          <Field label="Board" htmlFor="esp-board">
            <Select id="esp-board" value={espBoard} onChange={(e) => setEspBoard(e.target.value as Esp32BoardId)}>
              {ESP32_BOARDS.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label} ({b.chip} · {b.gpio} GPIO)
                </option>
              ))}
            </Select>
          </Field>
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-ink">Hardware capabilities</p>
            <div className="grid gap-2 sm:grid-cols-2">
              {ESP32_CAPABILITIES.map((cap) => (
                <label
                  key={cap}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 rounded-xl border p-2.5 text-xs",
                    espCaps.includes(cap) ? "border-accent/40 bg-accent-soft/60 text-ink" : "border-border text-ink-2",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={espCaps.includes(cap)}
                    onChange={() => toggleEspCap(cap)}
                    className="h-4 w-4 accent-[var(--accent)]"
                  />
                  <span>{CAPABILITY_LABEL[cap]}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      {/* --- Modal 5: ESP32 Provisioning QR Popup -------------------------- */}
      <Modal
        open={espQrOpen && Boolean(espGrant)}
        onClose={() => setEspQrOpen(false)}
        title={`ESP32 Pairing QR — ${espGrant?.label || "Node"}`}
        description="Single-use 15-minute provisioning token. Open the Arduino Firmware Generator below with this code pre-filled!"
        size="sm"
      >
        {espGrant ? (
          <div className="space-y-3 text-center">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={espGrant.qr_data_url}
              alt="ESP32 provisioning QR code"
              className="mx-auto h-56 w-56 rounded-xl bg-white p-2 shadow"
            />
            <code className="block break-all rounded-lg bg-surface-2 p-2 font-mono text-xs text-ink">
              {espGrant.pairing_code}
            </code>
            <div className="flex flex-wrap justify-center gap-2">
              <Button
                variant="secondary"
                onClick={() =>
                  void navigator.clipboard
                    .writeText(espGrant.pairing_code)
                    .then(() => toast("ESP32 pairing code copied."))
                }
              >
                <Copy size={14} /> Copy code
              </Button>
              <Button
                onClick={() => {
                  setEspQrOpen(false);
                  setEspFirmwareOpen(true);
                }}
              >
                <Code2 size={14} /> Open .ino Firmware
              </Button>
            </div>
          </div>
        ) : null}
      </Modal>

      {/* --- Modal 6: Arduino .ino Firmware Generator ---------------------- */}
      <Modal
        open={espFirmwareOpen}
        onClose={() => setEspFirmwareOpen(false)}
        title="ESP32 Arduino Firmware Generator (.ino)"
        description="Pre-filled with your MATRIX server endpoint and single-use pairing code. Wi-Fi credentials stay in your browser and are never sent to MATRIX."
        size="lg"
        footer={
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" onClick={() => setEspFirmwareOpen(false)}>
              Close
            </Button>
            <Button
              variant="secondary"
              onClick={() =>
                void navigator.clipboard.writeText(generatedSketch).then(() => toast("Arduino sketch copied."))
              }
            >
              <Copy size={14} /> Copy sketch
            </Button>
            <Button onClick={downloadSketch}>
              <Download size={14} /> Download .ino
            </Button>
          </div>
        }
      >
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Wi-Fi SSID (local only)" htmlFor="esp-ssid">
              <Input
                id="esp-ssid"
                value={wifiSsid}
                onChange={(e) => setWifiSsid(e.target.value)}
                placeholder="Home_WiFi"
              />
            </Field>
            <Field label="Wi-Fi Password (local only)" htmlFor="esp-pass">
              <Input
                id="esp-pass"
                type="password"
                value={wifiPassword}
                onChange={(e) => setWifiPassword(e.target.value)}
                placeholder="••••••••"
              />
            </Field>
          </div>
          <pre className="max-h-80 overflow-auto rounded-xl border border-border bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-ink">
            {generatedSketch}
          </pre>
        </div>
      </Modal>

      <ConfirmModal
        open={Boolean(confirmUnlink)}
        onClose={() => setConfirmUnlink(null)}
        onConfirm={() => {
          const target = confirmUnlink;
          setConfirmUnlink(null);
          if (target) void handleUnlink(target);
        }}
        title="Unlink this device?"
        body={`“${confirmUnlink?.name ?? "This device"}” loses access immediately. You can pair it again anytime with a fresh QR.`}
        confirmLabel="Unlink"
      />
    </div>
  );
}
