import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { isAdmin } from "@/lib/server/rpc";
import { Card } from "@/components/ui";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const pathname = (await headers()).get("x-matrix-pathname") ?? "";
  // Bootstrap must stay reachable before any admin exists.
  if (pathname === "/admin/setup" || pathname.startsWith("/admin/setup/")) {
    return children;
  }

  const user = await getCurrentUser();
  if (!user) redirect("/login");

  try {
    const existing = await db().collection("admin_role_assignments").limit(1).get();
    if (existing.empty) return children;
  } catch {
    /* fall through to the access check */
  }

  let allowed = false;
  try {
    allowed = await isAdmin(db(), user.uid);
  } catch (err) {
    console.error("[MATRIX] Admin access check failed.", err);
    return (
      <Card className="space-y-3">
        <h1 className="font-display text-xl font-semibold text-ink">Admin panel could not load</h1>
        <p className="text-sm leading-relaxed text-ink-2">
          The permission check against Firestore failed. This is a server problem, not a missing page.
          Retry in a moment, or confirm the database is reachable.
        </p>
        <Link href="/chat" className="inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline">
          Back to chat
        </Link>
      </Card>
    );
  }

  if (!allowed) {
    return (
      <Card className="space-y-3">
        <h1 className="font-display text-xl font-semibold text-ink">Admin access required</h1>
        <p className="text-sm leading-relaxed text-ink-2">
          This account does not have an admin role in Firestore. Roles apply as soon as
          {" "}<code className="rounded bg-surface-2 px-1">admin_role_assignments</code> exists
          (via <code className="rounded bg-surface-2 px-1">npm run set-admin</code> or{" "}
          <code className="rounded bg-surface-2 px-1">/admin/setup</code>) — you do not need a special
          cookie claim to open this panel.
        </p>
        <Link href="/chat" className="inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline">
          Back to chat
        </Link>
      </Card>
    );
  }

  return children;
}
