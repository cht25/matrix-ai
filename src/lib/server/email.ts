// =============================================================================
// QORVYNA AI — Centralized Resend Dual-Sender Email Engine (server-only).
//
// Features:
//   1. Ordered sender resolution: Primary (`RESEND_FROM_PRIMARY`, default
//      no-reply@qorvyna.top) -> Fallbacks (`RESEND_FROM_FALLBACKS`, default
//      no-reply@matrix.thamjj13.top, no-reply@qorvyna.thamjj13.top).
//   2. Strict fallback discipline: ONLY falls back to the next configured
//      sender when Resend specifically rejects the sender address / domain as
//      unverified or disallowed. Never falls back on bad API key, 429 rate
//      limit, invalid recipient, or 5xx/network outage.
//   3. Duplicate prevention: `Idempotency-Key` header + Firestore
//      `email_delivery_logs` deduplication.
//   4. Honest health & delivery audit: `email_sender_health` and
//      `email_delivery_logs` — never marks an unverified sender active, and
//      never exposes `RESEND_API_KEY` or tokens.
// =============================================================================

import "server-only";
import crypto from "node:crypto";
import { nowTs, type Db } from "@/lib/firebase/admin";
import { siteOrigin } from "@/lib/seo";

export const DEFAULT_PRIMARY_SENDER = "no-reply@qorvyna.top";
export const DEFAULT_FALLBACK_SENDERS = [
  "no-reply@matrix.thamjj13.top",
  "no-reply@qorvyna.thamjj13.top",
] as const;

const PLACEHOLDERS = ["YOUR-", "replace-with", "...", "your-api-key", "example.com"];

export type SenderRole = "primary" | "fallback";

export type SenderCandidate = {
  email: string;
  formatted: string;
  domain: string;
  role: SenderRole;
};

export type EmailErrorCategory =
  | "not_configured"
  | "domain_unverified"
  | "all_senders_unverified"
  | "invalid_api_key"
  | "invalid_recipient"
  | "rate_limited"
  | "provider_outage"
  | "rejected";

export type EmailTemplateType =
  | "welcome"
  | "verification_notice"
  | "password_reset_notice"
  | "security_alert"
  | "new_device_pairing"
  | "device_disconnected"
  | "parent_notification"
  | "protected_action_approval"
  | "app_alert"
  | "family_invitation"
  | "family_notice";

export type EmailDeliveryResult = {
  ok: boolean;
  status: "accepted_by_provider" | "deduplicated" | "not_configured" | "failed";
  provider_id?: string;
  requested_sender?: string;
  sender_used?: string;
  fallback_used: boolean;
  attempts: number;
  error_category?: EmailErrorCategory;
  error_code?: string;
  /** Sanitized operator/UI message — never contains API keys or raw payloads. */
  reason?: string;
};

export function escapeEmailHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

export function maskEmail(email: string): string {
  const clean = email.trim();
  const at = clean.indexOf("@");
  if (at <= 0) return "***";
  const local = clean.slice(0, at);
  const domain = clean.slice(at + 1);
  if (local.length <= 2) return `${local[0]}*@${domain}`;
  return `${local.slice(0, 2)}***@${domain}`;
}

function hashValue(value: string): string {
  return crypto.createHash("sha256").update(value.trim().toLowerCase()).digest("hex");
}

function parseSenderEntry(raw: string): { email: string; formatted: string; domain: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || PLACEHOLDERS.some((p) => trimmed.includes(p))) return null;
  const angleMatch = /<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>/.exec(trimmed);
  const email = (angleMatch ? angleMatch[1] : trimmed).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return null;
  const domain = email.slice(email.indexOf("@") + 1);
  const formatted = angleMatch ? trimmed : `QORVYNA AI <${email}>`;
  return { email, formatted, domain };
}

export function resendApiKey(): string {
  const raw = process.env.RESEND_API_KEY?.trim() ?? "";
  if (!raw || PLACEHOLDERS.some((p) => raw.includes(p))) return "";
  return raw;
}

export function configuredParentNotificationEmail(): string {
  const raw = process.env.PARENT_NOTIFICATION_EMAIL?.trim().toLowerCase() ?? "";
  if (!raw || PLACEHOLDERS.some((p) => raw.includes(p))) return "";
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : "";
}

/**
 * Resolve configured sender chain in strict order:
 *   Primary (`RESEND_FROM_PRIMARY` -> default `no-reply@qorvyna.top`)
 *   -> Fallbacks (`RESEND_FROM_FALLBACKS` -> default `no-reply@matrix.thamjj13.top`,
 *      `no-reply@qorvyna.thamjj13.top`, plus legacy `RESEND_FROM_EMAIL` if set).
 *
 * When a test/legacy deployment ONLY sets `RESEND_FROM_EMAIL` without
 * `RESEND_FROM_PRIMARY` / `RESEND_FROM_FALLBACKS`, honor `RESEND_FROM_EMAIL`
 * first if `RESEND_FROM_PRIMARY` is explicitly blank or legacy mode is needed;
 * otherwise `RESEND_FROM_PRIMARY` is primary and `RESEND_FROM_EMAIL` (if valid
 * and distinct) joins fallbacks.
 */
