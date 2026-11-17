// =============================================================================
// Phase 6 — cross-account device pairing.
//
// The security properties, tested against the real backend module with the
// Firestore stub:
//   • invitations are 256-bit random, stored only as hashes;
//   • they expire and are single-use;
//   • a device cannot claim its own account's invitation;
//   • either side can revoke, and only its own link;
//   • creation is rate limited.
// =============================================================================
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type FirestoreStub } from "./helpers/firestore-stub";

vi.mock("@/lib/firebase/admin", async () => {
  const { sharedFirestoreStub, makeAdminModule } = await import("./helpers/firestore-stub");
  return makeAdminModule(sharedFirestoreStub());
});

import {
  claimLinkInvitation,
  createLinkInvitation,
  linkHistory,
  listDeviceLinks,
  revokeDeviceLink,
  storedInvitationHash,
} from "../src/lib/server/device-links";
import {
  DEVICE_LINK_CODE_ALPHABET,
  DEVICE_LINK_CODE_LENGTH,
  DEVICE_LINK_RATE,
  DEVICE_LINK_TTL_MS,
  formatLinkCode,
  isValidLinkCode,
  linkStatusLabel,
  normalizeLinkCode,
  parseLinkInput,
} from "../src/lib/device-links";
import { sharedFirestoreStub } from "./helpers/firestore-stub";

const ALICE = { uid: "alice-account", email: "alice@example.com", emailVerified: true };
const BOB = { uid: "bob-account", email: "bob@example.com", emailVerified: true };

let stub: FirestoreStub;
beforeEach(async () => {
  stub = sharedFirestoreStub();
  for (const key of [...stub._state.docs.keys()]) {
    if (key.startsWith("device_link")) stub._state.docs.delete(key);
  }
});

describe("Phase 6 — invitation creation", () => {
  it("returns a typable code and keeps only hashes", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, { label: "Pixel" });
    expect(invite.code).toHaveLength(0 + 8);
    expect(isValidLinkCode(invite.code)).toBe(true);
    expect(invite.claim_token.startsWith(invite.code)).toBe(true);
    const stored = [...stub._state.docs.entries()].find(([key]) => key.startsWith("device_link_invitations/"))!;
    const data = stored[1] as Record<string, unknown>;
    // The clear-text code and secret are NOT in the record.
    expect(JSON.stringify(data)).not.toContain(invite.code);
    expect(JSON.stringify(data)).not.toContain(invite.claim_token.split(".")[1]);
    expect(data.code_hash).toBe(storedInvitationHash(normalizeLinkCode(invite.code)));
    expect(typeof data.secret_hash).toBe("string");
  });

  it("gives every invitation a distinct, high-entropy secret", async () => {
    const secrets = new Set<string>();
    for (let i = 0; i < 5; i += 1) {
      const invite = await createLinkInvitation(stub as never, ALICE, {});
      secrets.add(invite.claim_token.split(".")[1]);
    }
    expect(secrets.size).toBe(5);
    for (const secret of secrets) expect(secret.length).toBeGreaterThanOrEqual(40);
  });

  it("expires invitations after the documented window", async () => {
    const created = await createLinkInvitation(stub as never, ALICE, {});
    const ttl = new Date(created.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(DEVICE_LINK_TTL_MS - 5_000);
    expect(ttl).toBeLessThanOrEqual(DEVICE_LINK_TTL_MS + 1_000);
  });

  it("rate limits an account that keeps creating invitations", async () => {
    for (let i = 0; i < DEVICE_LINK_RATE.maxPerWindow; i += 1) {
      await createLinkInvitation(stub as never, ALICE, {});
    }
    await expect(createLinkInvitation(stub as never, ALICE, {})).rejects.toMatchObject({ code: "LINK_RATE_LIMITED" });
    // Another account is unaffected.
    await expect(createLinkInvitation(stub as never, BOB, {})).resolves.toBeTruthy();
  });
});

