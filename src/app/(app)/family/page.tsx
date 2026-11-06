import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { FamilyClient } from "@/components/family/family-client";

export const metadata: Metadata = { title: "Family" };
export const dynamic = "force-dynamic";

export default async function FamilyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <FamilyClient />;
}
