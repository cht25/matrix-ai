"use client";

// Browser-side Firebase client (Auth + Firestore).
//
// NEXT_PUBLIC_* values are inlined by the bundler at build time, so
// `firebaseBrowserConfigured` is a compile-time-known constant per deploy.
// Client components (login/register/settings/...) check it and render an
// honest "Server problem — service not configured" state instead of crashing
// or pretending an API is reachable.
//
// Security model: ALL writes go through Next.js API routes backed by the
// Admin SDK (which enforce ownership, validation, audit and security events —
// the port of the old Postgres RPC layer). The client SDK is used for
// authentication, session minting and image uploads only; firestore.rules
// deny every client write and only allow reading your own data / public
// content.

import { initializeApp, getApps, getApp, type FirebaseApp } from "firebase/app";
import { connectAuthEmulator, getAuth, onAuthStateChanged, type Auth, type User } from "firebase/auth";
import { connectFirestoreEmulator, getFirestore, type Firestore } from "firebase/firestore";
import { firebasePublic, isConfigured } from "@/lib/env-public";

export const firebaseBrowserConfigured = isConfigured();

// Optional emulator wiring for local QA (`npm run emulators` + `next dev`).
// Activated exclusively by NEXT_PUBLIC_FIREBASE_EMULATOR_HOST (e.g.
// "localhost") — never in a production build unless deliberately set. Example:
//   NEXT_PUBLIC_FIREBASE_EMULATOR_HOST=localhost
//   auth → http://$HOST:9099 · firestore → $HOST:8080
const EMULATOR_HOST = (process.env.NEXT_PUBLIC_FIREBASE_EMULATOR_HOST ?? "").trim();

function app(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(firebasePublic);
}

let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
let emulatorsConnected = false;

function connectEmulators(auth: Auth, db: Firestore) {
  if (emulatorsConnected || !EMULATOR_HOST) return;
  emulatorsConnected = true;
  try {
    connectAuthEmulator(auth, `http://${EMULATOR_HOST}:9099`, { disableWarnings: true });
    connectFirestoreEmulator(db, EMULATOR_HOST, 8080);
    console.warn(`[MATRIX] Firebase emulators enabled at ${EMULATOR_HOST} (local QA only).`);
  } catch {
    // connectAuthEmulator throws if called after the first auth op — harmless:
    // the module-level caches keep this single-shot.
  }
}

export function fbAuth(): Auth {
  if (!cachedAuth) {
    cachedAuth = getAuth(app());
    connectEmulators(cachedAuth, fbDb());
  }
  return cachedAuth;
}

export function fbDb(): Firestore {
  if (!cachedDb) cachedDb = getFirestore(app());
  return cachedDb;
}


export const FIREBASE_NOT_CONFIGURED_MESSAGE =
  "FIREBASE_NOT_CONFIGURED: NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID are missing or invalid. " +
  "Set them in the host environment and redeploy.";

/** Wait until Firebase Auth has restored a persisted session (or timed out). */
export function waitForAuthUser(timeoutMs = 4000): Promise<User | null> {
  if (!firebaseBrowserConfigured) return Promise.resolve(null);
  const auth = fbAuth();
  if (auth.currentUser) return Promise.resolve(auth.currentUser);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve(auth.currentUser);
    }, timeoutMs);
    const unsub = onAuthStateChanged(auth, (user) => {
      clearTimeout(timer);
      unsub();
      resolve(user);
    });
  });
}