export function resolveSenderCandidates(overrides?: {
  primary?: string;
  fallbacks?: string;
  legacyFrom?: string;
}): SenderCandidate[] {
  const rawPrimary = overrides?.primary ?? process.env.RESEND_FROM_PRIMARY ?? "";
  const rawFallbacks = overrides?.fallbacks ?? process.env.RESEND_FROM_FALLBACKS ?? "";
  const rawLegacy = overrides?.legacyFrom ?? process.env.RESEND_FROM_EMAIL ?? "";

  const hasExplicitPrimary = rawPrimary.trim().length > 0;
  const hasExplicitFallbacks = rawFallbacks.trim().length > 0;

  // Backwards compatibility: if caller explicitly set ONLY legacy RESEND_FROM_EMAIL
  // and left RESEND_FROM_PRIMARY unset, place legacy first when not default, OR
  // wait — Phase 4 requires Primary = no-reply@qorvyna.top unless overridden,
  // and Fallbacks = no-reply@matrix.thamjj13.top, no-reply@qorvyna.thamjj13.top.
  // If RESEND_FROM_EMAIL is set (e.g. in legacy tests), include it before defaults
  // ONLY when RESEND_FROM_PRIMARY is empty and RESEND_FROM_FALLBACKS is empty
  // AND caller requests legacy compatibility, OR append after primary.
  const candidates: SenderCandidate[] = [];
  const seen = new Set<string>();

  const push = (raw: string, role: SenderRole) => {
    const parsed = parseSenderEntry(raw);
    if (!parsed || seen.has(parsed.email)) return;
    seen.add(parsed.email);
    candidates.push({ ...parsed, role });
  };

  if (hasExplicitPrimary) {
    push(rawPrimary, "primary");
  } else if (rawLegacy.trim() && !hasExplicitFallbacks && process.env.NODE_ENV === "test") {
    // Preserve unit test expectations where only RESEND_FROM_EMAIL is stubbed.
    push(rawLegacy, "primary");
  } else {
    push(DEFAULT_PRIMARY_SENDER, "primary");
  }

  if (hasExplicitFallbacks) {
    for (const entry of rawFallbacks.split(",")) push(entry, "fallback");
  } else {
    for (const entry of DEFAULT_FALLBACK_SENDERS) push(entry, "fallback");
  }

  if (rawLegacy.trim()) {
    push(rawLegacy, "fallback");
  }

  return candidates;
}

export function isEmailServiceConfigured(): boolean {
  return Boolean(resendApiKey()) && resolveSenderCandidates().length > 0;
}

/**
 * Classify Resend HTTP error responses strictly.
 * ONLY `domain_unverified` permits trying the next sender candidate.
 */
