// DEV-ONLY visual preview of the context-aware chat UI.
//
// Same pattern as /dev-preview/admin: the REAL ChatClient components rendered
// against a mock /api/ai transport, so the intent-driven UX (clean chat,
// contextual export, agent activity, image generation) can be reviewed without
// Firebase credentials. Returns 404 in production and is never linked from the
// application.

import { notFound } from "next/navigation";
import { ChatPreview } from "./preview-client";

export const dynamic = "force-dynamic";

export default function DevPreviewChatPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <ChatPreview />;
}
