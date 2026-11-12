// Server-only Cloudinary access (free tier replaces Firebase Storage).
//
// Privacy model (matches the old private buckets):
//   • uploads are SIGNED by this server (/api/upload-signature) — the
//     signature binds the exact folder-prefixed public_id (`security-screenshots/{uid}/{id}` /
//     `identity-documents/{uid}/{id}` / `mirror-frames/{uid}/{id}`), so a signed
//     browser session can upload nothing outside its own folder, and works
//     identically on both Fixed-Folder and Dynamic-Folder Cloudinary accounts;
//   • private assets are stored with delivery type "authenticated" — they are NOT
//     publicly reachable; bytes can only be fetched via a URL signed with the
//     API secret (server-side only);
//   • account deletion wipes the user's Cloudinary folders.

import "server-only";
import crypto from "node:crypto";
import { Readable } from "node:stream";
import { v2 as cloudinary } from "cloudinary";
import { env, isCloudinaryConfigured } from "@/lib/env";

export const UPLOAD_FOLDERS = ["security-screenshots", "identity-documents", "avatars", "mirror-frames"] as const;
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

function sanitizeBaseName(filename: string): string {
  // Strip file extension AND any remaining dots so Cloudinary never mistakes a
  // timestamp/decimal inside the filename for a format extension.
  return (filename || "upload")
    .replace(/\.[a-z0-9]+$/i, "")
    .replace(/[^a-zA-Z0-9_-]/g, "_")
    .slice(-48) || "image";
}

/**
 * Create a server-signed upload grant for one exact asset in the user's own
 * folder. Embedding `${kind}/${uid}/...` directly in `public_id` (rather than
 * relying on the legacy `folder` parameter) guarantees `uploaded.public_id`
 * always carries the ownership prefix on both Fixed-Folder and Dynamic-Folder
 * Cloudinary accounts.
 */