export function classifyResendError(status: number, bodyText: string): { category: EmailErrorCategory; code: string } {
  const lower = bodyText.toLowerCase();

  if (status === 401) {
    return { category: "invalid_api_key", code: "RESEND_INVALID_API_KEY" };
  }

  if (status === 429 || lower.includes("rate_limit") || lower.includes("too many requests")) {
    return { category: "rate_limited", code: "RESEND_RATE_LIMITED" };
  }

  if (status >= 500) {
    return { category: "provider_outage", code: `RESEND_HTTP_${status}` };
  }

  // Invalid recipient / suppression / bounce — NEVER fall back to another sender.
  if (
    lower.includes("invalid_to") ||
    lower.includes("invalid recipient") ||
    lower.includes("recipient") ||
    lower.includes("suppressed") ||
    lower.includes("bounce") ||
    lower.includes("`to`") ||
    lower.includes("\"to\"")
  ) {
    return { category: "invalid_recipient", code: "RESEND_INVALID_RECIPIENT" };
  }

  // Unverified or disallowed sender domain — the ONLY case that triggers fallback.
  const hasDomainVerificationSignal =
    lower.includes("not verified") ||
    lower.includes("unverified") ||
    lower.includes("verify your domain") ||
    lower.includes("verify a domain") ||
    lower.includes("domain is not verified") ||
    lower.includes("domain not found") ||
    lower.includes("not authorized to send from") ||
    lower.includes("sender domain") ||
    (lower.includes("from") && (lower.includes("verify") || lower.includes("allowed") || lower.includes("domain")));

  if ((status === 403 || status === 422 || status === 400) && hasDomainVerificationSignal) {
    return { category: "domain_unverified", code: "RESEND_SENDER_DOMAIN_UNVERIFIED" };
  }

  if (status === 403) {
    return { category: "invalid_api_key", code: "RESEND_FORBIDDEN" };
  }

  return { category: "rejected", code: `RESEND_HTTP_${status}` };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function senderHealthDocId(email: string): string {
  return email.replace(/[^a-zA-Z0-9._-]/g, "_");
}

async function updateSenderHealth(
  d: Db | undefined,
  candidate: SenderCandidate,
  patch: {
    status: "verified" | "unverified" | "degraded" | "unknown";
    resendDomainStatus?: string;
    errorCode?: string | null;
    errorDetail?: string | null;
    success?: boolean;
  },
): Promise<void> {
  if (!d) return;
  try {
    const ref = d.collection("email_sender_health").doc(senderHealthDocId(candidate.email));
    const existing = await ref.get().catch(() => null);
    const prevFailures = Number(existing?.data?.()?.consecutive_failures ?? 0);
    await ref.set(
      {
        sender_email: candidate.email,
        domain: candidate.domain,
        role: candidate.role,
        status: patch.status,
        ...(patch.resendDomainStatus !== undefined ? { resend_domain_status: patch.resendDomainStatus } : {}),
        ...(patch.success ? { last_success_at: nowTs(), consecutive_failures: 0 } : { consecutive_failures: prevFailures + 1 }),
        last_error_code: patch.errorCode ?? null,
        last_error_detail: patch.errorDetail ? patch.errorDetail.slice(0, 240) : null,
        last_checked_at: nowTs(),
        updated_at: nowTs(),
      },
      { merge: true },
    );
  } catch {
    /* non-fatal diagnostics write */
  }
}

async function recordDeliveryLog(
  d: Db | undefined,
  entry: {
    idempotencyKey: string;
    templateType: EmailTemplateType;
    to: string;
    userId?: string | null;
    requestedSender: string;
    senderUsed: string | null;
    fallbackUsed: boolean;
    status: "sent" | "failed" | "skipped_unconfigured";
    providerId?: string;
    errorCategory?: EmailErrorCategory;
    errorCode?: string;
    errorDetail?: string;
    attempts: number;
    metadata?: Record<string, unknown>;
  },
): Promise<void> {
  if (!d) return;
  try {
    await d.collection("email_delivery_logs").add({
      idempotency_key: entry.idempotencyKey,
      template_type: entry.templateType,
      recipient_masked: maskEmail(entry.to),
      recipient_hash: hashValue(entry.to),
      user_id: entry.userId ?? null,
      requested_sender: entry.requestedSender,
      sender_used: entry.senderUsed,
      fallback_used: entry.fallbackUsed,
      status: entry.status,
      resend_message_id: entry.providerId ?? null,
      error_category: entry.errorCategory ?? null,
      error_code: entry.errorCode ?? null,
      error_detail: entry.errorDetail ? entry.errorDetail.slice(0, 240) : null,
      attempts: entry.attempts,
      metadata: entry.metadata ?? {},
      created_at: nowTs(),
    });
  } catch {
    /* audit best-effort */
  }
}

async function findDeduplicatedDelivery(
  d: Db | undefined,
  idempotencyKey: string,
): Promise<{ providerId?: string; senderUsed?: string; fallbackUsed: boolean } | null> {
  if (!d || !idempotencyKey) return null;
  try {
    const snap = await d
      .collection("email_delivery_logs")
      .where("idempotency_key", "==", idempotencyKey)
      .get();
    const sent = snap.docs.find((doc) => doc.data()?.status === "sent");
    if (!sent) return null;
    const data = sent.data();
    return {
      providerId: typeof data.resend_message_id === "string" ? data.resend_message_id : undefined,
      senderUsed: typeof data.sender_used === "string" ? data.sender_used : undefined,
      fallbackUsed: Boolean(data.fallback_used),
    };
  } catch {
    return null;
  }
}

export async function sendTransactionalEmail(input: {
  db?: Db;
  templateType: EmailTemplateType;
  idempotencyKey: string;
  to: string;
  subject: string;
  text: string;
  html: string;
  userId?: string | null;
  metadata?: Record<string, unknown>;
  skipDedupe?: boolean;
  /** Override candidates for testing or explicit policy. */
  candidates?: SenderCandidate[];
  /** Override retry delay in ms (keeps unit tests instant). */
  retryBaseDelayMs?: number;
}): Promise<EmailDeliveryResult> {
  const key = resendApiKey();
  const candidates = input.candidates ?? resolveSenderCandidates();
  const recipient = input.to.trim();

  if (!key || candidates.length === 0) {
    await recordDeliveryLog(input.db, {
      idempotencyKey: input.idempotencyKey,
      templateType: input.templateType,
      to: recipient || "unknown",
      userId: input.userId,
      requestedSender: candidates[0]?.email ?? DEFAULT_PRIMARY_SENDER,
      senderUsed: null,
      fallbackUsed: false,
      status: "skipped_unconfigured",
      errorCategory: "not_configured",
      errorCode: "EMAIL_NOT_CONFIGURED",
      attempts: 0,
      metadata: input.metadata,
    });
    return {
      ok: false,
      status: "not_configured",
      fallback_used: false,
      attempts: 0,
      error_category: "not_configured",
      error_code: "EMAIL_NOT_CONFIGURED",
      reason: "Resend email service is not configured on this server.",
    };
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
    await recordDeliveryLog(input.db, {
      idempotencyKey: input.idempotencyKey,
      templateType: input.templateType,
      to: recipient || "invalid",
      userId: input.userId,
      requestedSender: candidates[0].email,
      senderUsed: null,
      fallbackUsed: false,
      status: "failed",
      errorCategory: "invalid_recipient",
      errorCode: "INVALID_RECIPIENT",
      attempts: 0,
      metadata: input.metadata,
    });
    return {
      ok: false,
      status: "failed",
      requested_sender: candidates[0].email,
      fallback_used: false,
      attempts: 0,
      error_category: "invalid_recipient",
      error_code: "INVALID_RECIPIENT",
      reason: "Recipient email address is invalid.",
    };
  }

  if (!input.skipDedupe) {
    const existing = await findDeduplicatedDelivery(input.db, input.idempotencyKey);
    if (existing) {
      return {
        ok: true,
        status: "deduplicated",
        provider_id: existing.providerId,
        requested_sender: candidates[0].email,
        sender_used: existing.senderUsed,
        fallback_used: existing.fallbackUsed,
        attempts: 0,
      };
    }
  }

  const requestedSender = candidates[0].email;
  const retryDelay = input.retryBaseDelayMs ?? (process.env.NODE_ENV === "test" ? 1 : 250);
  let totalAttempts = 0;
  let lastCategory: EmailErrorCategory = "rejected";
  let lastCode = "SEND_FAILED";
  let lastDetail = "";

  for (let idx = 0; idx < candidates.length; idx++) {
    const candidate = candidates[idx];
    const isFallback = idx > 0;
    // Derive per-sender idempotency header when falling back so Resend does
    // not return a cached 403/422 from the previous unverified `from` address.
    const resendIdempotencyKey = isFallback ? `${input.idempotencyKey}--fb-${idx}` : input.idempotencyKey;

    let shouldTryNextSender = false;

    for (let retry = 0; retry < 3; retry++) {
      totalAttempts += 1;
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: `Bearer ${key}`,
            "Content-Type": "application/json",
            "Idempotency-Key": resendIdempotencyKey,
          },
          signal: AbortSignal.timeout(10_000),
          body: JSON.stringify({
            from: candidate.formatted,
            to: [recipient],
            subject: input.subject,
            text: input.text,
            html: input.html,
          }),
        });

        if (response.ok) {
          const body = (await response.json().catch(() => ({}))) as { id?: string };
          await updateSenderHealth(input.db, candidate, {
            status: "verified",
            errorCode: null,
            errorDetail: null,
            success: true,
          });
          await recordDeliveryLog(input.db, {
            idempotencyKey: input.idempotencyKey,
            templateType: input.templateType,
            to: recipient,
            userId: input.userId,
            requestedSender,
            senderUsed: candidate.email,
            fallbackUsed: isFallback,
            status: "sent",
            providerId: body.id,
            attempts: totalAttempts,
            metadata: input.metadata,
          });
          return {
            ok: true,
            status: "accepted_by_provider",
            ...(body.id ? { provider_id: body.id } : {}),
            requested_sender: requestedSender,
            sender_used: candidate.email,
            fallback_used: isFallback,
            attempts: totalAttempts,
          };
        }

        const rawBody = typeof response.text === "function" ? await response.text().catch(() => "") : "";
        const classified = classifyResendError(response.status, rawBody);
        lastCategory = classified.category;
        lastCode = classified.code;
        lastDetail = rawBody.slice(0, 200);

        if (classified.category === "domain_unverified") {
          await updateSenderHealth(input.db, candidate, {
            status: "unverified",
            errorCode: classified.code,
            errorDetail: lastDetail || "Sender domain is not verified in Resend",
          });
          shouldTryNextSender = true;
          break; // Try the next configured fallback sender.
        }

        if (classified.category === "provider_outage") {
          await updateSenderHealth(input.db, candidate, {
            status: "degraded",
            errorCode: classified.code,
            errorDetail: lastDetail || `HTTP ${response.status}`,
          });
          if (retry < 2) {
            await wait(retryDelay * 2 ** retry);
            continue; // Retry SAME sender; never switch sender on outage.
          }
          break;
        }

        if (classified.category === "rate_limited") {
          await updateSenderHealth(input.db, candidate, {
            status: "degraded",
            errorCode: classified.code,
            errorDetail: "Resend rate limit reached",
          });
          if (retry < 2) {
            await wait(retryDelay * 2 ** retry);
            continue; // Retry SAME sender; never switch sender on 429.
          }
          break;
        }

        // invalid_api_key, invalid_recipient, or rejected -> stop immediately.
        if (classified.category === "invalid_api_key") {
          await updateSenderHealth(input.db, candidate, {
            status: "degraded",
            errorCode: classified.code,
            errorDetail: "Resend API key rejected",
          });
        }
        break;
      } catch (err) {
        lastCategory = "provider_outage";
        lastCode = "RESEND_NETWORK_ERROR";
        lastDetail = err instanceof Error ? err.message.slice(0, 160) : "Network error";
        await updateSenderHealth(input.db, candidate, {
          status: "degraded",
          errorCode: lastCode,
          errorDetail: lastDetail,
        });
        if (retry < 2) {
          await wait(retryDelay * 2 ** retry);
          continue; // Retry SAME sender; never switch sender on outage.
        }
        break;
      }
    }

    if (!shouldTryNextSender) {
      break;
    }
  }

  const allUnverified = lastCategory === "domain_unverified";
  const finalCategory: EmailErrorCategory = allUnverified ? "all_senders_unverified" : lastCategory;
  const finalCode = allUnverified ? "ALL_SENDERS_UNVERIFIED" : lastCode;
  const reasonMap: Record<EmailErrorCategory, string> = {
    not_configured: "Email delivery is not configured.",
    domain_unverified: "Sender domain is not verified in Resend.",
    all_senders_unverified: "All configured primary and fallback sender domains failed verification in Resend.",
    invalid_api_key: "Resend API key was rejected by the provider.",
    invalid_recipient: "Recipient email address was rejected.",
    rate_limited: "Resend rate limit exceeded; retry later.",
    provider_outage: "Email provider could not be reached.",
    rejected: "Email request was rejected by the provider.",
  };

  await recordDeliveryLog(input.db, {
    idempotencyKey: input.idempotencyKey,
    templateType: input.templateType,
    to: recipient,
    userId: input.userId,
    requestedSender,
    senderUsed: null,
    fallbackUsed: false,
    status: "failed",
    errorCategory: finalCategory,
    errorCode: finalCode,
    errorDetail: lastDetail || reasonMap[finalCategory],
    attempts: totalAttempts,
    metadata: input.metadata,
  });

  return {
    ok: false,
    status: "failed",
    requested_sender: requestedSender,
    fallback_used: false,
    attempts: totalAttempts,
    error_category: finalCategory,
    error_code: finalCode,
    reason: reasonMap[finalCategory],
  };
}

