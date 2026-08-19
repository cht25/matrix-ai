// Server-only Firebase Admin SDK accessor (Auth + Firestore + Storage).
// Privileged operations happen exclusively inside Next.js API routes and
// server components; firestore.rules keep the browser path read-only.
//
// Credentials resolution:
//   1. Explicit service account (FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY)
//      — the recommended path on Render/Vercel/Docker.
//   2. Google Application Default Credentials — automatic on Firebase App
//      Hosting, Cloud Run and GCE VMs.
//   3. The local emulator (FIREBASE_AUTH_EMULATOR_HOST / emulator env vars).

import "server-only";
import { App, getApps, initializeApp, cert } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { env, isConfigured, isServerConfigured, logMissingFirebaseConfig, serviceAccount } from "@/lib/env";
import { NotConfiguredError } from "@/lib/data";

let cachedApp: App | null = null;

function getApp(): App {
  if (cachedApp) return cachedApp;
  const existing = getApps();
  if (existing.length) {
    cachedApp = existing[0];
    return cachedApp;
  }
  const sa = serviceAccount();
  if (sa) {
    cachedApp = initializeApp({ credential: cert(sa) });
  } else {
    // ADC (App Hosting / Cloud Run / emulator).
    cachedApp = initializeApp({});
  }
  return cachedApp;
}

/** True when Admin credential env vars look usable. */
export function adminConfigured(): boolean {
  return isConfigured() && (isServerConfigured() || process.env.FIRESTORE_EMULATOR_HOST != null);
}

function ensure(): App {
  if (!adminConfigured()) {
    logMissingFirebaseConfig();
    throw new NotConfiguredError();
  }
  return getApp();
}

export function adminAuth() {
  return getAuth(ensure());
}

export function adminDb() {
  return getFirestore(ensure());
}


// ---------------------------------------------------------------------------
// Firestore helpers (Timestamps everywhere; ISO strings at the edges)
// ---------------------------------------------------------------------------

export type Db = ReturnType<typeof adminDb>;

export function nowTs(): Timestamp {
  return Timestamp.now();
}

export function iso(ts: Timestamp | Date | undefined | null): string {
  if (!ts) return "";
  return (ts instanceof Date ? ts : ts.toDate()).toISOString();
}

export function toTs(value: string | Date | Timestamp | undefined | null): Timestamp {
  if (!value) return nowTs();
  if (typeof value === "string") return Timestamp.fromDate(new Date(value));
  if (value instanceof Date) return Timestamp.fromDate(value);
  return value;
}
