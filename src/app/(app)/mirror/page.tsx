import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/data";
import { MirrorPanel } from "@/components/devices/mirror-panel";

export const metadata: Metadata = { title: "Multi-Device Screen Mirroring" };

export default async function MirrorPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-ink sm:text-3xl">Multi-Device Screen Mirroring</h1>
        <p className="mt-1 text-ink-2">
          Consent-gated WebRTC live viewing between your paired devices. View-only by default with instant revocation.
        </p>
      </div>

      <MirrorPanel />
    </div>
  );
}