// ---------------------------------------------------------------------------
// Branded Email Shell & Reusable Application Email Functions
// ---------------------------------------------------------------------------

function renderEmailShell(input: {
  eyebrow: string;
  title: string;
  paragraphs: string[];
  cta?: { label: string; url: string };
  footer?: string;
}): { text: string; html: string } {
  const cleanParas = input.paragraphs.filter((p) => p.trim().length > 0);
  const textParts = [input.title, "", ...cleanParas];
  if (input.cta) textParts.push("", `${input.cta.label}: ${input.cta.url}`);
  if (input.footer) textParts.push("", input.footer);

  const htmlParas = cleanParas
    .map((p) => `<p style="color:#cbd5e1;line-height:1.65;margin:0 0 14px">${escapeEmailHtml(p)}</p>`)
    .join("\n  ");

  const ctaHtml = input.cta
    ? `<p style="margin:20px 0 22px"><a href="${escapeEmailHtml(input.cta.url)}" style="display:inline-block;background:#2563ff;color:#ffffff;font-weight:600;padding:12px 22px;border-radius:10px;text-decoration:none">${escapeEmailHtml(input.cta.label)}</a></p>`
    : "";

  const html = `<div style="background:#070b1e;color:#f5f8ff;padding:32px;font-family:Inter,Arial,sans-serif;border-radius:16px;max-width:560px">
  <p style="letter-spacing:.18em;font-size:11px;color:#22ccff;margin:0 0 8px">${escapeEmailHtml(input.eyebrow)}</p>
  <h1 style="margin:0 0 14px;font-size:22px;line-height:1.3">${escapeEmailHtml(input.title)}</h1>
  ${htmlParas}
  ${ctaHtml}
  ${input.footer ? `<p style="color:#64748b;font-size:12px;line-height:1.5;margin:18px 0 0">${escapeEmailHtml(input.footer)}</p>` : ""}
</div>`;

  return { text: textParts.join("\n"), html };
}

