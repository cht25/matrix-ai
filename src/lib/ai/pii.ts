// =============================================================================
// PII detection & redaction service (spec §16)
//
// Runs BEFORE anything is sent to Groq. Never send to the AI: birth certificate
// numbers, government IDs, passwords, OTPs, phone numbers, emails, addresses,
// tokens, payment information, recovery secrets.
// =============================================================================

export type RedactionResult = {
  redacted: string;
  detected: RedactionItem[];
  safe: boolean; // true = no PII detected
};

export type RedactionItem = {
  type: string;
  label: string; // e.g. "EMAIL"
  start: number;
  end: number;
};

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(?\d{2,4}\)?[\s.-]?)?\d{3,4}[\s.-]?\d{3,4}(?!\d)/g;
const OTP_RE = /\b(?:one[- ]?time[- ]?(?:password|code|pin)|otp|verification[- ]?code|auth[- ]?code|login[- ]?code)\b(?:[:\s]+| is | equals )?[\dA-Za-z]{4,10}/gi;
const PASSWORD_RE = /\b(?:password|passwd|pwd|pin|passphrase)\b[:\s]*[^\s,.;!?]{4,}/gi;
const CARD_RE = /\b(?:\d[ -]?){13,19}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;
const ID_RE =
  /\b(?:birth[- ]?certificate(?:[- ]?(?:no|number|#))?|cert(?:ificate)?[- ]?(?:no|number|#)|জন্মনিবন্ধন|national[- ]?id|nid|ssn|social[- ]?security|passport|driving[- ]?licen[cs]e|aadhaar|tax[- ]?id)\b[:\s#]*[A-Za-z0-9-]{4,}/gi;
const DOB_RE =
  /\b(?:date[- ]of[- ]birth|dob|born on|জন্ম(?:\s*তারিখ)?|জন্মতারিখ)\b(?:[:\s]+(?:is|was|=)?[:\s]*)?\d{4}[-/]\d{1,2}[-/]\d{1,2}/gi;
const ADDRESS_RE =
  /\b(?:street|road|avenue|ave|boulevard|blvd|lane|ln|house|home|address|building|apartment|apt|flat|village|district)\b[^\n.]{3,80}/gi;
const TOKEN_RE = /\b(?:token|api[- ]?key|secret[- ]?key|access[- ]?token|bearer)\b[:\s]*[A-Za-z0-9_\-\.]{8,}/gi;

// Order matters: high-specificity secrets first, generic digit/phone patterns
// last (a phone regex would otherwise swallow OTP digits and card numbers).
const REDACTORS: { type: string; label: string; re: RegExp }[] = [
  { type: "jwt", label: "AUTH_TOKEN", re: JWT_RE },
  { type: "otp", label: "ONE_TIME_CODE", re: OTP_RE },
  { type: "password", label: "PASSWORD", re: PASSWORD_RE },
  { type: "government_id", label: "GOVERNMENT_ID", re: ID_RE },
  { type: "dob", label: "DATE_OF_BIRTH", re: DOB_RE },
  { type: "token", label: "SECRET_TOKEN", re: TOKEN_RE },
  { type: "card", label: "PAYMENT_CARD", re: CARD_RE },
  { type: "email", label: "EMAIL", re: EMAIL_RE },
  { type: "phone", label: "PHONE", re: PHONE_RE },
  { type: "address", label: "ADDRESS", re: ADDRESS_RE },
];

/** Detect and redact PII, replacing matches with safe placeholders. */
export function redactPII(input: string): RedactionResult {
  const detected: RedactionItem[] = [];

  let redacted = input;
  for (const r of REDACTORS) {
    const re = new RegExp(r.re.source, "gi");
    redacted = redacted.replace(re, (match) => {
      detected.push({ type: r.type, label: r.label, start: -1, end: -1 });
      return `[${r.label}]`;
    });
  }

  return {
    redacted,
    detected,
    safe: detected.length === 0,
  };
}

/** True when the text contains anything that looks like a credential. */
export function containsCredentials(input: string): boolean {
  const probe = redactPII(input);
  return probe.detected.some((d) =>
    ["otp", "password", "jwt", "token", "card", "government_id"].includes(d.type),
  );
}

/** Check that an AI response does not echo back redacted PII. */
export function leakedPII(original: string, response: string): string[] {
  const leaks: string[] = [];
  for (const r of REDACTORS) {
    const re = new RegExp(r.re.source, "gi");
    for (const m of original.matchAll(re)) {
      if (response.includes(m[0])) leaks.push(m[0]);
    }
  }
  return leaks;
}
