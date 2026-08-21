// Server-only Cloudinary access (free tier replaces Firebase Storage).
//
// Privacy model (matches the old private buckets):
//   • uploads are SIGNED by this server (/api/upload-signature) — the
//     signature binds the folder (`security-screenshots/{uid}` /
//     `identity-documents/{uid}`) AND the exact public_id, so a signed browser
//     session can upload nothing outside its own folder;
//   • assets are stored with delivery type "authenticated" — they are NOT
//     publicly reachable; bytes can only be fetched via a URL signed with the
//     API secret (server-side only);
//   • account deletion wipes the user's Cloudinary folders.

import "server-only";
import crypto from "node:crypto";
import { v2 as cloudinary } from "cloudinary";
import { env, isCloudinaryConfigured } from "@/lib/env";

export const UPLOAD_FOLDERS = ["security-screenshots", "identity-documents", "avatars"] as const;
export type UploadFolder = (typeof UPLOAD_FOLDERS)[number];

function sdk() {
  if (!isCloudinaryConfigured()) return null;
  cloudinary.config({
    cloud_name: env.cloudinary.cloudName,
    api_key: env.cloudinary.apiKey,
    api_secret: env.cloudinary.apiSecret,
    secure: true,
  });
  return cloudinary;
}

export type UploadSignature = {
  uploadUrl: string;
  cloudName: string;
  apiKey: string;
  timestamp: number;
  folder: string;
  publicId: string;
  signature: string;
  deliveryType: "authenticated" | "upload";
};

/**
 * Create a server-signed upload grant for one exact asset in the user's own
 * folder. `kind` maps to the folder; the public_id is generated here so the
 * browser cannot choose it.
 */
export function createUploadSignature(uid: string, kind: UploadFolder, filename: string): UploadSignature | null {
  const c = sdk();
  if (!c) return null;
  const safeName = (filename || "upload").replace(/[^a-zA-Z0-9._-]/g, "_").slice(-60).replace(/\.[a-z0-9]+$/i, "");
  const folder = `${kind}/${uid}`;
  const publicId = `${Date.now()}-${safeName || "image"}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryType: UploadSignature["deliveryType"] = kind === "avatars" ? "upload" : "authenticated";
  const toSign: Record<string, string | number> = { folder, public_id: publicId, timestamp };
  if (deliveryType === "authenticated") toSign.type = "authenticated";
  const signature = c.utils.api_sign_request(toSign, env.cloudinary.apiSecret);
  return {
    uploadUrl: `https://api.cloudinary.com/v1_1/${env.cloudinary.cloudName}/image/upload`,
    cloudName: env.cloudinary.cloudName,
    apiKey: env.cloudinary.apiKey,
    timestamp,
    folder,
    publicId,
    signature,
    deliveryType,
  };
}

/**
 * Download the bytes of a private (authenticated) image. `storagePath` is the
 * public_id including extension (e.g. `security-screenshots/{uid}/{id}.jpg`).
 */
export async function downloadImage(storagePath: string): Promise<Buffer | null> {
  const c = sdk();
  if (!c) return null;
  const dot = storagePath.lastIndexOf(".");
  if (dot === -1) return null;
  const publicId = storagePath.slice(0, dot);
  const format = storagePath.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{2,5}$/.test(format)) return null;
  const url = c.url(publicId, {
    type: "authenticated",
    sign_url: true,
    resource_type: "image",
    format,
  });
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return null;
    return Buffer.from(await res.arrayBuffer());
  } catch {
    return null;
  }
}

/** Delete every asset under a user's folders (account deletion). */
export async function deleteUserAssets(uid: string): Promise<void> {
  const c = sdk();
  if (!c) return;
  for (const folder of UPLOAD_FOLDERS) {
    await c.api
      .delete_resources_by_prefix(`${folder}/${uid}/`, { resource_type: "image", type: "authenticated" })
      .catch(() => {});
  }
}

/** Live reachability check (used by /api/health). */
export async function ping(): Promise<boolean> {
  const c = sdk();
  if (!c) return false;
  try {
    const res = await c.api.ping({ timeout: 5000 } as never);
    return res?.status === "ok";
  } catch {
    try {
      // Fallback for SDK versions without ping timeout support.
      const res = await c.api.ping();
      return res?.status === "ok";
    } catch {
      return false;
    }
  }
}

export function randomId(): string {
  return crypto.randomBytes(8).toString("hex");
}
