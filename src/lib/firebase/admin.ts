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
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";
import type { Storage } from "firebase-admin/storage";
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
    cachedApp = initializeApp({
      credential: cert(sa),
      storageBucket: env.storageBucket || undefined,
    });
  } else {
    // ADC (App Hosting / Cloud Run / emulator). Storage bucket optional.
    cachedApp = initializeApp({
      storageBucket: env.storageBucket || undefined,
    });
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

type AdminBucket = ReturnType<Storage["bucket"]>;
let cachedBucket: AdminBucket | null = null;

export function adminBucket(): AdminBucket {
  if (!cachedBucket) {
    const storage = getStorage(ensure());
    cachedBucket = storage.bucket(env.storageBucket || undefined);
  }
  return cachedBucket;
}

// ---------------------------------------------------------------------------
// Firestore helpers (Timestamps everywhere; ISO strings at the edges)
// ---------------------------------------------------------------------------

export type Db = ReturnType<typeof adminDb>;

export function nowTs(): FirebaseFirestore.Timestamp {
  return FirebaseFirestore.Timestamp.now();
}

export function iso(ts: FirebaseFirestore.Timestamp | Date | undefined | null): string {
  if (!ts) return "";
  return (ts instanceof Date ? ts : ts.toDate()).toISOString();
}

export function toTs(value: string | Date | FirebaseFirestore.Timestamp | undefined | null): FirebaseFirestore.Timestamp {
  if (!value) return nowTs();
  if (typeof value === "string") return FirebaseFirestore.Timestamp.fromDate(new Date(value));
  if (value instanceof Date) return FirebaseFirestore.Timestamp.fromDate(value);
  return value;
}
