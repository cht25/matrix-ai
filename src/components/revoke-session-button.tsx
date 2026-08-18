"use client";

import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/browser";
import { Button } from "@/components/ui";

export function RevokeSessionButton({ sessionId }: { sessionId: string }) {
  const router = useRouter();
  async function revoke() {
    if (!confirm("Revoke this session? The device will be signed out.")) return;
    const supabase = createClient();
    await supabase.rpc("revoke_session", { p_session_id: sessionId });
    router.refresh();
  }
  return <Button variant="outline" onClick={() => void revoke()} className="!px-3 !py-1.5 text-xs">Revoke</Button>;
}