describe("Phase 6 — claiming across accounts", () => {
  it("links two DIFFERENT accounts", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const claim = await claimLinkInvitation(stub as never, BOB, { token: invite.claim_token });
    expect(claim.status).toBe("active");
    const aliceLinks = await listDeviceLinks(stub as never, ALICE);
    const bobLinks = await listDeviceLinks(stub as never, BOB);
    expect(aliceLinks).toHaveLength(1);
    expect(bobLinks).toHaveLength(1);
    expect(aliceLinks[0].peer_account).toBe(BOB.uid);
    expect(bobLinks[0].peer_account).toBe(ALICE.uid);
    expect(aliceLinks[0].id).toBe(bobLinks[0].id);
  });

  it("refuses to link the account that created the invitation", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    await expect(claimLinkInvitation(stub as never, ALICE, { token: invite.claim_token })).rejects.toMatchObject({
      code: "LINK_SAME_ACCOUNT",
    });
  });

  it("is single-use: a second claim fails", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    await claimLinkInvitation(stub as never, BOB, { token: invite.claim_token });
    await expect(claimLinkInvitation(stub as never, BOB, { token: invite.claim_token })).rejects.toMatchObject({
      code: "LINK_ALREADY_USED",
    });
  });

  it("rejects an expired invitation", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {}, Date.now() - DEVICE_LINK_TTL_MS - 60_000);
    await expect(claimLinkInvitation(stub as never, BOB, { token: invite.claim_token })).rejects.toMatchObject({
      code: "LINK_EXPIRED",
    });
  });

  it("rejects a forged secret for a real code", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const forged = `${invite.code}.${"A".repeat(43)}`;
    await expect(claimLinkInvitation(stub as never, BOB, { token: forged })).rejects.toMatchObject({ code: "LINK_INVALID" });
  });

  it("accepts a code typed by hand (case and separators ignored)", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const messy = `${formatLinkCode(invite.code).toLowerCase().replace("-", " ")}`;
    const claim = await claimLinkInvitation(stub as never, BOB, { token: messy });
    expect(claim.status).toBe("active");
  });
});

describe("Phase 6 — revocation and history", () => {
  it("lets either side revoke, and stops both sides using it", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const claim = await claimLinkInvitation(stub as never, BOB, { token: invite.claim_token });
    const linkId = (claim as { link_id: string }).link_id;
    await revokeDeviceLink(stub as never, BOB, linkId);
    const aliceLinks = await listDeviceLinks(stub as never, ALICE);
    const bobLinks = await listDeviceLinks(stub as never, BOB);
    expect(aliceLinks[0].status).toBe("revoked");
    expect(bobLinks[0].status).toBe("revoked");
    expect(aliceLinks[0].revoked_at).toBeTruthy();
  });

  it("refuses revocation by an unrelated account", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const claim = await claimLinkInvitation(stub as never, BOB, { token: invite.claim_token });
    const linkId = (claim as { link_id: string }).link_id;
    const mallory = { uid: "mallory", email: "m@example.com", emailVerified: true };
    await expect(revokeDeviceLink(stub as never, mallory, linkId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("records a history both accounts can read", async () => {
    const invite = await createLinkInvitation(stub as never, ALICE, {});
    const claim = await claimLinkInvitation(stub as never, BOB, { token: invite.claim_token });
    const linkId = (claim as { link_id: string }).link_id;
    const history = await linkHistory(stub as never, ALICE, linkId);
    expect(history.map((entry) => entry.type)).toContain("link_created");
    expect(history.map((entry) => entry.type)).toContain("link_accepted");
    const mallory = { uid: "mallory", email: "m@example.com", emailVerified: true };
    await expect(linkHistory(stub as never, mallory, linkId)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("Phase 6 — shared rules", () => {
  it("has no ambiguous characters in the alphabet", () => {
    for (const character of ["0", "O", "1", "I", "L"]) {
      expect(DEVICE_LINK_CODE_ALPHABET.includes(character)).toBe(false);
    }
    expect(DEVICE_LINK_CODE_LENGTH).toBe(8);
  });

  it("formats and normalises codes for humans and APIs", () => {
    expect(formatLinkCode("abcdefgh")).toBe("ABCD-EFGH");
    expect(normalizeLinkCode("ab-cd ef gh")).toBe("ABCDEFGH");
    expect(isValidLinkCode("ABCD-EFGH")).toBe(true);
    expect(isValidLinkCode("ABCD")).toBe(false);
  });

  it("parses typed codes, QR tokens and deep links", () => {
    expect(parseLinkInput("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(parseLinkInput("qorvyna://link?code=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(parseLinkInput("https://qorvyna.thamjj13.top/devices?link=ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(parseLinkInput("")).toBeNull();
    expect(parseLinkInput("not a code")).toBeNull();
  });

  it("labels every status in plain language", () => {
    expect(linkStatusLabel("active")).toBe("Connected");
    expect(linkStatusLabel("revoked")).toBe("Revoked");
  });
});
