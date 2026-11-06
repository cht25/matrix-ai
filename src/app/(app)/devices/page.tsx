import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { DevicesClient } from "@/components/devices/devices-client";

export const metadata: Metadata = { title: "Connected Devices" };
export const dynamic = "force-dynamic";

export default async function DevicesPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  return <DevicesClient />;
}
