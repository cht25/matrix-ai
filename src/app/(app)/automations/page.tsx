import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { AutomationsClient } from "@/components/automations-client";

export const metadata: Metadata = { title: "Automations" };
export const dynamic = "force-dynamic";

export default async function AutomationsPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <AutomationsClient />;
}
