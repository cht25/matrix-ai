"use client";

// Client-side helpers for the Firebase + Cloudinary-backed QORVYNA backend.
// All mutations go through /api/rpc (server-verified, audited). Image uploads
// go DIRECTLY to Cloudinary using a server-signed grant (folder + public_id +
// timestamp are baked into the signature), and are stored as private
// ("authenticated") assets — mirroring the old private-bucket model.

import type { User } from "firebase/auth";
import { fbAuth } from "@/lib/firebase/client";

export class RpcCallError extends Error {
  /**
   * `detail` is the server's human-readable explanation (e.g. which origins a
   * deployment accepts). It is appended to the message so callers that render
   * `error.message` see it, while `code` stays machine-comparable.
   */
  constructor(
    readonly code: string,
    readonly status: number,
    readonly detail?: string,
    readonly requestId?: string,
  ) {
    super(detail && detail !== code ? `${code}: ${detail}` : code);
    this.name = "RpcCallError";
  }
}

/**
 * Optional Firebase ID token bearer header for backend endpoints (/api/ai,
 * /api/build, /api/rpc). Never throws if Firebase is unconfigured or signed
 * out — cookie auth remains active as primary on SSR/browser requests.
 */
export async function optionalAuthHeaders(forceRefresh = false): Promise<Record<string, string>> {
  try {
    const auth = fbAuth();
    let user = auth?.currentUser ?? null;
    if (!user && typeof (auth as { authStateReady?: () => Promise<void> } | null)?.authStateReady === "function") {
      await Promise.race([
        (auth as { authStateReady: () => Promise<void> }).authStateReady(),
        new Promise<void>((resolve) => setTimeout(resolve, 1500)),
      ]);
      user = auth.currentUser ?? null;
    }
    if (!user) return {};
    const idToken = await user.getIdToken(forceRefresh);
    return idToken ? { Authorization: `Bearer ${idToken}` } : {};
  } catch {
    return {};
  }
}

/** POST /api/rpc — same-origin, authenticated by the __session cookie (+ optional ID token). */
export async function rpc<T = unknown>(action: string, args: Record<string, unknown> = {}): Promise<T> {
  const doFetch = async (forceRefresh = false) =>
    fetch("/api/rpc", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(await optionalAuthHeaders(forceRefresh)) },
      body: JSON.stringify({ action, ...args }),
      credentials: "same-origin",
    });

  let res = await doFetch(false);
  if (res.status === 401) {
    let hasUser = false;
    try {
      hasUser = Boolean(fbAuth()?.currentUser);
    } catch {
      hasUser = false;
    }
    if (hasUser) {
      await mintSessionCookie(undefined, { forceRefresh: true }).catch(() => {});
      res = await doFetch(true);
    }
  }
  // Standard envelope: { success, data } / { success:false, error:{ code, message } }.
  // The legacy top-level string `error` is still tolerated.
  const data = (await res.json().catch(() => ({}))) as {
    success?: boolean;
    data?: T;
    request_id?: string;
    error?: string | { code?: string; message?: string; detail?: string; request_id?: string };
  };
  const headerRequestId = typeof res.headers?.get === "function" ? res.headers.get("x-qorvyna-request-id") ?? undefined : undefined;
  if (!res.ok || data.success === false) {
    const code =
      typeof data.error === "string"
        ? data.error
        : data.error?.code ?? `HTTP_${res.status}`;
    const detail =
      typeof data.error === "object" && data.error !== null
        ? data.error.detail ?? (data.error.message !== code ? data.error.message : undefined)
        : undefined;
    const requestId =
      data.request_id ??
      (typeof data.error === "object" && data.error !== null ? data.error.request_id : undefined) ??
      headerRequestId;
    throw new RpcCallError(code, res.status, detail, requestId);
  }
  return data.data as T;
}

/**
 * Exchange the current Firebase ID token for the httpOnly `__session`
 * cookie used by server components and API routes. Called right after any
 * successful sign-in (password, OAuth, MFA) — idempotent.
 */
export type SessionProfileSummary = {
  uid: string;
  email: string | null;
  full_name: string;
  avatar_url: string;
};

export type SessionMint = {
  ok: true;
  uid: string;
  onboarding_complete: boolean;
  profile_loaded?: boolean;
  profile?: SessionProfileSummary | null;
};

