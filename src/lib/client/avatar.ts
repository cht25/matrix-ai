"use client";

import { rpc, uploadOwnedFile } from "@/lib/client/api";

const ALLOWED = ["image/png", "image/jpeg", "image/jpg", "image/webp"];
const MAX_BYTES = 8 * 1024 * 1024;

export function isAllowedAvatarFile(file: File): { ok: true } | { ok: false; reason: string } {
  if (!ALLOWED.includes(file.type)) return { ok: false, reason: "Use a PNG, JPEG, or WebP image." };
  if (file.size <= 0 || file.size > MAX_BYTES) return { ok: false, reason: "Choose an image smaller than 8 MB." };
  return { ok: true };
}

/** Square-crop and compress a device photo so it can be stored even without Cloudinary. */
export function compressAvatarFile(file: File, size = 256, quality = 0.82): Promise<string> {
  return new Promise((resolve, reject) => {
    const check = isAllowedAvatarFile(file);
    if (!check.ok) {
      reject(new Error(check.reason));
      return;
    }
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const ctx = canvas.getContext("2d");
      if (!ctx) {
        reject(new Error("Could not process that image."));
        return;
      }
      const side = Math.min(img.width, img.height) || size;
      const sx = (img.width - side) / 2;
      const sy = (img.height - side) / 2;
      ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
      resolve(canvas.toDataURL("image/jpeg", quality));
    };
    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error("That image could not be read. Try another file."));
    };
    img.src = objectUrl;
  });
}

/** Prefer a hosted Cloudinary URL; fall back to a compressed data URL. */
export async function saveProfileAvatar(file: File): Promise<string> {
  const preview = await compressAvatarFile(file);
  try {
    const hosted = await uploadOwnedFile("avatars", file, file.name);
    if (hosted.startsWith("https://")) {
      await rpc("profile_update", { avatar_url: hosted });
      return hosted;
    }
  } catch {
    /* Cloudinary may be unconfigured — store the compressed image instead. */
  }
  await rpc("profile_update", { avatar_url: preview });
  return preview;
}

export async function clearProfileAvatar(): Promise<void> {
  await rpc("profile_update", { avatar_url: "" });
}