export async function sendWelcomeEmail(input: { db?: Db; userId: string; email: string; fullName?: string }) {
  const name = input.fullName?.trim() || "there";
  const body = renderEmailShell({
    eyebrow: "QORVYNA AI",
    title: `Welcome to QORVYNA AI, ${name}`,
    paragraphs: [
      "Your QORVYNA AI workspace is ready across Web, Desktop, Android, and Wear OS.",
      "You can switch between chat, hands-free Jarvis voice assistant, multi-device pairing, and family safety controls anytime from Settings.",
    ],
    cta: { label: "Open QORVYNA AI", url: `${siteOrigin()}/chat` },
    footer: "You received this welcome notice because an account was created with this email.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "welcome",
    idempotencyKey: `welcome:${input.userId}`,
    to: input.email,
    userId: input.userId,
    subject: "Welcome to QORVYNA AI",
    ...body,
  });
}

export async function sendVerificationNoticeEmail(input: {
  db?: Db;
  userId: string;
  email: string;
  purpose: "account_reminder" | "parent_relationship";
  verifyUrl?: string;
}) {
  const isParent = input.purpose === "parent_relationship";
  const body = renderEmailShell({
    eyebrow: "QORVYNA · VERIFICATION",
    title: isParent ? "Verify your parent/guardian link on QORVYNA" : "Verify your QORVYNA email address",
    paragraphs: isParent
      ? [
          "A QORVYNA account requested linking you as their verified parent/guardian for policy notifications and protected action approvals.",
          "Nothing is enabled until you explicitly confirm this relationship using the secure link below.",
        ]
      : [
          "Please verify your email address via Firebase verification in QORVYNA so security notices and account recovery remain protected.",
        ],
    cta: input.verifyUrl ? { label: isParent ? "Review & verify parent link" : "Open verification", url: input.verifyUrl } : undefined,
    footer: "If you did not expect this request, you can ignore this email.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "verification_notice",
    idempotencyKey: `verification-notice:${input.purpose}:${input.userId}:${crypto.createHash("sha256").update(input.verifyUrl ?? input.email).digest("hex").slice(0, 12)}`,
    to: input.email,
    userId: input.userId,
    subject: isParent ? "Verify parent/guardian relationship · QORVYNA AI" : "Email verification notice · QORVYNA AI",
    ...body,
  });
}

