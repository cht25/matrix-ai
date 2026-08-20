import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { isAdmin } from "@/lib/server/rpc";
import { AdminNav } from "@/components/admin/admin-nav";
import { OverviewTab } from "@/components/admin/overview-tab";
import { Card } from "@/components/ui";

export const metadata: Metadata = { title: "Admin" };

export default async function AdminPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  // If no admin has been bootstrapped yet, send the user to the one-time setup
  // page instead of silently bouncing them back to /chat.
  let noAdminYet = false;
  try {
    const existing = await db().collection("admin_role_assignments").limit(1).get();
    noAdminYet = existing.empty;
  } catch {
    /* fall through to the permission check below */
  }
  if (noAdminYet) redirect("/admin/setup");

  const codes = await getAdminPermissions(db(), user.uid);

  // The account has an admin role but no permissions attached to that role.
  // Show an explanation rather than redirecting away — a silent redirect makes
  // the panel look broken.
  if (codes.length === 0) {
    const admin = await isAdmin(db(), user.uid).catch(() => false);
    return (
      <Card className="space-y-3">
        <h1 className="font-display text-xl font-semibold text-ink">
          {admin ? "No admin permissions assigned" : "Admin access required"}
        </h1>
        <p className="text-sm leading-relaxed text-ink-2">
          {admin ? (
            <>
              Your account has an admin role, but that role currently has no permissions attached.
              Ask a <code className="rounded bg-surface-2 px-1">super_admin</code> to grant
              permissions, or run{" "}
              <code className="rounded bg-surface-2 px-1">npm run set-admin</code> to reset the role.
            </>
          ) : (
            <>
              This account does not have an admin role in Firestore. Roles apply as soon as{" "}
              <code className="rounded bg-surface-2 px-1">admin_role_assignments</code> exists (via{" "}
              <code className="rounded bg-surface-2 px-1">npm run set-admin</code> or{" "}
              <code className="rounded bg-surface-2 px-1">/admin/setup</code>).
            </>
          )}
        </p>
        <Link
          href="/chat"
          className="inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline"
        >
          Back to chat
        </Link>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-display font-semibold tracking-tight text-ink sm:text-3xl">Admin Panel</h1>
        <p className="mt-1 text-ink-2">
          Role-based access control — every section is gated by <code className="rounded bg-surface-2 px-1">has_permission()</code> in the
          database, and every sensitive action is audited.
        </p>
      </div>
      <AdminNav />
      <OverviewTab codes={codes} />
      <Card className="!p-4 text-xs text-ink-3">
        Admin privacy policy: conversations are never shown by default. Any privileged access requires a
        reason, an explicit time-limited grant, and an audit entry.
      </Card>
    </div>
  );
}
