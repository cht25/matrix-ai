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
import { getAuth, type Auth } from "firebase/auth";
import { getFirestore, type Firestore } from "firebase/firestore";
import { env, isConfigured } from "@/lib/env";

export const firebaseBrowserConfigured = isConfigured();

function app(): FirebaseApp {
  return getApps().length ? getApp() : initializeApp(env.firebasePublic);
}

let cachedAuth: Auth | null = null;
let cachedDb: Firestore | null = null;
export function fbAuth(): Auth {
  if (!cachedAuth) cachedAuth = getAuth(app());
  return cachedAuth;
}

export function fbDb(): Firestore {
  if (!cachedDb) cachedDb = getFirestore(app());
  return cachedDb;
}


export const FIREBASE_NOT_CONFIGURED_MESSAGE =
  "FIREBASE_NOT_CONFIGURED: NEXT_PUBLIC_FIREBASE_API_KEY / NEXT_PUBLIC_FIREBASE_PROJECT_ID are missing or invalid. " +
  "Set them in the host environment and redeploy.";
