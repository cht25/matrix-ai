"use client";

import { useRouter } from "next/navigation";
import { rpc } from "@/lib/client/api";
import { Button } from "@/components/ui";

export function RevokeSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  async function revoke() {
    if (!confirm("Revoke this session? The device will be signed out.")) return;
    await rpc("revoke_session", { session_id: sessionId }).catch(() => {});
    router.refresh();
  }
  return <Button variant="outline" onClick={() => void revoke()} className="!px-3 !py-1.5 text-xs">Revoke</Button>;
}
