import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { CompareClient } from "@/components/compare-client";

export const metadata: Metadata = { title: "Compare response styles" };
export const dynamic = "force-dynamic";

export default async function ComparePage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <CompareClient />;
}
