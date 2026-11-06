import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { DesignStudioClient } from "@/components/design/design-studio-client";

export const metadata: Metadata = { title: "Design Studio" };
export const dynamic = "force-dynamic";

export default async function DesignPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <DesignStudioClient />;
}
