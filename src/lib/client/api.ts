"use client";

// Client-side helpers for the Firebase-backed MATRIX backend.
// All mutations go through /api/rpc (server-verified, audited); uploads go to
// Cloud Storage under the signed-in user's own folder (enforced by rules).

import { fbAuth, fbStorage } from "@/lib/firebase/client";
import { ref, uploadBytes } from "firebase/storage";

export class RpcCallError extends Error {
  constructor(readonly code: string, readonly status: number) {
    super(code);
    this.name = "RpcCallError";
  }
}

/** POST /api/rpc — same-origin, authenticated by the __session cookie. */
export async function rpc<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch("/api/rpc", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...args }),
    credentials: "same-origin",
  });
  const data = (await res.json().catch(() => ({}))) as { data?: T; error?: string };
  if (!res.ok) throw new RpcCallError(data.error ?? `HTTP_${res.status}`, res.status);
  return data.data as T;
}

/**
 * Exchange the current Firebase ID token for the httpOnly `__session`
 * cookie used by server components and API routes. Called right after any
 * successful sign-in (password, OAuth, MFA) — idempotent.
 */
export async function mintSessionCookie(): Promise<void> {
  const user = fbAuth().currentUser;
  if (!user) return;
  const idToken = await user.getIdToken();
  const res = await fetch("/api/auth/session", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken }),
    credentials: "same-origin",
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new RpcCallError(data.error ?? "SESSION_MINT_FAILED", res.status);
  }
}

/** Sign out everywhere: clear the cookie + Firebase client state. */
export async function signOutEverywhere(): Promise<void> {
  await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  const { signOut } = await import("firebase/auth");
  await signOut(fbAuth()).catch(() => {});
}

/**
 * Upload an image to a private storage folder owned by the current user.
 * Returns the storage path (`{uid}/{filename}`) to send to the server.
 */
export async function uploadOwnedFile(folder: "security-screenshots" | "identity-documents", file: File | Blob, filename?: string): Promise<string> {
  const user = fbAuth().currentUser;
  if (!user) throw new RpcCallError("UNAUTHENTICATED", 401);
  const safeName = (filename ?? (file instanceof File ? file.name : `upload-${Date.now()}`))
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-80);
  const path = `${user.uid}/${Date.now()}-${safeName}`;
  const storageRef = ref(fbStorage(), `${folder}/${path}`);
  await uploadBytes(storageRef, file, {
    contentType: file instanceof File ? file.type : "application/octet-stream",
    cacheControl: "private, max-age=0",
  });
  return path;
}
