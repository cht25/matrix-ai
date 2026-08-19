// GET /api/health — honest, machine-readable service health for operators and
// uptime checks. No secrets are returned; every probe is a live network call.
//
//   200 { ok: true,  firebase: "reachable", webConfig: "valid", cloudinary: "reachable", ai: "online"|"unavailable"|"unknown", checkedAt }
//   503 { ok: false, firebase: "not-configured"|"unreachable", webConfig: "invalid-key"|"project-mismatch"|…, … }
//
// `webConfig` independently probes the public web API key against Identity
// Toolkit, so a bad NEXT_PUBLIC_FIREBASE_API_KEY (the classic Render
// misconfiguration) is reported even when the Admin SDK is also unset.

import { NextResponse } from "next/server";
import { isConfigured, isAiConfigured, isCloudinaryConfigured } from "@/lib/env";
import { adminConfigured } from "@/lib/firebase/admin";
import { createProvider } from "@/lib/ai/groq";
import { ping as pingCloudinary } from "@/lib/server/cloudinary";
import { checkWebFirebaseConfig } from "@/lib/server/identitytoolkit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const checkedAt = new Date().toISOString();

  const webConfig = await checkWebFirebaseConfig();
  const webConfigFields = {
    webConfig: webConfig.status,
    ...(webConfig.reportedProjectId ? { webConfigProject: webConfig.reportedProjectId } : {}),
  };

  if (!isConfigured() || !adminConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        firebase: "not-configured",
        ...webConfigFields,
        cloudinary: isCloudinaryConfigured() ? "unknown" : "not-configured",
        ai: isAiConfigured() ? "unknown" : "not-configured",
        checkedAt,
      },
      { status: 503 },
    );
  }

  let firebase: "reachable" | "unreachable" = "unreachable";
  try {
    const { adminDb } = await import("@/lib/firebase/admin");
    // Minimal live read (also proves the service account works).
    await adminDb().collection("countries").limit(1).get();
    firebase = "reachable";
  } catch {
    firebase = "unreachable";
  }

  let cloudinary: "reachable" | "unreachable" | "unknown" = "unknown";
  if (isCloudinaryConfigured()) {
    cloudinary = (await pingCloudinary()) ? "reachable" : "unreachable";
  }

  let ai: "online" | "unavailable" | "unknown" = "unknown";
  if (isAiConfigured()) {
    const provider = createProvider();
    ai = provider && (await provider.healthCheck()) ? "online" : "unavailable";
  }

  const ok = firebase === "reachable";
  return NextResponse.json({ ok, firebase, cloudinary, ai, checkedAt }, { status: ok ? 200 : 503 });
}