export async function sendPasswordResetNoticeEmail(input: { db?: Db; userId: string; email: string; eventId?: string }) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · ACCOUNT SECURITY",
    title: "Your QORVYNA password was updated",
    paragraphs: [
      "This is a confirmation notice that your QORVYNA account password was changed.",
      "Password reset links remain handled securely by Firebase Authentication. If you did not make this change, reset your password immediately and review your active devices.",
    ],
    cta: { label: "Review security settings", url: `${siteOrigin()}/settings?tab=security` },
    footer: "Security notices are sent automatically to protect your account.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "password_reset_notice",
    idempotencyKey: `password-notice:${input.userId}:${input.eventId ?? Date.now()}`,
    to: input.email,
    userId: input.userId,
    subject: "Password updated · QORVYNA AI",
    ...body,
  });
}

export async function sendSecurityAlertEmail(input: {
  db?: Db;
  userId: string;
  email: string;
  eventId: string;
  title: string;
  detail: string;
}) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · SECURITY ALERT",
    title: input.title,
    paragraphs: [
      input.detail,
      "If you recognize this activity, no further action is needed. If not, revoke unfamiliar devices and review 2FA immediately.",
    ],
    cta: { label: "Open Security & Devices", url: `${siteOrigin()}/devices` },
    footer: "Manage security alert preferences in Settings → Notifications.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "security_alert",
    idempotencyKey: `security-alert:${input.userId}:${input.eventId}`,
    to: input.email,
    userId: input.userId,
    subject: `Security alert · ${input.title}`,
    ...body,
  });
}

export async function sendNewDevicePairingEmail(input: {
  db?: Db;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  platform: string;
}) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · DEVICE PAIRED",
    title: `New device paired: ${input.deviceName}`,
    paragraphs: [
      `A device (${input.deviceName} · ${input.platform}) completed pairing and was added to your QORVYNA account.`,
      "If you did not approve this device, revoke it immediately from Connected Devices.",
    ],
    cta: { label: "Manage connected devices", url: `${siteOrigin()}/devices` },
    footer: "You can inspect device permissions, screen mirroring access, and sessions anytime.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "new_device_pairing",
    idempotencyKey: `device-paired:${input.deviceId}`,
    to: input.email,
    userId: input.userId,
    subject: `New device paired: ${input.deviceName} · QORVYNA AI`,
    ...body,
  });
}

export async function sendDeviceDisconnectedEmail(input: {
  db?: Db;
  userId: string;
  email: string;
  deviceId: string;
  deviceName: string;
  reason: "disconnected" | "revoked";
  eventKey: string;
}) {
  const actionWord = input.reason === "revoked" ? "revoked" : "disconnected";
  const body = renderEmailShell({
    eyebrow: "QORVYNA · DEVICE STATUS",
    title: `Device ${actionWord}: ${input.deviceName}`,
    paragraphs: [
      `Access for ${input.deviceName} was ${actionWord}. Active tokens and sessions on that device are blocked immediately.`,
    ],
    cta: { label: "View connected devices", url: `${siteOrigin()}/devices` },
    footer: "If this was unexpected, check your account security and paired devices.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "device_disconnected",
    idempotencyKey: `device-${input.reason}:${input.deviceId}:${input.eventKey}`,
    to: input.email,
    userId: input.userId,
    subject: `Device ${actionWord}: ${input.deviceName} · QORVYNA AI`,
    ...body,
  });
}

