// Server-side data access core (Firebase).
//
// Firestore + Admin SDK replace Postgres + RLS. All authorization happens in
// this server layer (the port of the old RLS/RPC contract): every query is
// scoped by the verified session-cookie uid, and privileged operations go
// through the RPC ports in src/lib/server/rpc.ts. The browser Firestore
// client is read-only by security rules, so clients can never bypass this.
//
// There is no demo mode: when Firebase is not configured this throws a typed
// NotConfiguredError so pages/layouts render an honest configuration screen
// instead of pretending to load data.

import "server-only";
import { getSessionUser, type SessionUser } from "@/lib/firebase/session";
import { isConfigured, logMissingFirebaseConfig } from "@/lib/env";
import { adminDb, adminConfigured } from "@/lib/firebase/admin";

export class NotConfiguredError extends Error {
  readonly code = "FIREBASE_NOT_CONFIGURED" as const;
  constructor() {
    super("Firebase configuration is missing (NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID / service account).");
    this.name = "NotConfiguredError";
  }
}

export function isNotConfiguredError(err: unknown): err is NotConfiguredError {
  return err instanceof NotConfiguredError || (typeof err === "object" && err !== null && (err as { code?: string }).code === "FIREBASE_NOT_CONFIGURED");
}

/** Verified session user for server components, or null when signed out. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  return getSessionUser();
}

/** Session user or throw NotConfiguredError (pages render the config screen). */
export async function requireUser(): Promise<SessionUser> {
  if (!isConfigured()) {
    logMissingFirebaseConfig();
    throw new NotConfiguredError();
  }
  const user = await getSessionUser();
  if (!user) throw new NotConfiguredError(); // middleware normally prevents this
  return user;
}

export function db() {
  if (!adminConfigured()) {
    logMissingFirebaseConfig();
    throw new NotConfiguredError();
  }
  return adminDb();
}

export type { SessionUser };
