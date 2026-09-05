// DEV-ONLY visual preview of the redesigned admin UI.
//
// This route exists so the control-centre redesign can be reviewed without
// Firebase credentials. It renders the SAME components the real /admin pages
// use, against a local mock RPC transport. It returns 404 in production and is
// never linked from the application.

import { notFound } from "next/navigation";
import { AdminPreview } from "./preview-client";

export const dynamic = "force-dynamic";

export default function DevPreviewAdminPage() {
  if (process.env.NODE_ENV === "production") notFound();
  return <AdminPreview />;
}
