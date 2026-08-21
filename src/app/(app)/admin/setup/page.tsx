import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { db, getCurrentUser } from "@/lib/data";
import { AdminSetupForm } from "@/components/admin/admin-setup-form";

export const metadata: Metadata = { title: "Admin setup" };

export default async function AdminSetupPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const existing = await db().collection("admin_role_assignments").limit(1).get();
  const closed = !existing.empty;
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <h1 className="font-display text-2xl font-semibold text-ink">Admin bootstrap</h1>
      <p className="text-sm leading-relaxed text-ink-2">
        One-time setup for the first super_admin. After any admin exists, this page cannot create another.
        You can also run <code className="rounded bg-surface-2 px-1">npm run set-admin you@example.com super_admin</code>.
      </p>
      {closed ? (
        <div className="space-y-3">
          <p className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-ink-2">
            An administrator already exists. Super admins can re-seed role permission links below if the panel still shows empty permissions.
          </p>
          <AdminSetupForm seedOnly />
        </div>
      ) : (
        <AdminSetupForm />
      )}
    </div>
  );
}