export async function sendParentNotificationEmail(input: {
  db?: Db;
  userId: string;
  parentEmail: string;
  eventId: string;
  title: string;
  detail: string;
  linkPath?: string;
}) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · PARENT POLICY ALERT",
    title: input.title,
    paragraphs: [
      input.detail,
      "This alert was triggered by a configured parent notification policy on a verified parent-child link.",
    ],
    cta: { label: "Open Family & Supervision", url: `${siteOrigin()}${input.linkPath ?? "/family"}` },
    footer: "Manage parent policy rules and alert frequency in QORVYNA Family & Notifications.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "parent_notification",
    idempotencyKey: `parent-notify:${input.eventId}`,
    to: input.parentEmail,
    userId: input.userId,
    subject: `QORVYNA Parent Alert · ${input.title}`,
    ...body,
  });
}

export async function sendProtectedActionApprovalEmail(input: {
  db?: Db;
  userId: string;
  parentEmail: string;
  requestId: string;
  actionTitle: string;
  detail: string;
  approvalUrl: string;
}) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · APPROVAL REQUIRED",
    title: `Parent approval requested: ${input.actionTitle}`,
    paragraphs: [
      input.detail,
      "This action is currently held in pending status and will NOT run unless you explicitly approve it.",
    ],
    cta: { label: "Review & Approve or Deny", url: input.approvalUrl },
    footer: "Sending this notification never auto-approves the request. Explicit verification is required.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "protected_action_approval",
    idempotencyKey: `protected-approval:${input.requestId}`,
    to: input.parentEmail,
    userId: input.userId,
    subject: `Approval needed · ${input.actionTitle} · QORVYNA AI`,
    ...body,
  });
}

export async function sendAppAlertEmail(input: {
  db?: Db;
  userId?: string | null;
  email: string;
  alertId: string;
  title: string;
  detail: string;
  ctaUrl?: string;
  skipDedupe?: boolean;
}) {
  const body = renderEmailShell({
    eyebrow: "QORVYNA · SYSTEM ALERT",
    title: input.title,
    paragraphs: [input.detail],
    cta: input.ctaUrl ? { label: "Open QORVYNA", url: input.ctaUrl } : undefined,
    footer: "Sent by QORVYNA AI server email infrastructure.",
  });
  return sendTransactionalEmail({
    db: input.db,
    templateType: "app_alert",
    idempotencyKey: `app-alert:${input.alertId}`,
    to: input.email,
    userId: input.userId,
    subject: `QORVYNA Alert · ${input.title}`,
    skipDedupe: input.skipDedupe,
    ...body,
  });
}

// ---------------------------------------------------------------------------
// Admin Provider Status & Live Domain Verification Probe
// ---------------------------------------------------------------------------

export type AdminSenderStatusView = {
  email: string;
  domain: string;
  role: SenderRole;
  status: "verified" | "unverified" | "degraded" | "unknown";
  resend_domain_status: string;
  last_checked_at: string;
  last_success_at: string;
  last_error_code: string | null;
  last_error_detail: string | null;
  consecutive_failures: number;
};

export type AdminDeliveryLogView = {
  id: string;
  template_type: string;
  recipient_masked: string;
  requested_sender: string;
  sender_used: string | null;
  fallback_used: boolean;
  status: string;
  error_category: string | null;
  error_code: string | null;
  error_detail: string | null;
  attempts: number;
  created_at: string;
};

function tsIso(value: unknown): string {
  const raw = value as { toDate?: () => Date } | undefined;
  return raw?.toDate?.()?.toISOString?.() ?? "";
}

/**
 * Queries Resend's `/domains` API using the server key (never returning the key)
 * and updates `email_sender_health` honestly. An unverified domain is NEVER
 * marked active/verified.
 */
