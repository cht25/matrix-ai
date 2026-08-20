// Birth-certificate number normalisation + HMAC hashing.
// The raw number never leaves this module as a stored field.

import crypto from "node:crypto";

export type CertValidation =
  | { ok: true; normalized: string }
  | { ok: false; reason: "CERT_NUMBER_MISSING" | "CERT_NUMBER_INVALID" };

const OBVIOUS_FAKES = new Set([
  "000000",
  "0000000",
  "00000000",
  "123456",
  "1234567",
  "12345678",
  "123456789",
  "1234567890",
  "0123456789",
  "9876543210",
  "ABCDEF",
  "ABC123",
  "ABCDEFGH",
  "TESTTEST",
  "XXXXXXXX",
]);

export function normalizeCertNumber(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function validateCertNumber(input: string | null | undefined): CertValidation {
  if (!input || !input.trim()) return { ok: false, reason: "CERT_NUMBER_MISSING" };
  const normalized = normalizeCertNumber(input);
  if (!normalized) return { ok: false, reason: "CERT_NUMBER_MISSING" };
  if (normalized.length < 6 || normalized.length > 32) return { ok: false, reason: "CERT_NUMBER_INVALID" };
  if (!/^[A-Z0-9]+$/.test(normalized)) return { ok: false, reason: "CERT_NUMBER_INVALID" };
  if (/^([A-Z0-9])\1+$/.test(normalized)) return { ok: false, reason: "CERT_NUMBER_INVALID" };
  if (OBVIOUS_FAKES.has(normalized)) return { ok: false, reason: "CERT_NUMBER_INVALID" };
  return { ok: true, normalized };
}

export function hashIdentity(pepper: string, value: string): string {
  return crypto.createHmac("sha256", pepper).update(value, "utf8").digest("hex");
}

export function identityHashes(pepper: string, uid: string, normalized: string): {
  identity_hash: string;
  identity_hash_global: string;
  identity_last4: string;
  identity_hash_version: number;
} {
  return {
    identity_hash: hashIdentity(pepper, `${uid}:${normalized}`),
    identity_hash_global: hashIdentity(pepper, normalized),
    identity_last4: normalized.slice(-4),
    identity_hash_version: 1,
  };
}

export function maskLast4(last4: string | undefined | null): string {
  if (!last4) return "••••";
  return `••••${last4.slice(-4)}`;
}
