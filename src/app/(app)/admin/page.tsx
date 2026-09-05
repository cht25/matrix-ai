import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { getAdminPermissions } from "@/lib/server/queries";
import { adminRoleOf, isAdmin } from "@/lib/server/rpc";
import { AdminShell } from "@/components/admin/admin-shell";
import { OverviewTab } from "@/components/admin/overview-tab";
import { Card, EmptyState } from "@/components/ui";

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
  const role = await adminRoleOf(db(), user.uid).catch(() => null);

  if (codes.length === 0) {
    const admin = await isAdmin(db(), user.uid).catch(() => false);
    return (
      <Card>
        <EmptyState
          title={admin ? "No permissions attached to your role" : "Admin access required"}
          body={
            admin
              ? "Your account has an admin role, but that role currently grants no permissions. Ask a super administrator to review it."
              : "This account does not have an administrative role. Ask a super administrator for access."
          }
          action={
            <Link href="/chat" className="inline-flex min-h-10 items-center text-sm font-medium text-accent hover:underline">
              Back to chat
            </Link>
          }
        />
      </Card>
    );
  }

  return (
    <AdminShell
      title="Admin control centre"
      subtitle="Manage users, permissions, security and AI infrastructure."
      role={role}
      codes={codes}
    >
      <OverviewTab codes={codes} />
      <Card className="!p-4">
        <p className="text-xs leading-relaxed text-ink-3">
          Admin privacy policy: conversations are never shown by default. Any privileged access requires a
          reason, an explicit time-limited grant, and an audit entry. Every section is gated server-side by
          the caller&apos;s real permission codes — hiding UI is never the security boundary.
        </p>
      </Card>
    </AdminShell>
  );
}
