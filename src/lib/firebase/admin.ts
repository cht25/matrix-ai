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
    cachedApp = initializeApp({
      credential: cert(sa),
      ...(sa.projectId ? { projectId: sa.projectId } : {}),
    });
  } else {
    // ADC (App Hosting / Cloud Run / emulator). Supply the configured public
    // project ID when available so Auth/Firestore resolve the project even
    // when GOOGLE_CLOUD_PROJECT is unset in container environments.
    const projectId = env.firebasePublic.projectId || undefined;
    cachedApp = initializeApp(projectId ? { projectId } : {});
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

const MAX_DATE_MS = 8_640_000_000_000_000;

export function safeTimestampMillis(value: unknown): number {
  if (value == null) return 0;
  if (typeof value === "number") {
    return Number.isFinite(value) && Math.abs(value) <= MAX_DATE_MS ? value : 0;
  }
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : 0;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return 0;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) && Math.abs(parsed) <= MAX_DATE_MS ? parsed : 0;
  }
  if (typeof value === "object") {
    const anyVal = value as {
      toMillis?: () => number;
      toDate?: () => Date;
      _seconds?: number;
      _nanoseconds?: number;
      seconds?: number;
      nanoseconds?: number;
    };
    if (typeof anyVal.toMillis === "function") {
      try {
        const ms = Number(anyVal.toMillis());
        return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : 0;
      } catch {
        return 0;
      }
    }
    if (typeof anyVal.toDate === "function") {
      try {
        const t = anyVal.toDate().getTime();
        return Number.isFinite(t) && Math.abs(t) <= MAX_DATE_MS ? t : 0;
      } catch {
        return 0;
      }
    }
    const secs = typeof anyVal._seconds === "number" ? anyVal._seconds : typeof anyVal.seconds === "number" ? anyVal.seconds : null;
    if (secs !== null && Number.isFinite(secs)) {
      const nanos =
        typeof anyVal._nanoseconds === "number"
          ? anyVal._nanoseconds
          : typeof anyVal.nanoseconds === "number"
            ? anyVal.nanoseconds
            : 0;
      const ms = secs * 1000 + Math.floor((Number.isFinite(nanos) ? nanos : 0) / 1_000_000);
      return Number.isFinite(ms) && Math.abs(ms) <= MAX_DATE_MS ? ms : 0;
    }
  }
  return 0;
}

export function iso(ts: unknown): string {
  const ms = safeTimestampMillis(ts);
  if (!ms) return "";
  try {
    return new Date(ms).toISOString();
  } catch {
    return "";
  }
}

export function toTs(value: string | Date | Timestamp | undefined | null): Timestamp {
  if (!value) return nowTs();
  if (typeof value === "string") return Timestamp.fromDate(new Date(value));
  if (value instanceof Date) return Timestamp.fromDate(value);
  return value;
}
