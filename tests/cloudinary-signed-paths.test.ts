import { afterEach, describe, expect, it, vi } from "vitest";
import { createUploadSignature } from "@/lib/server/cloudinary";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Cloudinary signed paths", () => {
  it("signs Cloudinary grants with folder-prefixed dot-free publicId across screenshots and mirror-frames", () => {
    vi.stubEnv("CLOUDINARY_CLOUD_NAME", "demo-cloud");
    vi.stubEnv("CLOUDINARY_API_KEY", "123456789");
    vi.stubEnv("CLOUDINARY_API_SECRET", "super-secret-cloudinary-key");

    const shot = createUploadSignature("userABC", "security-screenshots", "My Screenshot.2026.png")!;
    expect(shot).not.toBeNull();
    expect(shot.publicId.startsWith("security-screenshots/userABC/")).toBe(true);
    expect(shot.publicId.includes(".")).toBe(false);
    expect(shot.deliveryType).toBe("authenticated");

    const mirror = createUploadSignature("childXYZ", "mirror-frames", "frame.jpg")!;
    expect(mirror).not.toBeNull();
    expect(mirror.publicId.startsWith("mirror-frames/childXYZ/")).toBe(true);
    expect(mirror.deliveryType).toBe("authenticated");
  });
});
