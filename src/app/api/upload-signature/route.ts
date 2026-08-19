// POST /api/upload-signature { kind: "screenshot" | "identity" }
//
// Returns a short-lived, server-signed upload grant for Cloudinary. The
// signature binds folder + exact public_id + timestamp (+ private delivery
// type), so a signed-in browser can upload exactly one private image into its
// own folder and nothing else. The actual file goes browser → Cloudinary
// directly; it never passes through our server.

import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/firebase/session";
import { isCloudinaryConfigured } from "@/lib/env";
import { createUploadSignature, type UploadFolder } from "@/lib/server/cloudinary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const user = await getSessionUser();
  if (!user) return NextResponse.json({ error: "UNAUTHENTICATED" }, { status: 401 });
  if (!isCloudinaryConfigured()) return NextResponse.json({ error: "UPLOADS_NOT_CONFIGURED" }, { status: 503 });

  const body = (await req.json().catch(() => ({}))) as { kind?: string; filename?: string };
  const kind = body.kind === "identity" ? "identity-documents" : body.kind === "screenshot" ? "security-screenshots" : null;
  if (!kind) return NextResponse.json({ error: "KIND_INVALID" }, { status: 400 });

  const signature = createUploadSignature(user.uid, kind as UploadFolder, typeof body.filename === "string" ? body.filename : "");
  if (!signature) return NextResponse.json({ error: "UPLOADS_NOT_CONFIGURED" }, { status: 503 });
  return NextResponse.json(signature);
}