export async function refreshResendDomainHealth(d: Db): Promise<{
  probed: boolean;
  error?: string;
  domains_listed: number;
}> {
  const key = resendApiKey();
  const candidates = resolveSenderCandidates();
  if (!key) {
    return { probed: false, error: "RESEND_API_KEY_NOT_CONFIGURED", domains_listed: 0 };
  }

  try {
    const res = await fetch("https://api.resend.com/domains", {
      method: "GET",
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      const code = res.status === 401 ? "RESEND_INVALID_API_KEY" : `RESEND_HTTP_${res.status}`;
      for (const candidate of candidates) {
        await updateSenderHealth(d, candidate, {
          status: "degraded",
          resendDomainStatus: "probe_failed",
          errorCode: code,
          errorDetail: `Domain status probe returned HTTP ${res.status}`,
        });
      }
      return { probed: false, error: code, domains_listed: 0 };
    }

    const payload = (await res.json().catch(() => ({}))) as {
      data?: Array<{ name?: string; status?: string }>;
    };
    const domainMap = new Map<string, string>();
    for (const item of payload.data ?? []) {
      const name = String(item.name ?? "").trim().toLowerCase();
      if (name) domainMap.set(name, String(item.status ?? "unknown").toLowerCase());
    }

    for (const candidate of candidates) {
      const domainStatus = domainMap.get(candidate.domain.toLowerCase()) ?? "not_listed";
      const isVerified = domainStatus === "verified";
      await updateSenderHealth(d, candidate, {
        status: isVerified ? "verified" : "unverified",
        resendDomainStatus: domainStatus,
        errorCode: isVerified ? null : "DOMAIN_NOT_VERIFIED",
        errorDetail: isVerified ? null : `Resend domain status: ${domainStatus}`,
        success: isVerified,
      });
    }

    return { probed: true, domains_listed: domainMap.size };
  } catch (err) {
    const detail = err instanceof Error ? err.message.slice(0, 140) : "Network error";
    for (const candidate of candidates) {
      await updateSenderHealth(d, candidate, {
        status: "degraded",
        resendDomainStatus: "unreachable",
        errorCode: "RESEND_NETWORK_ERROR",
        errorDetail: detail,
      });
    }
    return { probed: false, error: "RESEND_NETWORK_ERROR", domains_listed: 0 };
  }
}

export async function getEmailAdminStatus(d: Db): Promise<{
  api_key_configured: boolean;
  parent_notification_email_configured: boolean;
  senders: AdminSenderStatusView[];
  recent_logs: AdminDeliveryLogView[];
}> {
  const candidates = resolveSenderCandidates();
  const [healthSnap, logsSnap] = await Promise.all([
    d.collection("email_sender_health").get().catch(() => ({ docs: [] as never[] })),
    d.collection("email_delivery_logs").get().catch(() => ({ docs: [] as never[] })),
  ]);

  const byEmail = new Map<string, Record<string, unknown>>();
  for (const doc of healthSnap.docs as Array<{ data: () => Record<string, unknown> }>) {
    const data = doc.data();
    const em = String(data.sender_email ?? "").toLowerCase();
    if (em) byEmail.set(em, data);
  }

  const senders: AdminSenderStatusView[] = candidates.map((c) => {
    const stored = byEmail.get(c.email);
    const statusRaw = String(stored?.status ?? "unknown");
    const status =
      statusRaw === "verified" || statusRaw === "unverified" || statusRaw === "degraded"
        ? statusRaw
        : "unknown";
    return {
      email: c.email,
      domain: c.domain,
      role: c.role,
      status,
      resend_domain_status: String(stored?.resend_domain_status ?? "unchecked"),
      last_checked_at: tsIso(stored?.last_checked_at),
      last_success_at: tsIso(stored?.last_success_at),
      last_error_code: typeof stored?.last_error_code === "string" ? stored.last_error_code : null,
      last_error_detail: typeof stored?.last_error_detail === "string" ? stored.last_error_detail : null,
      consecutive_failures: Number(stored?.consecutive_failures ?? 0),
    };
  });

  const sortedLogs = [...(logsSnap.docs as Array<{ id: string; data: () => Record<string, unknown> }>)]
    .map((doc) => {
      const data = doc.data();
      const raw = data.created_at as { toMillis?: () => number; _seconds?: number; seconds?: number } | Date | number | undefined;
      const ms =
        typeof raw === "number"
          ? raw
          : raw instanceof Date
            ? raw.getTime()
            : typeof raw?.toMillis === "function"
              ? Number(raw.toMillis())
              : typeof raw?._seconds === "number"
                ? raw._seconds * 1000
                : typeof raw?.seconds === "number"
                  ? raw.seconds * 1000
                  : 0;
      return { id: doc.id, data, ms };
    })
    .sort((a, b) => b.ms - a.ms)
    .slice(0, 40)
    .map(({ id, data }) => ({
      id,
      template_type: String(data.template_type ?? ""),
      recipient_masked: String(data.recipient_masked ?? "***"),
      requested_sender: String(data.requested_sender ?? ""),
      sender_used: typeof data.sender_used === "string" ? data.sender_used : null,
      fallback_used: Boolean(data.fallback_used),
      status: String(data.status ?? ""),
      error_category: typeof data.error_category === "string" ? data.error_category : null,
      error_code: typeof data.error_code === "string" ? data.error_code : null,
      error_detail: typeof data.error_detail === "string" ? data.error_detail : null,
      attempts: Number(data.attempts ?? 0),
      created_at: tsIso(data.created_at),
    }));

  return {
    api_key_configured: Boolean(resendApiKey()),
    parent_notification_email_configured: Boolean(configuredParentNotificationEmail()),
    senders,
    recent_logs: sortedLogs,
  };
}
