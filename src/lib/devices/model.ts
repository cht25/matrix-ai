// Shared (browser + server) device model: roles, permissions and status.

export type DeviceRole = "parent" | "child";

/**
 * Permissions a Child device can hold. Each one is a scope the server
 * enforces on every request made with that device's credential
 * (src/lib/firebase/device-session.ts) — nothing here is display-only.
 */
export const DEVICE_PERMISSIONS = ["chat:read", "chat:write", "devices:read", "devices:write", "notifications:read"] as const;
export type DevicePermission = (typeof DEVICE_PERMISSIONS)[number];

export const DEFAULT_CHILD_PERMISSIONS: readonly DevicePermission[] = ["chat:read", "chat:write", "devices:read", "notifications:read"];

export const PERMISSION_INFO: Record<DevicePermission, { label: string; detail: string }> = {
  "chat:read": { label: "Read conversations", detail: "Open the account's chats and history." },
  "chat:write": { label: "Send messages", detail: "Start chats and send messages as this account." },
  "devices:read": { label: "See devices", detail: "View the device list and its own connection status." },
  "devices:write": { label: "Report device activity", detail: "Send its own activity and unlink devices." },
  "notifications:read": { label: "Receive notifications", detail: "Read the account's notifications." },
};

export function sanitizePermissions(value: unknown): DevicePermission[] {
  if (!Array.isArray(value)) return [];
  const allowed = new Set<string>(DEVICE_PERMISSIONS);
  return [...new Set(value.map(String).filter((item) => allowed.has(item)))] as DevicePermission[];
}

export type ConnectionStatus = "online" | "offline" | "disconnected" | "pending" | "revoked";

/** A device counts as online when it was seen within this window. */
export const ONLINE_WINDOW_MS = 2 * 60 * 1000;

export function connectionStatus(input: { revoked: boolean; suspended: boolean; credentialed: boolean; lastSeenMs: number; nowMs: number }): ConnectionStatus {
  if (input.revoked) return "revoked";
  if (input.suspended) return "disconnected";
  if (!input.credentialed) return "pending";
  return input.lastSeenMs > 0 && input.nowMs - input.lastSeenMs <= ONLINE_WINDOW_MS ? "online" : "offline";
}

export const STATUS_LABEL: Record<ConnectionStatus, string> = {
  online: "Online",
  offline: "Offline",
  disconnected: "Disconnected",
  pending: "Waiting to connect",
  revoked: "Revoked",
};

export type HubDevice = {
  id: string;
  device_name: string;
  device_type: string;
  platform: string;
  os: string;
  app_version: string;
  role: DeviceRole;
  parent_device_id: string | null;
  permissions: DevicePermission[];
  status: ConnectionStatus;
  registered_at: string;
  last_active_at: string;
  is_current: boolean;
};

export type PairingRequestView = {
  challenge_id: string;
  device_name: string;
  device_type: string;
  platform: string;
  os: string;
  app_version: string;
  requested_at: string;
  decide_by: string;
};

/** Manual pairing codes are shown as XXXX-XXXX; accept any spacing/case. */
export function normalizeManualCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
}
export function formatManualCode(code: string): string {
  const clean = normalizeManualCode(code);
  return clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/** What a device can actually do, derived from its platform — never assumed. */
export function deviceCapabilities(device: Pick<HubDevice, "platform" | "role" | "device_type">): string[] {
  const platform = device.platform.toLowerCase();
  const caps: string[] = ["Chat"];
  if (device.role === "parent") caps.push("Manage devices", "Approve pairing");
  if (platform === "android") caps.push("QR scanner", "App updates");
  if (platform === "web" || platform === "windows" || platform === "macos" || platform === "linux") caps.push("Agent workspace");
  return caps;
}

/** Best-effort description of this browser for registration. */
export function describeUserAgent(ua: string): { device_type: string; platform: string; os: string; name: string } {
  const android = /Android\s+([\d.]+)/i.exec(ua);
  const ios = /(iPhone|iPad|iPod).*?OS\s+([\d_]+)/i.exec(ua);
  const windows = /Windows NT\s+([\d.]+)/i.exec(ua);
  const mac = /Mac OS X\s+([\d_]+)/i.exec(ua);
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\//.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "Browser";
  if (android) return { device_type: /Mobile/i.test(ua) ? "phone" : "tablet", platform: "web", os: `Android ${android[1]}`, name: `${browser} on Android` };
  if (ios) return { device_type: ios[1] === "iPad" ? "tablet" : "phone", platform: "web", os: `iOS ${ios[2].replace(/_/g, ".")}`, name: `${browser} on ${ios[1]}` };
  if (windows) return { device_type: "desktop", platform: "web", os: "Windows", name: `${browser} on Windows` };
  if (mac) return { device_type: "desktop", platform: "web", os: `macOS ${mac[1].replace(/_/g, ".")}`, name: `${browser} on Mac` };
  if (/CrOS/.test(ua)) return { device_type: "desktop", platform: "web", os: "ChromeOS", name: `${browser} on Chromebook` };
  if (/Linux/.test(ua)) return { device_type: "desktop", platform: "web", os: "Linux", name: `${browser} on Linux` };
  return { device_type: "desktop", platform: "web", os: "", name: browser };
}
