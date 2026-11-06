import "server-only";
import { siteOrigin } from "@/lib/seo";

export type InvitationDelivery = {
  status: "accepted_by_provider" | "not_configured" | "failed";
  provider_id?: string;
};

/** The fragment stays out of HTTP access logs and Referer headers. */
export function familyInvitationUrl(token: string): string {
  return `${siteOrigin()}/family#invite=${encodeURIComponent(token)}`;
}

export function escapeEmailHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Server-only, bounded retries, stable idempotency key. Acceptance is not delivery. */
export async function sendFamilyInvitation(input: {
  id: string; email: string; token: string; expiresAt: string;
}): Promise<InvitationDelivery> {
  const key = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!key || !from) return { status: "not_configured" };
  const url = familyInvitationUrl(input.token);
  const text = `You have been invited to a MATRIX family. Review and explicitly accept at ${url}. Sign in with ${input.email}. This single-use invitation expires ${input.expiresAt}. Joining does not enable device monitoring. If unexpected, ignore this email.`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "Idempotency-Key": `family-invitation/${input.id}` },
        signal: AbortSignal.timeout(10_000),
        body: JSON.stringify({ from, to: [input.email], subject: "Your MATRIX family invitation", text,
          html: `<div style="background:#111827;color:#f9fafb;padding:32px;font-family:Arial,sans-serif"><h1>MATRIX</h1><h2>Your family invitation</h2><p>Review your invitation and choose whether to join. Device monitoring is not enabled by joining.</p><p><a style="color:#34d399" href="${escapeEmailHtml(url)}">Review invitation</a></p><p>Sign in with ${escapeEmailHtml(input.email)}. Single use · expires ${escapeEmailHtml(input.expiresAt)}.</p><p>If unexpected, ignore this email.</p><small>MATRIX AI Cyber Safety · THAMJJ13.TOP</small></div>` }),
      });
      if (response.ok) {
        const body = await response.json() as { id?: string };
        return { status: "accepted_by_provider", ...(body.id ? { provider_id: body.id } : {}) };
      }
      if (response.status !== 429 && response.status < 500) break;
    } catch { /* Do not log provider responses, invitation tokens or credentials. */ }
    if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250 * 2 ** attempt));
  }
  return { status: "failed" };
}
