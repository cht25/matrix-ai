// =============================================================================
// Family email delivery (server-only).
//
// Transport: Resend (https://resend.com) over HTTPS via centralized dual-sender
// engine (src/lib/server/email.ts).
//
// Delivery is honest: "accepted_by_provider" means Resend accepted the message,
// NOT that it reached the inbox. The UI always keeps the invitation link and
// QR available so a missed email is never a dead end — and a parent can resend.
// =============================================================================
import "server-only";
import type { Db } from "@/lib/firebase/admin";
import { siteOrigin } from "@/lib/seo";
import {
  escapeEmailHtml,
  resendApiKey,
  resolveSenderCandidates,
  sendTransactionalEmail,
} from "@/lib/server/email";

export { escapeEmailHtml };

export type InvitationDelivery = {
  status: "accepted_by_provider" | "not_configured" | "failed";
  provider_id?: string;
  /** Public, human-readable reason — never a provider body or credential. */
  reason?: string;
};

type MessageKind = "invitation" | "resend" | "mirror" | "device" | "access";

/** The fragment stays out of HTTP access logs and Referer headers. */
export function familyInvitationUrl(token: string): string {
  return `${siteOrigin()}/family#invite=${encodeURIComponent(token)}`;
}

export function familyPairingUrl(token: string): string {
  return `${siteOrigin()}/devices#pair=${encodeURIComponent(token)}`;
}

export function isFamilyEmailConfigured(): boolean {
  return Boolean(resendApiKey()) && resolveSenderCandidates().length > 0;
}

/**
 * Server-only, dual-sender fallback for domain errors, bounded retries, stable idempotency key.
 * Acceptance is not delivery.
 */
export async function sendFamilyInvitation(input: {
  id: string;
  email: string;
  token: string;
  expiresAt: string;
  familyName?: string;
  inviterName?: string;
  /** A resend keeps the same invitation id but must reach the inbox again. */
  resent?: boolean;
  db?: Db;
}): Promise<InvitationDelivery> {
  if (!isFamilyEmailConfigured()) return { status: "not_configured" };
  const url = familyInvitationUrl(input.token);
  const familyName = escapeEmailHtml(input.familyName?.trim() || "a QORVYNA family");
  const inviter = escapeEmailHtml(input.inviterName?.trim() || "A parent");
  const expires = escapeEmailHtml(new Date(input.expiresAt).toUTCString());
  const subject = input.resent ? "Reminder · your QORVYNA family invitation" : "Your QORVYNA family invitation";
  const text = `${input.inviterName ?? "A parent"} invited you to join ${input.familyName ?? "a QORVYNA family"}.\n\nReview and explicitly accept: ${url}\n\nSign in with ${input.email}. This link stays valid until ${expires} and can be used once. Joining does not enable device monitoring; every supervision feature is separate and revocable.\n\nIf this was unexpected, ignore this email.`;
  const html = `<div style="background:#070b1e;color:#f5f8ff;padding:32px;font-family:Inter,Arial,sans-serif;border-radius:16px;max-width:560px">
  <p style="letter-spacing:.18em;font-size:11px;color:#22ccff;margin:0 0 8px">QORVYNA · FAMILY</p>
  <h1 style="margin:0 0 12px;font-size:24px">${input.resent ? "Reminder: " : ""}You're invited to ${familyName}</h1>
  <p style="color:#cbd5e1;line-height:1.6;margin:0 0 20px">${inviter} invited you to a QORVYNA family. Joining is your choice: device supervision features are separate, always visible on the device, and revocable at any time.</p>
  <p style="margin:0 0 24px"><a href="${escapeEmailHtml(url)}" style="display:inline-block;background:#2563ff;color:#ffffff;font-weight:600;padding:12px 22px;border-radius:10px;text-decoration:none">Review invitation</a></p>
  <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 8px">Sign in with <strong>${escapeEmailHtml(input.email)}</strong>. Single use · valid until ${expires}.</p>
  <p style="color:#64748b;font-size:12px;margin:0">If you were not expecting this, ignore the email — nothing happens until you accept.</p>
</div>`;

  const result = await sendTransactionalEmail({
    db: input.db,
    templateType: "family_invitation",
    idempotencyKey: input.resent ? `family-invitation/${input.id}/resend/${input.token.slice(0, 12)}` : `family-invitation/${input.id}`,
    to: input.email,
    subject,
    text,
    html,
  });

  if (result.status === "accepted_by_provider" || result.status === "deduplicated") {
    return { status: "accepted_by_provider", ...(result.provider_id ? { provider_id: result.provider_id } : {}) };
  }
  if (result.status === "not_configured") return { status: "not_configured" };
  return mapFailure(result.error_category);
}

/** Message kinds that are informative only (no bearer token inside). */
export async function sendFamilyNotice(input: {
  id: string;
  email: string;
  kind: MessageKind;
  title: string;
  body: string;
  link?: string;
  db?: Db;
}): Promise<InvitationDelivery> {
  if (!isFamilyEmailConfigured()) return { status: "not_configured" };
  const body = escapeEmailHtml(input.body);
  const link = input.link ? escapeEmailHtml(input.link) : "";

  const result = await sendTransactionalEmail({
    db: input.db,
    templateType: "family_notice",
    idempotencyKey: `family-notice/${input.kind}/${input.id}`,
    to: input.email,
    subject: `QORVYNA family · ${input.title}`,
    text: `${input.title}\n\n${input.body}${input.link ? `\n\n${input.link}` : ""}`,
    html: `<div style="background:#070b1e;color:#f5f8ff;padding:32px;font-family:Inter,Arial,sans-serif;border-radius:16px;max-width:560px">
  <p style="letter-spacing:.18em;font-size:11px;color:#22ccff;margin:0 0 8px">QORVYNA · FAMILY</p>
  <h1 style="margin:0 0 12px;font-size:22px">${escapeEmailHtml(input.title)}</h1>
  <p style="color:#cbd5e1;line-height:1.6;margin:0 0 18px">${body}</p>
  ${link ? `<p style="margin:0"><a href="${link}" style="color:#6ea0ff">Open QORVYNA</a></p>` : ""}
  <p style="color:#64748b;font-size:12px;margin:20px 0 0">You receive this because you are a member of a QORVYNA family. Manage notifications in Family settings.</p>
</div>`,
  });

  if (result.status === "accepted_by_provider" || result.status === "deduplicated") {
    return { status: "accepted_by_provider", ...(result.provider_id ? { provider_id: result.provider_id } : {}) };
  }
  if (result.status === "not_configured") return { status: "not_configured" };
  return mapFailure(result.error_category);
}

function mapFailure(category?: string): InvitationDelivery {
  if (category === "invalid_api_key") return { status: "failed", reason: "provider_key_rejected" };
  if (category === "rate_limited") return { status: "failed", reason: "provider_rate_limited" };
  if (category === "all_senders_unverified" || category === "domain_unverified") {
    return { status: "failed", reason: "sender_domain_unverified" };
  }
  return { status: "failed" };
}
