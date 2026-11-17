import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { NotificationsCenter } from "@/components/notifications/notifications-center";

export const metadata: Metadata = { title: "Notifications & Parent Safety" };

export default async function NotificationsPage({
  searchParams,
}: {
  searchParams: Promise<{ verify_parent?: string }>;
}) {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  const { verify_parent = "" } = await searchParams;

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Notifications &amp; Parent Safety</h1>
        <p className="mt-1 text-ink-2">
          Manage cross-device notification sync, privacy masking, excluded apps and verified parent safety policies.
        </p>
      </div>

      <NotificationsCenter initialVerifyToken={verify_parent} />
    </div>
  );
}
