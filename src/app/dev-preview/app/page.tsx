// DEV-ONLY visual preview of the signed-in application frame.
//
// Same pattern as /dev-preview/admin and /dev-preview/chat: the REAL shell
// (sidebar, top bar, mobile navigation) and the REAL security-overview layout,
// rendered against sample data, plus the shared UI primitives in one place.
// It exists so layout, type scale and both themes can be reviewed at any
// viewport without Firebase credentials. Returns 404 in production and is
// never linked from the application.

import { notFound } from "next/navigation";
import { AppPreview } from "./preview-client";

export const dynamic = "force-dynamic";

export default function DevPreviewAppPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AppPreview />;
}