export function createUploadSignature(uid: string, kind: UploadFolder, filename: string): UploadSignature | null {
  const c = sdk();
  if (!c) return null;
  const safeName = sanitizeBaseName(filename);
  const folder = `${kind}/${uid}`;
  const publicId = `${folder}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const deliveryType: UploadSignature["deliveryType"] = kind === "avatars" ? "upload" : "authenticated";
  const toSign: Record<string, string | number> = { public_id: publicId, timestamp };
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

/** Server-side private image upload (used for companion/mirror display frames). */
export async function uploadPrivateImageBuffer(
  kind: Exclude<UploadFolder, "avatars">,
  uid: string,
  bytes: Buffer,
  filename = "frame.jpg",
): Promise<string> {
  const c = sdk();
  if (!c) throw new Error("UPLOADS_NOT_CONFIGURED");
  const safeName = sanitizeBaseName(filename);
  const publicId = `${kind}/${uid}/${Date.now()}-${crypto.randomBytes(4).toString("hex")}-${safeName}`;
  return new Promise((resolve, reject) => {
    const upload = c.uploader.upload_stream(
      {
        resource_type: "image",
        type: "authenticated",
        public_id: publicId,
        overwrite: false,
        unique_filename: false,
        use_filename: false,
      },
      (error, result) => {
        if (error || !result?.public_id) {
          reject(new Error(error?.message ?? "CLOUDINARY_IMAGE_UPLOAD_FAILED"));
          return;
        }
        resolve(`${result.public_id}.${String(result.format || "jpg").toLowerCase()}`);
      },
    );
    Readable.from(bytes).pipe(upload);
  });
}

export type PrivateAudioUpload = {
  publicId: string;
  version: number;
  format: string;
  bytes: number;
};

/** Upload user speech as an authenticated Cloudinary video-resource asset. */
export async function uploadPrivateAudio(uid: string, bytes: Buffer, filename: string): Promise<PrivateAudioUpload> {
  const c = sdk();
  if (!c) throw new Error("UPLOADS_NOT_CONFIGURED");
  const safeName = sanitizeBaseName(filename) || "voice";
  const publicId = `chat-audio/${uid}/${Date.now()}-${crypto.randomUUID()}-${safeName}`;
  return new Promise((resolve, reject) => {
    const upload = c.uploader.upload_stream({
      resource_type: "video",
      type: "authenticated",
      public_id: publicId,
      overwrite: false,
      unique_filename: false,
      use_filename: false,
    }, (error, result) => {
      if (error || !result) {
        reject(new Error(error?.message ?? "CLOUDINARY_AUDIO_UPLOAD_FAILED"));
        return;
      }
      resolve({
        publicId: result.public_id,
        version: Number(result.version ?? 0),
        format: String(result.format ?? ""),
        bytes: Number(result.bytes ?? bytes.length),
      });
    });
    Readable.from(bytes).pipe(upload);
  });
}

/** Fetch private speech bytes only from an owner-checked server route. */
export async function downloadPrivateAudio(publicId: string, format: string): Promise<{ bytes: Buffer; contentType: string } | null> {
  const c = sdk();
  if (!c || !/^[a-z0-9]{2,8}$/.test(format)) return null;
  const signedDownload = c.utils.private_download_url(publicId, format.toLowerCase(), {
    resource_type: "video",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  const cdnSigned = c.url(publicId, { type: "authenticated", resource_type: "video", sign_url: true, secure: true, format });
  for (const candidate of [signedDownload, cdnSigned]) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(20_000), cache: "no-store" });
      if (!response.ok) continue;
      return {
        bytes: Buffer.from(await response.arrayBuffer()),
        contentType: response.headers.get("content-type") || `audio/${format.toLowerCase()}`,
      };
    } catch {
      /* try fallback */
    }
  }
  return null;
}

export async function deletePrivateAudio(publicId: string): Promise<boolean> {
  const c = sdk();
  if (!c) return false;
  try {
    const result = await c.uploader.destroy(publicId, { resource_type: "video", type: "authenticated", invalidate: true });
    return result.result === "ok" || result.result === "not found";
  } catch {
    return false;
  }
}

export async function deleteUserChatAudio(uid: string): Promise<void> {
  const c = sdk();
  if (!c) return;
  await c.api.delete_resources_by_prefix(`chat-audio/${uid}/`, { resource_type: "video", type: "authenticated" }).catch(() => {});
}

/**
 * Download the bytes of a private (authenticated) image. `storagePath` is the
 * public_id including extension (e.g. `security-screenshots/{uid}/{id}.jpg`).
 * Uses Cloudinary's signed private_download_url API first (immune to CDN
 * version/strict-transformation mismatches) and falls back to signed CDN URL.
 */
export async function downloadImage(storagePath: string): Promise<Buffer | null> {
  const c = sdk();
  if (!c) return null;
  const dot = storagePath.lastIndexOf(".");
  if (dot === -1) return null;
  const publicId = storagePath.slice(0, dot);
  const format = storagePath.slice(dot + 1).toLowerCase();
  if (!/^[a-z0-9]{2,5}$/.test(format)) return null;

  const apiDownloadUrl = c.utils.private_download_url(publicId, format, {
    resource_type: "image",
    type: "authenticated",
    expires_at: Math.floor(Date.now() / 1000) + 300,
  });
  const cdnUrl = c.url(publicId, {
    type: "authenticated",
    sign_url: true,
    secure: true,
    resource_type: "image",
    format,
  });

  for (const url of [apiDownloadUrl, cdnUrl]) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15_000), cache: "no-store" });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > 0) return buf;
    } catch {
      /* try next signed delivery strategy */
    }
  }
  return null;
}

/** Delete every asset under a user's folders (account deletion). */
export async function deleteUserAssets(uid: string): Promise<void> {
  const c = sdk();
  if (!c) return;
  for (const folder of UPLOAD_FOLDERS) {
    const deliveryType = folder === "avatars" ? "upload" : "authenticated";
    await c.api
      .delete_resources_by_prefix(`${folder}/${uid}/`, { resource_type: "image", type: deliveryType })
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
      const res = await c.api.ping();
      return res?.status === "ok";
    } catch {
      return false;
    }
  }
}
