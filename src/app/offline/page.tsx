import type { Metadata } from "next";
import { OfflineScreen } from "@/components/offline-screen";

export const metadata: Metadata = {
  title: "Offline",
  description: "QORVYNA offline recovery & cached workspace",
};

export default function OfflinePage() {
  return <OfflineScreen />;
}
