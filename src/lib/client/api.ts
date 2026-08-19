"use client";

// Client-side helpers for the Firebase + Cloudinary-backed MATRIX backend.
// All mutations go through /api/rpc (server-verified, audited). Image uploads
// go DIRECTLY to Cloudinary using a server-signed grant (folder + public_id +
// timestamp are baked into the signature), and are stored as private
// ("authenticated") assets — mirroring the old private-bucket model.

import { fbAuth } from "@/lib/firebase/client";

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
  if (!user) throw new RpcCallError("UNAUTHENTICATED", 401);
  // Force-refresh so the server never sees a stale token after OAuth.
  const idToken = await user.getIdToken(true);
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

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Upload an image to the user's private Cloudinary folder.
 * Returns the storage path (`{folder}/{uid}/{public_id}.{ext}`) to send to
 * the server — the same contract the Supabase/Firebase-Storage versions used.
 */
export async function uploadOwnedFile(
  folder: "security-screenshots" | "identity-documents",
  file: File | Blob,
  filename?: string,
): Promise<string> {
  const user = fbAuth().currentUser;
  if (!user) throw new RpcCallError("UNAUTHENTICATED", 401);

  // Client-side gate (same limits the old storage rules enforced). The server
  // re-validates magic bytes when it analyses the file.
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new RpcCallError("FILE_TOO_LARGE", 400);
  const mime = file instanceof File ? file.type : "";
  if (mime && !ALLOWED_IMAGE_TYPES.includes(mime)) throw new RpcCallError("UNSUPPORTED_TYPE", 400);

  const name = filename ?? (file instanceof File ? file.name : `upload-${Date.now()}`);
  const grantRes = await fetch("/api/upload-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ kind: folder === "identity-documents" ? "identity" : "screenshot", filename: name }),
  });
  const grant = (await grantRes.json().catch(() => ({}))) as {
    uploadUrl: string;
    apiKey: string;
    timestamp: number;
    folder: string;
    publicId: string;
    signature: string;
    error?: string;
  };
  if (!grantRes.ok || !grant.signature) throw new RpcCallError(grant.error ?? "SIGNATURE_FAILED", grantRes.status);

  const form = new FormData();
  form.append("file", file);
  form.append("api_key", grant.apiKey);
  form.append("timestamp", String(grant.timestamp));
  form.append("folder", grant.folder);
  form.append("public_id", grant.publicId);
  form.append("signature", grant.signature);
  form.append("type", "authenticated");

  const upload = await fetch(grant.uploadUrl, { method: "POST", body: form });
  const uploaded = (await upload.json().catch(() => ({}))) as { public_id?: string; format?: string; error?: { message?: string } };
  if (!upload.ok || !uploaded.public_id) {
    throw new RpcCallError("UPLOAD_FAILED", upload.status);
  }
  // Storage path contract: folder-prefixed public_id + extension.
  return `${uploaded.public_id}.${uploaded.format ?? "jpg"}`;
}
