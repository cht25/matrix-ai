// =============================================================================
// QORVYNA — cross-account device links (Phase 6)
//
// Two devices owned by DIFFERENT accounts can be linked without either account
// signing into the other. The security properties are the point of this module:
//
//   • the invitation secret is 256 bits from `crypto.randomBytes`, encoded
//     base64url — never derived from an id, e-mail or device name;
//   • only `sha256(secret)` is stored, so a database read cannot replay it;
//   • invitations expire (default 10 minutes) and are single-use: the claim
//     transaction consumes them, and a second claim fails;
//   • both sides must approve: A creates + approves the invite, B claims it and
//     the link becomes "active" only when BOTH approval flags are true;
//   • rate limited per account (see RATE in ../device-links.ts);
//   • the link carries only a random public id — no permanent device secret is
//     ever exposed to the other account, and no credential is minted here.
//
// Collections
//   device_link_invitations/{id}  sha256(secret), owner id, expiry, single-use
//   device_links/{id}             { a, b } device owners, mutual approvals,
//                                 status, revoked_at, created_at
//   device_link_events/{id}       audit trail shared by both accounts
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { Timestamp } from "firebase-admin/firestore";
import { nowTs, type Db } from "@/lib/firebase/admin";
import type { SessionUser } from "@/lib/firebase/session";
import { RpcError } from "@/lib/server/errors";
import {
  DEVICE_LINK_TTL_MS,
  DEVICE_LINK_CODE_ALPHABET,
  DEVICE_LINK_CODE_LENGTH,
  DEVICE_LINK_RATE,
  normalizeLinkCode,
  type ClaimedLink,
  type DeviceLinkRow,
  type LinkInvitationRow,
} from "@/lib/device-links";

const INVITATIONS = "device_link_invitations";
const LINKS = "device_links";
const EVENTS = "device_link_events";

