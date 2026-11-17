import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { FamilyClient } from "@/components/family/family-client";
import { GuardianInspections } from "@/components/family/guardian-inspections";

export const metadata: Metadata = { title: "Family" };
export const dynamic = "force-dynamic";

export default async function FamilyPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return (
    <div>
      <FamilyClient />
      <div className="mt-5">
        <GuardianInspections />
      </div>
    </div>
  );
}
