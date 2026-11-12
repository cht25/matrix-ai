// =============================================================================
// Family email delivery (server-only).
//
// Transport: Resend (https://resend.com) over HTTPS. This project never used
// SMTP and does not depend on nodemailer: Resend's REST API is one server-only
// API key, gives per-message ids, supports idempotency keys so a retry cannot
// double-send, and needs no long-lived SMTP socket in a serverless runtime.
//
// Delivery is honest: "accepted_by_provider" means Resend accepted the message,
// NOT that it reached the inbox. The UI always keeps the invitation link and
// QR available so a missed email is never a dead end — and a parent can resend.
// =============================================================================
import "server-only";
import { siteOrigin } from "@/lib/seo";

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

export function escapeEmailHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

const PLACEHOLDERS = ["YOUR-", "replace-with", "..."];

function configured(): { key: string; from: string } | null {
  const key = process.env.RESEND_API_KEY?.trim() ?? "";
  const from = process.env.RESEND_FROM_EMAIL?.trim() ?? "";
  if (!key || !from) return null;
  if (PLACEHOLDERS.some((placeholder) => key.includes(placeholder) || from.includes(placeholder))) return null;
  return { key, from };
}

export function isFamilyEmailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY?.trim() && process.env.RESEND_FROM_EMAIL?.trim());
}

/**
 * Server-only, bounded retries, stable idempotency key.
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
}): Promise<InvitationDelivery> {
  const delivery = configured();
  if (!delivery) return { status: "not_configured" };
  const url = familyInvitationUrl(input.token);
  const familyName = escapeEmailHtml(input.familyName?.trim() || "a MATRIX family");
  const inviter = escapeEmailHtml(input.inviterName?.trim() || "A parent");
  const expires = escapeEmailHtml(new Date(input.expiresAt).toUTCString());
  const subject = input.resent ? "Reminder · your MATRIX family invitation" : "Your MATRIX family invitation";
  const text = `${input.inviterName ?? "A parent"} invited you to join ${input.familyName ?? "a MATRIX family"}.\n\nReview and explicitly accept: ${url}\n\nSign in with ${input.email}. This link stays valid until ${expires} and can be used once. Joining does not enable device monitoring; every supervision feature is separate and revocable.\n\nIf this was unexpected, ignore this email.`;
  const html = `<div style="background:#0b0f16;color:#f8fafc;padding:32px;font-family:Inter,Arial,sans-serif;border-radius:16px;max-width:560px">
  <p style="letter-spacing:.18em;font-size:11px;color:#7dd3fc;margin:0 0 8px">MATRIX · FAMILY</p>
  <h1 style="margin:0 0 12px;font-size:24px">${input.resent ? "Reminder: " : ""}You're invited to ${familyName}</h1>
  <p style="color:#cbd5e1;line-height:1.6;margin:0 0 20px">${inviter} invited you to a MATRIX family. Joining is your choice: device supervision features are separate, always visible on the device, and revocable at any time.</p>
  <p style="margin:0 0 24px"><a href="${escapeEmailHtml(url)}" style="display:inline-block;background:#38bdf8;color:#04121f;font-weight:600;padding:12px 22px;border-radius:10px;text-decoration:none">Review invitation</a></p>
  <p style="color:#94a3b8;font-size:13px;line-height:1.6;margin:0 0 8px">Sign in with <strong>${escapeEmailHtml(input.email)}</strong>. Single use · valid until ${expires}.</p>
  <p style="color:#64748b;font-size:12px;margin:0">If you were not expecting this, ignore the email — nothing happens until you accept.</p>
</div>`;
  // The initial message keeps the historical idempotency key so a retried save
  // can never double-send; a resend must be a NEW message, so it is keyed on
  // the rotated token instead of the invitation id.
  return post({
    delivery,
    idempotencyKey: input.resent ? `family-invitation/${input.id}/resend/${input.token.slice(0, 12)}` : `family-invitation/${input.id}`,
    to: input.email,
    subject,
    text,
    html,
  });
}

/** Message kinds that are informative only (no bearer token inside). */
export async function sendFamilyNotice(input: {
  id: string;
  email: string;
  kind: MessageKind;
  title: string;
  body: string;
  link?: string;
}): Promise<InvitationDelivery> {
  const delivery = configured();
  if (!delivery) return { status: "not_configured" };
  const body = escapeEmailHtml(input.body);
  const link = input.link ? escapeEmailHtml(input.link) : "";
  return post({
    delivery,
    idempotencyKey: `family-notice/${input.kind}/${input.id}`,
    to: input.email,
    subject: `MATRIX family · ${input.title}`,
    text: `${input.title}\n\n${input.body}${input.link ? `\n\n${input.link}` : ""}`,
    html: `<div style="background:#0b0f16;color:#f8fafc;padding:32px;font-family:Inter,Arial,sans-serif;border-radius:16px;max-width:560px">
  <p style="letter-spacing:.18em;font-size:11px;color:#7dd3fc;margin:0 0 8px">MATRIX · FAMILY</p>
  <h1 style="margin:0 0 12px;font-size:22px">${escapeEmailHtml(input.title)}</h1>
  <p style="color:#cbd5e1;line-height:1.6;margin:0 0 18px">${body}</p>
  ${link ? `<p style="margin:0"><a href="${link}" style="color:#38bdf8">Open MATRIX</a></p>` : ""}
  <p style="color:#64748b;font-size:12px;margin:20px 0 0">You receive this because you are a member of a MATRIX family. Manage notifications in Family settings.</p>
</div>`,
  });
}

async function post(input: {
  delivery: { key: string; from: string };
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}): Promise<InvitationDelivery> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${input.delivery.key}`,
          "Content-Type": "application/json",
          "Idempotency-Key": input.idempotencyKey,
        },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({
          from: input.delivery.from,
          to: [input.to],
          subject: input.subject,
          text: input.text,
          html: input.html,
        }),
      });
      if (response.ok) {
        const body = (await response.json().catch(() => ({}))) as { id?: string };
        return { status: "accepted_by_provider", ...(body.id ? { provider_id: body.id } : {}) };
      }
      if (response.status === 401 || response.status === 403) return { status: "failed", reason: "provider_key_rejected" };
      if (response.status === 422) return { status: "failed" };
      if (response.status === 429) {
        if (attempt < 2) { await wait(400 * 2 ** attempt); continue; }
        return { status: "failed", reason: "provider_rate_limited" };
      }
      if (response.status < 500) return { status: "failed" };
    } catch {
      /* Do not log provider responses, invitation tokens or credentials. */
    }
    if (attempt < 2) await wait(250 * 2 ** attempt);
  }
  return { status: "failed" };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