export async function mintSessionCookie(
  userOverride?: User | null,
  options: { forceRefresh?: boolean } = {},
): Promise<SessionMint> {
  const auth = fbAuth();
  let user = userOverride ?? auth.currentUser;
  if (!user && typeof (auth as { authStateReady?: () => Promise<void> } | null)?.authStateReady === "function") {
    await Promise.race([
      (auth as { authStateReady: () => Promise<void> }).authStateReady(),
      new Promise<void>((resolve) => setTimeout(resolve, 2000)),
    ]).catch(() => {});
    user = auth.currentUser;
  }
  if (!user) throw new RpcCallError("UNAUTHENTICATED", 401);

  const postToken = async (idToken: string) =>
    fetch("/api/auth/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
      credentials: "same-origin",
    });

  let idToken = await user.getIdToken(options.forceRefresh === true);
  let res = await postToken(idToken);
  if (res.status === 401 && options.forceRefresh !== true) {
    // Cached token may have been stale/revoked — refresh once before failing.
    idToken = await user.getIdToken(true);
    res = await postToken(idToken);
  }

  const data = (await res.json().catch(() => ({}))) as {
    error?: string | { code?: string; message?: string };
    uid?: string;
    onboarding_complete?: boolean;
    profile_loaded?: boolean;
    profile_error?: string;
    profile?: SessionProfileSummary | null;
  };
  if (!res.ok) {
    // The session route answers with the standard { error: { code, message } }
    // envelope; read both shapes so a rejected Origin keeps its real code
    // instead of degrading into SESSION_MINT_FAILED.
    const code =
      typeof data.error === "string"
        ? data.error
        : data.error?.code ?? (res.status === 403 ? "BAD_ORIGIN" : "SESSION_MINT_FAILED");
    const detail = typeof data.error === "object" ? data.error?.message : undefined;
    throw new RpcCallError(code, res.status, detail);
  }
  if (data.profile_loaded === false) {
    throw new RpcCallError(
      data.profile_error ?? "PROFILE_LOAD_FAILED",
      500,
      "Signed in with your account, but your user profile could not be loaded.",
    );
  }
  return {
    ok: true,
    uid: data.uid ?? user.uid,
    onboarding_complete: data.onboarding_complete === true,
    profile_loaded: true,
    profile: data.profile ?? null,
  };
}

/** Sign out everywhere: clear the cookie + Firebase client state + lifecycle/loop markers. */
export async function signOutEverywhere(): Promise<void> {
  await fetch("/api/auth/session", { method: "DELETE", credentials: "same-origin" }).catch(() => {});
  const { signOut } = await import("firebase/auth");
  await signOut(fbAuth()).catch(() => {});
  try {
    const { clearOAuthFlowMarkers } = await import("@/lib/auth/oauth");
    clearOAuthFlowMarkers();
  } catch {
    /* ignore in tests */
  }
  try {
    const { resetAuthLifecycleOnSignOut } = await import("@/lib/auth/lifecycle");
    resetAuthLifecycleOnSignOut();
  } catch {
    /* ignore in tests */
  }
}

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

/**
 * Upload an image to the user's private Cloudinary folder.
 * Returns the storage path (`{folder}/{uid}/{public_id}.{ext}`) to send to
 * the server — the same contract the Supabase/Firebase-Storage versions used.
 */
export async function uploadOwnedFile(
  folder: "security-screenshots" | "identity-documents" | "avatars" | "mirror-frames",
  file: File | Blob,
  filename?: string,
): Promise<string> {
  const user = fbAuth().currentUser;
  if (!user) throw new RpcCallError("UNAUTHENTICATED", 401);

  // Client-side gate (same limits the old storage rules enforced). The server
  // re-validates magic bytes when it analyses the file.
  if (file.size <= 0 || file.size > MAX_IMAGE_BYTES) throw new RpcCallError("FILE_TOO_LARGE", 400);
  const mime = file instanceof File ? file.type : (file.type || "");
  if (mime && !ALLOWED_IMAGE_TYPES.includes(mime)) throw new RpcCallError("UNSUPPORTED_TYPE", 400);

  const name = filename ?? (file instanceof File ? file.name : `upload-${Date.now()}`);
  const kind =
    folder === "identity-documents" ? "identity" :
    folder === "avatars" ? "avatar" :
    folder === "mirror-frames" ? "mirror" :
    "screenshot";
  const grantRes = await fetch("/api/upload-signature", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ kind, filename: name }),
  });
  const grant = (await grantRes.json().catch(() => ({}))) as {
    uploadUrl: string;
    apiKey: string;
    timestamp: number;
    folder: string;
    publicId: string;
    signature: string;
    deliveryType?: "authenticated" | "upload";
    error?: string;
  };
  if (!grantRes.ok || !grant.signature) throw new RpcCallError(grant.error ?? "SIGNATURE_FAILED", grantRes.status);

  const form = new FormData();
  form.append("file", file);
  form.append("api_key", grant.apiKey);
  form.append("timestamp", String(grant.timestamp));
  form.append("public_id", grant.publicId);
  form.append("signature", grant.signature);
  if (grant.deliveryType !== "upload") form.append("type", "authenticated");

  const upload = await fetch(grant.uploadUrl, { method: "POST", body: form });
  const uploaded = (await upload.json().catch(() => ({}))) as {
    public_id?: string;
    format?: string;
    secure_url?: string;
    error?: { message?: string };
  };
  if (!upload.ok || !uploaded.public_id) {
    throw new RpcCallError("UPLOAD_FAILED", upload.status);
  }
  if (folder === "avatars" && uploaded.secure_url) return uploaded.secure_url;
  const resolvedId = uploaded.public_id.startsWith(`${grant.folder}/`)
    ? uploaded.public_id
    : `${grant.folder}/${uploaded.public_id}`;
  const ext = (uploaded.format || (mime === "image/png" ? "png" : mime === "image/webp" ? "webp" : "jpg")).toLowerCase();
  return `${resolvedId}.${ext}`;
}
