// =============================================================================
// Cross-account device links — shared rules (browser-safe, no server imports).
//
// Kept separate from the server module so the pairing UI and the unit tests
// can use the exact same constants and validation the backend enforces.
// =============================================================================

/** Invitations live for 10 minutes: long enough to walk to the other device. */
export const DEVICE_LINK_TTL_MS = 10 * 60 * 1000;

/**
 * Human-typable code alphabet. No 0/O, 1/I/L — these are read aloud and typed
 * on a second device, so ambiguous glyphs are excluded.
 */
export const DEVICE_LINK_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const DEVICE_LINK_CODE_LENGTH = 8;

/** Creation limits per account. Pairing is rare; abuse is not welcome. */
export const DEVICE_LINK_RATE = { maxPerWindow: 5, windowMs: 60 * 60 * 1000 } as const;

/** Grouped for display and reading aloud: "ABCD-EFGH". */
export function formatLinkCode(code: string): string {
  const clean = normalizeLinkCode(code);
  return clean.length === DEVICE_LINK_CODE_LENGTH ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
}

/** Uppercase, strip separators, map look-alike letters to their digits. */
export function normalizeLinkCode(code: string | null | undefined): string {
  return String(code ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1")
    // The alphabet has no 0/1, so map the canonical confusables onto it.
    .replace(/0/g, "Q")
    .replace(/1/g, "T");
}

/** True when the text could be a valid code (length + alphabet). */
export function isValidLinkCode(code: string | null | undefined): boolean {
  const clean = String(code ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (clean.length !== DEVICE_LINK_CODE_LENGTH) return false;
  return [...clean].every((character) => DEVICE_LINK_CODE_ALPHABET.includes(character));
}

/**
 * Parse whatever the second device received — a typed code, a QR payload or a
 * deep link `qorvyna://link?code=…` / app URL `/devices?link=…` — into the
 * token the API expects. Returns null when nothing usable is present.
 */
export function parseLinkInput(input: string | null | undefined): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  // Deep links and URLs: take the code from the query string.
  const match = /[?&](?:code|link)=([^&#\s]+)/i.exec(raw);
  if (match) {
    try {
      const decoded = decodeURIComponent(match[1]);
      return decoded.includes(".") ? decoded : formatLinkCode(decoded);
    } catch {
      return null;
    }
  }
  // A long token: CODE.SECRET
  if (/^[A-Za-z0-9-]+\.[A-Za-z0-9_-]{20,}$/.test(raw)) return raw;
  // A typed code.
  if (isValidLinkCode(raw)) return formatLinkCode(raw);
  return null;
}

export type LinkInvitationRow = {
  id: string;
  /** Shown to the user ONCE. Never stored server-side in clear text. */
  code: string;
  claim_token: string;
  expires_at: string;
  label: string;
  status: "pending";
};

export type ClaimedLink = { link_id: string; status: "active"; peer_account: string };

export type DeviceLinkRow = {
  id: string;
  peer_account: string;
  peer_device_id: string | null;
  my_device_id: string | null;
  status: "active" | "revoked" | "awaiting_owner" | "denied" | string;
  created_at: string;
  last_activity_at: string;
  revoked_at: string | null;
};

/** Plain-language status, used by the Devices screen. */
export function linkStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Connected";
    case "revoked":
      return "Revoked";
    case "awaiting_owner":
      return "Waiting for the other account";
    case "denied":
      return "Declined";
    default:
      return status;
  }
}
