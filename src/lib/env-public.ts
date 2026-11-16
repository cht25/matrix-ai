// Browser-safe Firebase configuration only. Do not add provider credentials or
// server-side environment variables here: this module is imported by the
// client Firebase SDK and is bundled for the browser.
//
// The resolution rules (including why `authDomain` is NOT simply the public
// website domain) live in one shared, unit-tested module so the client and the
// server can never disagree: src/lib/firebase/web-config.ts.

import { resolveFirebaseWebConfig, type ResolvedFirebaseWebConfig } from "@/lib/firebase/web-config";

const resolved: ResolvedFirebaseWebConfig = resolveFirebaseWebConfig({
  apiKey: process.env.NEXT_PUBLIC_FIREBASE_API_KEY,
  authDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
  projectId: process.env.NEXT_PUBLIC_FIREBASE_PROJECT_ID,
  messagingSenderId: process.env.NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.NEXT_PUBLIC_FIREBASE_APP_ID,
  appOrigin: process.env.NEXT_PUBLIC_APP_URL,
});

export const firebasePublic = resolved.config;

/** Real Firebase project id (used by the `/__/auth` reverse proxy). */
export const firebaseProjectId = resolved.config.projectId;

/** The origin that serves Firebase's auth helper (`/__/auth/handler`). */
export const firebaseAuthDomain = resolved.config.authDomain;

/**
 * True when `authDomain` is a custom hostname, so this deployment serves
 * Firebase's auth helper itself through the `/__/auth/*` reverse proxy.
 */
export const firebaseAuthUsesSameOriginHandler = resolved.sameOriginAuthHandler;

/** Non-secret configuration warnings for operators (never credentials). */
export const firebaseConfigWarnings: string[] = resolved.warnings;

export function isConfigured(): boolean {
  return resolved.configured;
}