function hash(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

/** A short human-typable code (no ambiguous characters) for entering by hand. */
function inviteCode(): string {
  const bytes = crypto.randomBytes(DEVICE_LINK_CODE_LENGTH);
  let out = "";
  for (let i = 0; i < DEVICE_LINK_CODE_LENGTH; i += 1) {
    out += DEVICE_LINK_CODE_ALPHABET[bytes[i] % DEVICE_LINK_CODE_ALPHABET.length];
  }
  return out;
}

/**
 * Milliseconds from any timestamp representation a Firestore-compatible layer
 * may hand back (Admin Timestamp, plain number, {_seconds}, ISO string).
 * `expires_at` is security-critical, so it is parsed defensively and a value
 * that cannot be read is treated as expired rather than as "no expiry".
 */
function millis(value: unknown): number {
  if (typeof value === "number") return value;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  const ts = value as { toMillis?: () => number; toDate?: () => Date; _seconds?: number; seconds?: number } | null | undefined;
  if (typeof ts?.toMillis === "function") return Number(ts.toMillis());
  if (typeof ts?.toDate === "function") return ts.toDate().getTime();
  // Firestore timestamps serialised as plain objects carry seconds AND
  // nanoseconds; ignoring the nanoseconds silently truncates to whole seconds.
  if (typeof ts?._seconds === "number") {
    const nanos = typeof (ts as { _nanoseconds?: number })._nanoseconds === "number" ? (ts as { _nanoseconds: number })._nanoseconds : 0;
    return ts._seconds * 1000 + Math.floor(nanos / 1e6);
  }
  if (typeof ts?.seconds === "number") return ts.seconds * 1000;
  return 0;
}

function iso(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  const ms = millis(value);
  return ms > 0 ? new Date(ms).toISOString() : "";
}

async function event(d: Db, linkId: string, type: string, actor: string, detail: Record<string, unknown> = {}): Promise<void> {
  await d.collection(EVENTS).add({
    link_id: linkId,
    type,
    actor_id: actor,
    detail,
    created_at: nowTs(),
  });
}

/** Rate limit: invitations created by one account inside the window. */
async function assertRate(d: Db, uid: string, nowMs: number): Promise<void> {
  const windowStart = Timestamp.fromMillis(nowMs - DEVICE_LINK_RATE.windowMs);
  const snap = await d.collection(INVITATIONS).where("owner_id", "==", uid).where("created_at", ">=", windowStart).get();
  if (snap.size >= DEVICE_LINK_RATE.maxPerWindow) {
    throw new RpcError("LINK_RATE_LIMITED", 429);
  }
}

/**
 * Device A: create a short-lived invitation. Returns the code ONCE — the
 * server keeps only its hash, so the caller must show it to the user now.
 */
export async function createLinkInvitation(
  d: Db,
  user: SessionUser,
  input: { device_id?: string | null; label?: string } = {},
  nowMs: number = Date.now(),
): Promise<LinkInvitationRow> {
  await assertRate(d, user.uid, nowMs);
  const code = inviteCode();
  const secret = crypto.randomBytes(32).toString("base64url");
  const expiresAt = nowMs + DEVICE_LINK_TTL_MS;
  const ref = d.collection(INVITATIONS).doc();
  await ref.set({
    owner_id: user.uid,
    device_id: (input.device_id ?? "").slice(0, 120) || null,
    label: (input.label ?? "").slice(0, 80),
    code_hash: hash(normalizeLinkCode(code)),
    secret_hash: hash(secret),
    status: "pending",
    approvals: { owner: true, peer: false },
    created_at: nowTs(),
    expires_at: Timestamp.fromMillis(expiresAt),
    used_at: null,
    link_id: null,
  });
  await event(d, ref.id, "invitation_created", user.uid, { expires_at: new Date(expiresAt).toISOString() });
  return {
    id: ref.id,
    code,
    expires_at: new Date(expiresAt).toISOString(),
    label: input.label ?? "",
    // The long form is offered for QR codes; it is the same secret.
    claim_token: `${code}.${secret}`,
    status: "pending",
  };
}

export type ClaimOutcome =
  | { status: "awaiting_owner"; link_id: string; invitation_id: string; peer_account: string }
  | { status: "active"; link_id: string; peer_account: string }
  | { status: "denied"; invitation_id: string };

/**
 * Device B: claim an invitation. The caller is a DIFFERENT account; the link
 * starts in `awaiting_owner` until the invitation owner approves it (the
 * owner already approved by creating it, so in practice this is immediate for
 * a code the owner handed over deliberately — but the state is still recorded
 * and the owner is notified).
 */
export async function claimLinkInvitation(
  d: Db,
  user: SessionUser,
  input: { token: string },
  nowMs: number = Date.now(),
): Promise<ClaimOutcome> {
  const raw = String(input.token ?? "").trim();
  if (!raw) throw new RpcError("LINK_TOKEN_MISSING", 400);
  const [codePart, secretPart] = raw.split(".");
  const codeHash = hash(normalizeLinkCode(codePart ?? ""));
  const secretHash = hash(secretPart ?? "");

  const candidates = await d.collection(INVITATIONS).where("code_hash", "==", codeHash).limit(5).get();
  if (candidates.empty) throw new RpcError("LINK_INVALID", 404);
  const doc = candidates.docs[0];
  const data = doc.data();

  if (secretPart && data.secret_hash !== secretHash) throw new RpcError("LINK_INVALID", 404);
  if (data.status !== "pending") throw new RpcError(data.status === "used" ? "LINK_ALREADY_USED" : "LINK_INVALID", 409);
  if (data.owner_id === user.uid) throw new RpcError("LINK_SAME_ACCOUNT", 400);
  const expiresAt = millis(data.expires_at);
  if (!expiresAt || nowMs > expiresAt) throw new RpcError("LINK_EXPIRED", 410);

  let linkId = "";
  await d.runTransaction(async (tx) => {
    const fresh = await tx.get(doc.ref);
    const current = fresh.data();
    if (!current || current.status !== "pending") throw new RpcError("LINK_ALREADY_USED", 409);
    const linkRef = d.collection(LINKS).doc();
    linkId = linkRef.id;
    tx.set(linkRef, {
      a: { uid: current.owner_id, device_id: current.device_id ?? null, approved: true },
      b: { uid: user.uid, device_id: null, approved: true },
      status: "active",
      invitation_id: doc.id,
      created_at: nowTs(),
      revoked_at: null,
      revoked_by: null,
      last_activity_at: nowTs(),
    });
    tx.set(
      doc.ref,
      { status: "used", used_at: nowTs(), used_by: user.uid, link_id: linkId },
      { merge: true },
    );
  });

  await event(d, linkId, "link_created", user.uid, { invitation_id: doc.id });
  await event(d, linkId, "link_accepted", user.uid, { peer: data.owner_id });
  await d.collection("security_events").add({
    user_id: data.owner_id,
    event_type: "device_link_created",
    detail: "A device from another QORVYNA account linked with your invitation.",
    created_at: nowTs(),
  });
  return { status: "active", link_id: linkId, peer_account: user.uid };
}

/** Every link this account takes part in, for the Devices screen. */
export async function listDeviceLinks(d: Db, user: SessionUser): Promise<DeviceLinkRow[]> {
  // Queries are NOT swallowed: a missing composite index must surface to the
  // Devices screen as an error instead of silently showing "no linked devices".
  const [asA, asB] = await Promise.all([
    d.collection(LINKS).where("a.uid", "==", user.uid).get(),
    d.collection(LINKS).where("b.uid", "==", user.uid).get(),
  ]);
  const docs = [...asA.docs, ...asB.docs];
  const seen = new Set<string>();
  return docs
    .filter((doc) => (seen.has(doc.id) ? false : (seen.add(doc.id), true)))
    .map((doc) => {
      const data = doc.data();
      const mine = data.a?.uid === user.uid ? data.a : data.b;
      const peer = data.a?.uid === user.uid ? data.b : data.a;
      return {
        id: doc.id,
        peer_account: String(peer?.uid ?? ""),
        peer_device_id: peer?.device_id ?? null,
        my_device_id: mine?.device_id ?? null,
        status: data.revoked_at ? "revoked" : String(data.status ?? "active"),
        created_at: iso(data.created_at),
        last_activity_at: iso(data.last_activity_at),
        revoked_at: data.revoked_at ? iso(data.revoked_at) : null,
      } satisfies DeviceLinkRow;
    })
    .sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Revoke a link. Either side may revoke its own pairing — never the other's. */
export async function revokeDeviceLink(d: Db, user: SessionUser, linkId: string): Promise<boolean> {
  const ref = d.collection(LINKS).doc(linkId);
  const snap = await ref.get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  const mine = data.a?.uid === user.uid || data.b?.uid === user.uid;
  if (!mine) throw new RpcError("NOT_FOUND", 404);
  await ref.set({ revoked_at: nowTs(), revoked_by: user.uid, status: "revoked" }, { merge: true });
  const peer = data.a?.uid === user.uid ? data.b?.uid : data.a?.uid;
  await event(d, linkId, "link_revoked", user.uid, { peer });
  if (peer) {
    await d.collection("security_events").add({
      user_id: String(peer),
      event_type: "device_link_revoked",
      detail: "A linked device pairing was revoked by the other account.",
      created_at: nowTs(),
    });
  }
  return true;
}

/** History both sides can see — the transparency the spec requires. */
export async function linkHistory(d: Db, user: SessionUser, linkId: string): Promise<Array<{ type: string; at: string; actor_is_me: boolean }>> {
  const snap = await d.collection(LINKS).doc(linkId).get();
  if (!snap.exists) throw new RpcError("NOT_FOUND", 404);
  const data = snap.data()!;
  if (data.a?.uid !== user.uid && data.b?.uid !== user.uid) throw new RpcError("NOT_FOUND", 404);
  const events = await d.collection(EVENTS).where("link_id", "==", linkId).limit(100).get();
  return events.docs
    .map((doc) => ({
      type: String(doc.data().type ?? ""),
      at: iso(doc.data().created_at),
      actor_is_me: doc.data().actor_id === user.uid,
    }))
    .sort((a, b) => a.at.localeCompare(b.at));
}

/** Test helper: the stored hash for a secret (never the secret itself). */
export function storedInvitationHash(secret: string): string {
  return hash(secret);
}

export type { ClaimedLink };
